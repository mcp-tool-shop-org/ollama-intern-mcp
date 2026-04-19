/**
 * Corpus refresh — reconcile the corpus (reality) against its manifest
 * (intent) and report the drift in operational terms.
 *
 * Laws:
 *
 *   Manifest is the source of truth. `paths`, `embed_model`, `chunk_*`
 *   come from the manifest; refresh doesn't accept them as input. The
 *   only argument is the corpus name.
 *
 *   Deletes are real. Any path present in the corpus but absent from
 *   the manifest has its chunks removed. Any path present in the
 *   manifest but missing from disk also has its chunks removed — and
 *   the caller gets a separate `missing` list so they can tell whether
 *   the delete was intentional (manifest edit) or a disk gap.
 *
 *   Drift is legible. Every category of change surfaces by name:
 *   added / changed / unchanged / deleted / missing, plus chunk-level
 *   counts (reused / reembedded / dropped). No generic "out of date".
 *
 *   Idempotence is sacred. A no-change refresh is a no-op: no embed
 *   calls, no disk writes, no manifest bump. `no_op: true` in the
 *   report.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { OllamaClient } from "../ollama.js";
import { InternError } from "../errors.js";
import { loadCorpus } from "./storage.js";
import { loadManifest, saveManifest } from "./manifest.js";
import { indexCorpus } from "./indexer.js";

export interface RefreshReport {
  name: string;
  embed_model: string;
  /** Paths indexed for the first time this refresh. */
  added: string[];
  /** Paths whose sha256 changed since the last index and were re-embedded. */
  changed: string[];
  /** Paths present in manifest and on disk with matching sha256 — reused. */
  unchanged: string[];
  /** Paths whose chunks left the corpus (union of manifest-removed and disk-missing). */
  deleted: string[];
  /** Subset of `deleted`: paths the manifest still declares but disk does not have. */
  missing: string[];
  /** Chunk-level counts. */
  reused_chunks: number;
  reembedded_chunks: number;
  dropped_chunks: number;
  elapsed_ms: number;
  /** True iff the refresh made no changes at all. */
  no_op: boolean;
  /**
   * Silent :latest drift: present when the resolved tag captured during this
   * refresh differs from the one stored in the manifest at refresh start.
   * Reuse chunks are from the OLD resolved model; re-index the corpus if you
   * want uniform vector space. Null or absent when no drift (or when the
   * manifest had no prior resolved tag — e.g. migrated v1 manifest or
   * no-op refresh).
   */
  embed_model_resolved_drift?: { prior: string; current: string };
}

export interface RefreshParams {
  name: string;
  /** Active embed model. Must match the manifest or refresh refuses. */
  model: string;
  client: OllamaClient;
}

interface PathClassification {
  path: string;
  klass: "added" | "changed" | "unchanged" | "missing";
  file_hash: string | null;
}

async function sha256Of(absPath: string): Promise<string> {
  const content = await readFile(absPath, "utf8");
  await stat(absPath); // fail if not a regular file / missing
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

export async function refreshCorpus(params: RefreshParams): Promise<RefreshReport> {
  const t0 = Date.now();

  const manifest = await loadManifest(params.name);
  if (!manifest) {
    throw new InternError(
      "SCHEMA_INVALID",
      `No manifest found for corpus "${params.name}".`,
      `Run ollama_corpus_index({ name: "${params.name}", paths: [...] }) first — that writes the manifest as a side effect. Once a manifest exists, refresh can reconcile intent vs reality.`,
      false,
    );
  }
  if (manifest.embed_model !== params.model) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${params.name}" declares embed model "${manifest.embed_model}", but the active embed tier is "${params.model}".`,
      `Either switch the active embed tier to match the manifest, or re-run ollama_corpus_index with the new model to rebuild the manifest.`,
      false,
    );
  }

  // Load existing corpus — out-of-date schema is treated as "no corpus";
  // the re-index step below will rewrite it cleanly under the current schema.
  let existing = null;
  try {
    existing = await loadCorpus(params.name);
  } catch (err) {
    if (err instanceof InternError && err.code === "SCHEMA_INVALID") existing = null;
    else throw err;
  }

  // Build a hash→paths lookup from the existing corpus so we can detect
  // which manifest paths are unchanged / changed / added without re-reading
  // any file more than once.
  const priorHashByPath = new Map<string, string>();
  if (existing) {
    for (const c of existing.chunks) priorHashByPath.set(c.path, c.file_hash);
  }
  const priorPaths = new Set(priorHashByPath.keys());

  // Classify every manifest path.
  const manifestAbs = manifest.paths.map((p) => resolve(p));
  const classifications: PathClassification[] = [];
  for (const absPath of manifestAbs) {
    let hash: string;
    try {
      hash = await sha256Of(absPath);
    } catch {
      classifications.push({ path: absPath, klass: "missing", file_hash: null });
      continue;
    }
    const prior = priorHashByPath.get(absPath);
    if (prior === undefined) {
      classifications.push({ path: absPath, klass: "added", file_hash: hash });
    } else if (prior === hash) {
      classifications.push({ path: absPath, klass: "unchanged", file_hash: hash });
    } else {
      classifications.push({ path: absPath, klass: "changed", file_hash: hash });
    }
  }

  // Paths that were in the corpus but not in the manifest → explicit delete.
  const manifestSet = new Set(manifestAbs);
  const explicitlyRemoved = [...priorPaths].filter((p) => !manifestSet.has(p));

  const added = classifications.filter((c) => c.klass === "added").map((c) => c.path);
  const changed = classifications.filter((c) => c.klass === "changed").map((c) => c.path);
  const unchanged = classifications.filter((c) => c.klass === "unchanged").map((c) => c.path);
  const missing = classifications.filter((c) => c.klass === "missing").map((c) => c.path);

  // Union of deletes: manifest-removed plus disk-missing. Both mean
  // "chunks for this path are no longer in the corpus after refresh".
  const deleted = [...explicitlyRemoved, ...missing].sort();

  // No-op detection. Nothing to do → don't touch anything, don't bump
  // manifest.updated_at, don't call the indexer at all.
  const noOp = added.length === 0 && changed.length === 0 && deleted.length === 0;
  if (noOp) {
    return {
      name: params.name,
      embed_model: manifest.embed_model,
      added,
      changed,
      unchanged: unchanged.sort(),
      deleted,
      missing: missing.sort(),
      reused_chunks: existing?.chunks.length ?? 0,
      reembedded_chunks: 0,
      dropped_chunks: 0,
      elapsed_ms: Date.now() - t0,
      no_op: true,
    };
  }

  // Live paths = manifest paths that actually exist on disk.
  const livePaths = classifications
    .filter((c) => c.klass !== "missing")
    .map((c) => c.path);

  const indexReport = await indexCorpus({
    name: params.name,
    paths: livePaths,
    model: params.model,
    chunk_chars: manifest.chunk_chars,
    chunk_overlap: manifest.chunk_overlap,
    client: params.client,
  });

  // Dropped chunks = prior chunks that didn't survive. Since reused chunks
  // are preserved verbatim, dropped = prev - reused.
  const prevChunkCount = existing?.chunks.length ?? 0;
  const droppedChunks = Math.max(0, prevChunkCount - indexReport.reused_chunks);

  // Silent :latest drift: if Ollama resolved the embed tag to a different
  // id this run than the one stored in the manifest at refresh start,
  // surface it so the caller knows some chunks are from the old model.
  // Report-only — we don't forcibly re-embed. Callers who want uniform
  // vector space re-run ollama_corpus_index.
  const priorResolved = manifest.embed_model_resolved;
  const currentResolved = indexReport.embed_model_resolved;
  const drift =
    priorResolved !== null && currentResolved !== null && priorResolved !== currentResolved
      ? { prior: priorResolved, current: currentResolved }
      : undefined;

  // Re-save manifest. Update the resolved tag only when a fresh probe
  // happened this run (indexReport.embed_model_resolved !== null);
  // otherwise preserve what the manifest already had.
  await saveManifest({
    ...manifest,
    embed_model_resolved: currentResolved ?? priorResolved,
    updated_at: new Date().toISOString(),
  });

  return {
    name: params.name,
    embed_model: manifest.embed_model,
    added: added.sort(),
    changed: changed.sort(),
    unchanged: unchanged.sort(),
    deleted,
    missing: missing.sort(),
    reused_chunks: indexReport.reused_chunks,
    reembedded_chunks: indexReport.newly_embedded_chunks,
    dropped_chunks: droppedChunks,
    elapsed_ms: Date.now() - t0,
    no_op: false,
    ...(drift ? { embed_model_resolved_drift: drift } : {}),
  };
}
