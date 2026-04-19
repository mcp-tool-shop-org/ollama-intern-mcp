/**
 * Memory embeddings — sidecar vector store for the memory index.
 *
 * House style is binary-free flat JSON (matches how corpora already store
 * vectors). At thousands-scale this costs ~3KB/record and parse time is
 * dominated by disk, not JSON — we can swap to sqlite-vec later if scale
 * changes without touching callers.
 *
 * Reconcile law: the ONLY reliable key is content_digest. Ids don't move,
 * but content_digest flips any time a record's semantic shape changes, and
 * that is when re-embedding is mandatory. A stale vector surviving a
 * content change is the classic silent-retrieval regression.
 *
 * Nomic task prefixes are non-negotiable: `search_document:` on the record
 * text, `search_query:` on the query text. Omitting them or using the same
 * prefix on both sides silently degrades recall — that's this layer's
 * number-one regression risk per the Phase 3B research.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { OllamaClient } from "../ollama.js";
import { memoryDir, type StoreOptions } from "./store.js";
import type { MemoryIndex, MemoryRecord } from "./types.js";

export const EMBEDDINGS_SCHEMA_VERSION = 1 as const;

export interface EmbeddingEntry {
  /** Matches the record's current content_digest at embed time. */
  content_digest: string;
  /**
   * Model tag requested at embed time (e.g. "nomic-embed-text"). Stored for
   * human legibility and profile debugging.
   */
  embed_model: string;
  /**
   * Model identifier as Ollama RESOLVED it at embed time (e.g.
   * "nomic-embed-text:latest"). This is what the freshness check actually
   * compares — it catches the case where Ollama silently updates a :latest
   * tag behind a stable profile name. Never trust `embed_model` alone for
   * invalidation.
   */
  embed_model_resolved: string;
  /** ISO timestamp of the embedding op. */
  embedded_at: string;
  /** Raw float vector. nomic-embed-text = 768 dim. */
  vector: number[];
}

export interface EmbeddingsStore {
  schema_version: typeof EMBEDDINGS_SCHEMA_VERSION;
  /** Tag last used for refresh. */
  embed_model: string | null;
  /** Resolved id last used for refresh — the authoritative freshness anchor. */
  embed_model_resolved: string | null;
  written_at: string;
  /** Keyed by memory record id. */
  entries: Record<string, EmbeddingEntry>;
}

export interface EmbeddingsDrift {
  added_count: number;
  updated_count: number;
  unchanged_count: number;
  removed_count: number;
  added_ids: string[];
  updated_ids: string[];
  removed_ids: string[];
  model_invalidated_count: number;
  embed_calls: number;
  elapsed_ms: number;
}

export function embeddingsPath(override?: string): string {
  return path.join(memoryDir(override), "embeddings.json");
}

const EMPTY: EmbeddingsStore = {
  schema_version: EMBEDDINGS_SCHEMA_VERSION,
  embed_model: null,
  embed_model_resolved: null,
  written_at: new Date(0).toISOString(),
  entries: {},
};

export async function loadEmbeddings(opts: StoreOptions = {}): Promise<EmbeddingsStore> {
  const file = embeddingsPath(opts.dir);
  if (!existsSync(file)) return { ...EMPTY };
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as EmbeddingsStore;
    if (!parsed || parsed.schema_version !== EMBEDDINGS_SCHEMA_VERSION) return { ...EMPTY };
    return parsed;
  } catch {
    return { ...EMPTY };
  }
}

export async function saveEmbeddings(store: EmbeddingsStore, opts: StoreOptions = {}): Promise<string> {
  const dir = memoryDir(opts.dir);
  const file = embeddingsPath(opts.dir);
  await fs.mkdir(dir, { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 0), "utf8");
  await fs.rename(tmp, file);
  return file;
}

/**
 * The exact text we embed for a record — research call:
 * `title + summary + comma-joined tags`, NEVER provenance/digest/raw.
 * Prefix with nomic's `search_document:` task tag.
 */
export function recordEmbedText(r: MemoryRecord): string {
  const tagLine = r.tags.length > 0 ? r.tags.join(", ") : "";
  return `search_document: ${r.title}\n${r.summary}${tagLine ? "\n" + tagLine : ""}`;
}

export function queryEmbedText(query: string): string {
  return `search_query: ${query}`;
}

export interface RefreshEmbeddingsOptions extends StoreOptions {
  client: OllamaClient;
  embedModel: string;
  /** Max inputs per /api/embed call. Ollama handles batches natively; 64 is a sane chunk. */
  batchSize?: number;
}

/**
 * Reconcile the embeddings store against an index: embed anything added,
 * re-embed anything whose content_digest changed, drop anything the index
 * no longer covers, and invalidate the whole store if the embed model has
 * changed since last run.
 */
export async function refreshEmbeddings(
  index: MemoryIndex,
  opts: RefreshEmbeddingsOptions,
): Promise<{ store: EmbeddingsStore; drift: EmbeddingsDrift; file?: string }> {
  const startedAt = Date.now();
  const batchSize = opts.batchSize ?? 64;
  const prior = await loadEmbeddings(opts);

  // To compare resolved ids we need a reference embed call. One probe against
  // a stable short input tells us what Ollama resolves the tag to *right now*.
  let resolvedAtStart: string | null = null;
  try {
    const probe = await opts.client.embed({ model: opts.embedModel, input: "search_document: probe" });
    resolvedAtStart = probe.model ?? null;
  } catch {
    // If the probe fails, fall back to comparing tags only — we'd rather
    // under-invalidate than fail the whole refresh on a transient glitch.
    resolvedAtStart = null;
  }

  // Two invalidation triggers, in priority order:
  //   1. Resolved id changed (Ollama silently bumped :latest, or profile
  //      swap crossed a family boundary)
  //   2. Tag changed (explicit profile change from nomic → other)
  // Either flips every vector to "re-embed".
  const resolvedChanged = !!(
    resolvedAtStart &&
    prior.embed_model_resolved !== null &&
    prior.embed_model_resolved !== resolvedAtStart
  );
  const tagChanged = prior.embed_model !== null && prior.embed_model !== opts.embedModel;
  const modelChanged = resolvedChanged || tagChanged;
  const priorEntries = modelChanged ? {} : prior.entries;
  const modelInvalidatedCount = modelChanged ? Object.keys(prior.entries).length : 0;

  const validIds = new Set(index.records.map((r) => r.id));
  const added: string[] = [];
  const updated: string[] = [];
  const unchangedIds: string[] = [];
  const removedIds: string[] = [];

  // Figure out what to embed.
  const needs: MemoryRecord[] = [];
  for (const r of index.records) {
    const existing = priorEntries[r.id];
    if (!existing) {
      needs.push(r);
      added.push(r.id);
    } else if (existing.content_digest !== r.content_digest) {
      needs.push(r);
      updated.push(r.id);
    } else {
      unchangedIds.push(r.id);
    }
  }
  for (const id of Object.keys(priorEntries)) {
    if (!validIds.has(id)) removedIds.push(id);
  }

  // Batch embed the ones that need it. Capture the resolved model id from
  // the first response — every entry this refresh writes will carry it, so
  // the next refresh can detect silent tag drift.
  const now = new Date().toISOString();
  const fresh: Record<string, EmbeddingEntry> = {};
  let embedCalls = 0;
  let resolvedDuringWrite: string | null = resolvedAtStart;
  for (let i = 0; i < needs.length; i += batchSize) {
    const batch = needs.slice(i, i + batchSize);
    const input = batch.map(recordEmbedText);
    const resp = await opts.client.embed({ model: opts.embedModel, input });
    embedCalls += 1;
    if (!resolvedDuringWrite) resolvedDuringWrite = resp.model ?? null;
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const vec = resp.embeddings[j];
      if (!vec) continue;
      fresh[r.id] = {
        content_digest: r.content_digest,
        embed_model: opts.embedModel,
        embed_model_resolved: resp.model ?? opts.embedModel,
        embedded_at: now,
        vector: vec,
      };
    }
  }

  // Merge: keep unchanged priors, overwrite with fresh, exclude removed.
  const nextEntries: Record<string, EmbeddingEntry> = {};
  for (const id of unchangedIds) nextEntries[id] = priorEntries[id];
  for (const [id, entry] of Object.entries(fresh)) nextEntries[id] = entry;

  const store: EmbeddingsStore = {
    schema_version: EMBEDDINGS_SCHEMA_VERSION,
    embed_model: opts.embedModel,
    // Prefer a resolved id — fall back to the tag if we never got one (offline,
    // probe failure, etc.). At minimum future refreshes have a reference.
    embed_model_resolved: resolvedDuringWrite ?? resolvedAtStart ?? opts.embedModel,
    written_at: now,
    entries: nextEntries,
  };
  const file = await saveEmbeddings(store, opts);

  return {
    store,
    file,
    drift: {
      added_count: added.length,
      updated_count: updated.length,
      unchanged_count: unchangedIds.length,
      removed_count: removedIds.length,
      added_ids: added,
      updated_ids: updated,
      removed_ids: removedIds,
      model_invalidated_count: modelInvalidatedCount,
      embed_calls: embedCalls,
      elapsed_ms: Date.now() - startedAt,
    },
  };
}
