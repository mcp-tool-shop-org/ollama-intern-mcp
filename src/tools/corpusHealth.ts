/**
 * ollama_corpus_health — dedicated health summary for indexed corpora.
 *
 * No Ollama call. Superset of ollama_corpus_list: returns everything list
 * returns PLUS staleness age (days since indexed_at), the drift fields
 * from the manifest (resolved tag + within-refresh drift), a
 * write-complete flag, and a warnings[] per corpus. In `detailed: true`
 * mode adds per-file mtime + stale-days so callers can pinpoint which
 * source file triggered a stale flag without re-running corpus_refresh.
 *
 * Use this when you want "is my corpus set healthy?" as a single call.
 */

import { z } from "zod";
import { stat } from "node:fs/promises";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { listCorpora, loadCorpus, corpusPath } from "../corpus/storage.js";
import { loadManifest } from "../corpus/manifest.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const corpusHealthSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .optional()
    .describe("Single corpus to report on. When omitted, reports health for every corpus on disk."),
  detailed: z
    .boolean()
    .optional()
    .describe("When true, each entry gets a per-file list with mtime + staleness days. Default false — cheaper."),
});

export type CorpusHealthInput = z.infer<typeof corpusHealthSchema>;

export interface CorpusHealthFileDetail {
  path: string;
  /** File's current mtime on disk (ISO string). null if the file can't be stat'd. */
  mtime: string | null;
  /** Number of chunks the corpus currently stores for this path. */
  chunk_count: number;
  /** Whole-day-rounded age since mtime; null when mtime is null. */
  stale_days: number | null;
}

export interface CorpusHealthEntry {
  name: string;
  chunks: number;
  docs: number;
  bytes: number;
  indexed_at: string;
  /** Days since indexed_at — a coarse freshness hint; does NOT mean drift. */
  staleness_days: number;
  embed_model: string;
  /** Resolved tag captured at last index (e.g. "nomic-embed-text:latest"). null when unknown. */
  embed_model_resolved: string | null;
  /** True when the manifest records within-refresh :latest drift (an index saw >1 distinct resolved tag). */
  drift_detected: boolean;
  /** Populated only when drift_detected is true. */
  drift_within_refresh?: string[];
  failed_paths_count: number;
  /**
   * True when the manifest was written cleanly (completed_at present). False
   * when the previous mutation landed the corpus but was interrupted before
   * the manifest's tail marker. Undefined for legacy pre-Stage-B+C manifests.
   */
  write_complete: boolean | undefined;
  /** Plain-English health notes — callers should read these. */
  warnings: string[];
  /** Only populated when `detailed: true`. */
  paths?: CorpusHealthFileDetail[];
  /** True when corpus_amend has mutated this corpus since the last index/refresh. */
  has_amended_content: boolean;
}

export interface CorpusHealthResult {
  corpora: CorpusHealthEntry[];
  corpus_dir: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function staleDays(fromIso: string | null, nowMs: number): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  const diff = nowMs - t;
  if (diff <= 0) return 0;
  return Math.floor(diff / MS_PER_DAY);
}

async function buildEntry(
  name: string,
  detailed: boolean,
  nowMs: number,
): Promise<CorpusHealthEntry | null> {
  // Load both files concurrently; corpus_list-style tolerance — a corpus that
  // can't load is skipped silently here (callers asking for a specific name
  // get a loud error from the caller layer).
  const [corpus, manifest] = await Promise.all([
    loadCorpus(name).catch(() => null),
    loadManifest(name).catch(() => null),
  ]);
  if (!corpus) return null;

  const warnings: string[] = [];
  const failedPathsCount = manifest?.failed_paths?.length ?? 0;
  const writeComplete =
    manifest == null
      ? undefined
      : typeof manifest.completed_at === "string" && manifest.completed_at.length > 0;

  if (writeComplete === false) {
    warnings.push(
      "Previous write was interrupted before the manifest finished. Run ollama_corpus_refresh to restore inter-file consistency.",
    );
  }
  if (failedPathsCount > 0) {
    warnings.push(
      `${failedPathsCount} path(s) failed during last index/refresh. After fixing the cause, run ollama_corpus_refresh({ retry_failed: true }).`,
    );
  }

  const driftWithin = manifest?.embed_model_resolved_drift_within_refresh;
  const driftDetected = Array.isArray(driftWithin) && driftWithin.length > 1;
  if (driftDetected) {
    warnings.push(
      `Embed model :latest drift observed within a single refresh — corpus contains vectors from multiple resolved tags (${driftWithin.join(", ")}). Re-index for a clean vector space.`,
    );
  }

  const amended = manifest?.has_amended_content === true;
  if (amended) {
    warnings.push(
      "Corpus has been mutated by ollama_corpus_amend since the last index/refresh. It no longer matches disk — callers must keep the source file(s) in sync manually or re-run ollama_corpus_refresh.",
    );
  }

  // File size on disk — the authoritative "how big is this corpus" metric.
  let bytes = 0;
  try {
    const st = await stat(corpusPath(name));
    bytes = st.size;
  } catch {
    bytes = 0;
  }

  const staleness = staleDays(corpus.indexed_at, nowMs) ?? 0;

  const entry: CorpusHealthEntry = {
    name: corpus.name,
    chunks: corpus.stats.chunks,
    docs: corpus.stats.documents,
    bytes,
    indexed_at: corpus.indexed_at,
    staleness_days: staleness,
    embed_model: corpus.model_version,
    embed_model_resolved: manifest?.embed_model_resolved ?? null,
    drift_detected: driftDetected,
    ...(driftDetected ? { drift_within_refresh: driftWithin } : {}),
    failed_paths_count: failedPathsCount,
    write_complete: writeComplete,
    warnings,
    has_amended_content: amended,
  };

  if (detailed) {
    // Gather per-path chunk counts from the corpus file itself (chunk_count).
    // Pair with a current-disk stat for mtime + stale_days. Files we can't
    // stat report mtime:null, stale_days:null — caller sees the gap.
    const chunkCountByPath = new Map<string, number>();
    for (const c of corpus.chunks) {
      chunkCountByPath.set(c.path, (chunkCountByPath.get(c.path) ?? 0) + 1);
    }
    const paths: CorpusHealthFileDetail[] = [];
    for (const [path, chunk_count] of chunkCountByPath) {
      let mtime: string | null = null;
      let stale: number | null = null;
      try {
        const st = await stat(path);
        mtime = st.mtime.toISOString();
        stale = staleDays(mtime, nowMs);
      } catch {
        // missing / unreadable → null mtime. Caller can decide whether to
        // retry_failed or ignore. No throw — this is a health tool.
      }
      paths.push({ path, mtime, chunk_count, stale_days: stale });
    }
    paths.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    entry.paths = paths;
  }

  return entry;
}

export async function handleCorpusHealth(
  input: CorpusHealthInput,
  ctx: RunContext,
): Promise<Envelope<CorpusHealthResult>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);
  const detailed = input.detailed === true;
  const nowMs = Date.now();

  let names: string[];
  if (input.name) {
    // Single-name mode: fail loud if the named corpus doesn't exist, so a
    // typo surfaces instead of a surprise empty result.
    const corpus = await loadCorpus(input.name).catch(() => null);
    if (!corpus) {
      throw new InternError(
        "SCHEMA_INVALID",
        `Corpus "${input.name}" does not exist.`,
        `Call ollama_corpus_list (or ollama_corpus_health with no args) to see what's on disk. Build it first with ollama_corpus_index({ name: "${input.name}", paths: [...] }).`,
        false,
      );
    }
    names = [input.name];
  } else {
    const summaries = await listCorpora();
    names = summaries.map((s) => s.name);
  }

  const entries: CorpusHealthEntry[] = [];
  for (const n of names) {
    const e = await buildEntry(n, detailed, nowMs);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Envelope-level warnings: summarize any corpus-level issue up front so
  // callers can scan one field. Detailed per-corpus notes still live on each
  // entry's warnings[].
  const envWarnings: string[] = [];
  const needsRefresh = entries.filter((e) => e.write_complete === false).map((e) => e.name);
  const withFailed = entries.filter((e) => e.failed_paths_count > 0).map((e) => e.name);
  const withDrift = entries.filter((e) => e.drift_detected).map((e) => e.name);
  const withAmend = entries.filter((e) => e.has_amended_content).map((e) => e.name);
  if (needsRefresh.length > 0) {
    envWarnings.push(
      `${needsRefresh.length} corpus/corpora need refresh (interrupted write): ${needsRefresh.join(", ")}.`,
    );
  }
  if (withFailed.length > 0) {
    envWarnings.push(
      `${withFailed.length} corpus/corpora have unresolved failed_paths: ${withFailed.join(", ")}.`,
    );
  }
  if (withDrift.length > 0) {
    envWarnings.push(
      `${withDrift.length} corpus/corpora show within-refresh :latest drift: ${withDrift.join(", ")}.`,
    );
  }
  if (withAmend.length > 0) {
    envWarnings.push(
      `${withAmend.length} corpus/corpora have amend-mutated content (no longer mirror disk): ${withAmend.join(", ")}.`,
    );
  }

  const envelope = buildEnvelope<CorpusHealthResult>({
    result: {
      corpora: entries,
      corpus_dir: process.env.INTERN_CORPUS_DIR ?? "~/.ollama-intern/corpora",
    },
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    warnings: envWarnings.length > 0 ? envWarnings : undefined,
  });

  await ctx.logger.log(callEvent("ollama_corpus_health", envelope));
  return envelope;
}
