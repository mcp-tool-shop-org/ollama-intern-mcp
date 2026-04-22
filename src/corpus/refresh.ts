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
import { indexCorpusUnlocked } from "./indexer.js";
import { withCorpusLock } from "./lock.js";

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
  /**
   * Drift observed WITHIN this single refresh run — set only when the
   * indexer saw more than one resolved tag across its batches (Ollama
   * bumped `:latest` mid-stream). The resulting corpus has vectors from
   * two different models; re-index for a clean baseline. Absent on the
   * happy path.
   */
  embed_model_resolved_drift_within_refresh?: string[];
  /**
   * Paths retried this run because the prior index/refresh recorded them
   * as failed. Empty when retry_failed was false or the prior manifest had
   * no failed_paths. Paths that succeed this run leave failed_paths; paths
   * that fail again end up in `still_failed` and the manifest preserves
   * them for the next retry attempt.
   */
  retried_failed: string[];
  /** Paths that failed again this run (subset of retried_failed + fresh failures on the normal path set). */
  still_failed: { path: string; reason: string }[];
}

export interface RefreshParams {
  name: string;
  /** Active embed model. Must match the manifest or refresh refuses. */
  model: string;
  client: OllamaClient;
  /**
   * When true, re-attempt any paths that the previous index/refresh
   * recorded as failed (persisted in manifest.failed_paths). Default false
   * — a normal refresh honors the manifest's declared paths and nothing
   * else. Useful after the user fixes permissions / removes a stale
   * symlink / resizes a file below the cap and wants to retry without
   * re-indexing the entire corpus.
   */
  retry_failed?: boolean;
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
  // Serialize against concurrent index/refresh on the same corpus name
  // so corpus.json and manifest.json writes don't interleave across calls.
  return withCorpusLock(params.name, () => refreshCorpusUnlocked(params));
}

async function refreshCorpusUnlocked(params: RefreshParams): Promise<RefreshReport> {
  const t0 = Date.now();

  const manifest = await loadManifest(params.name);
  if (!manifest) {
    throw new InternError(
      "SCHEMA_INVALID",
      `No manifest found for corpus "${params.name}".`,
      `Either the corpus name is wrong, or it has never been indexed. Run ollama_corpus_list to see every corpus currently on disk. If the name is correct but unseen, run ollama_corpus_index({ name: "${params.name}", paths: [...] }) first — that writes the manifest as a side effect, and refresh can reconcile intent vs reality from then on.`,
      false,
    );
  }
  if (manifest.embed_model !== params.model) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${params.name}" declares embed model "${manifest.embed_model}", but the active embed tier is "${params.model}".`,
      `Mixing vectors across embed models gives meaningless similarity scores — refusing by design. Two fixes: (a) switch the active embed tier back to "${manifest.embed_model}" so refresh reuses existing vectors; or (b) re-run ollama_corpus_index({ name: "${params.name}", paths: [...] }) to rebuild the whole corpus under "${params.model}". Refresh will NOT re-embed across models.`,
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

  // Retry queue: paths the previous run recorded as failed. Only scanned
  // when the caller explicitly opts in — otherwise a refresh honors the
  // declared path set and nothing else.
  const priorFailed = params.retry_failed ? (manifest.failed_paths ?? []) : [];
  const retryPaths = priorFailed.map((f) => resolve(f.path));
  // Avoid double-indexing: a path that's both in manifest.paths AND in
  // failed_paths only needs to appear in the livePaths list once.
  const manifestAbsSet = new Set(manifestAbs);
  const retryExtraPaths = retryPaths.filter((p) => !manifestAbsSet.has(p));

  // No-op detection. Nothing to do → don't touch anything, don't bump
  // manifest.updated_at, don't call the indexer at all. A pending retry
  // counts as work even if nothing else drifted.
  const noOp =
    added.length === 0 &&
    changed.length === 0 &&
    deleted.length === 0 &&
    retryExtraPaths.length === 0;
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
      retried_failed: [],
      still_failed: [],
    };
  }

  // Live paths = manifest paths that actually exist on disk + retry extras.
  const livePaths = [
    ...classifications.filter((c) => c.klass !== "missing").map((c) => c.path),
    ...retryExtraPaths,
  ];

  // Use the unlocked variant — we already hold the corpus lock. Calling
  // indexCorpus here would try to re-acquire and self-deadlock.
  const indexReport = await indexCorpusUnlocked({
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
  //
  // Suppression rules (noise reduction):
  //   - prior === null: the manifest never captured a resolved tag
  //     (migrated v1 manifest, or no prior embed). There's nothing to
  //     compare against — don't fabricate a drift report.
  //   - current === null: no embed fired this run (pure reuse). We
  //     learned nothing new about the resolved tag, so we can't claim drift.
  //   - A no_op refresh also can't reach this code path — the early
  //     return above ensures it.
  const priorResolved = manifest.embed_model_resolved;
  const currentResolved = indexReport.embed_model_resolved;
  const drift =
    priorResolved !== null && currentResolved !== null && priorResolved !== currentResolved
      ? { prior: priorResolved, current: currentResolved }
      : undefined;

  // Note: indexCorpusUnlocked already rewrote the manifest (the indexer
  // owns manifest writes end-to-end, including failed_paths, completed_at,
  // and within-refresh drift). We only re-save here to preserve:
  //   - the embed_model_resolved anchor from BEFORE this run if nothing
  //     embedded (pure reuse), so the drift anchor isn't lost;
  //   - our own updated_at bump in the no-retry shape (the indexer already
  //     sets updated_at too, but being explicit here keeps the contract
  //     obvious).
  // The indexer's write is authoritative for everything else, so we
  // re-load the just-written manifest, apply only the prior-preservation,
  // and write back.
  const latestManifest = (await loadManifest(params.name)) ?? manifest;
  await saveManifest({
    ...latestManifest,
    embed_model_resolved: currentResolved ?? priorResolved,
    updated_at: new Date().toISOString(),
  });

  // Retry accounting: which of the retryExtraPaths actually succeeded
  // (hash now present in the refreshed corpus) and which failed again
  // (still in indexReport.failed_paths).
  const freshFailedByPath = new Map(
    indexReport.failed_paths.map((f) => [resolve(f.path), f.reason]),
  );
  const retriedFailed = retryExtraPaths;
  const stillFailed = indexReport.failed_paths.map((f) => ({
    path: resolve(f.path),
    reason: f.reason,
  }));
  // Silence the "unused" warning in some editors — the map is intentionally
  // kept for future callers who want per-path reason lookups.
  void freshFailedByPath;

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
    retried_failed: retriedFailed,
    still_failed: stillFailed,
    ...(drift ? { embed_model_resolved_drift: drift } : {}),
    ...(indexReport.embed_model_resolved_drift_within_refresh
      ? { embed_model_resolved_drift_within_refresh: indexReport.embed_model_resolved_drift_within_refresh }
      : {}),
  };
}
