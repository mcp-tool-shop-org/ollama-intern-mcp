/**
 * Corpus persistence — one JSON file per named corpus.
 *
 * Location: ~/.ollama-intern/corpora/<name>.json  (override via INTERN_CORPUS_DIR)
 *
 * Schema is explicitly versioned so we can evolve without silent breakage.
 * Raw vectors are stored (this file is the database), but they never reach
 * Claude — search handlers strip them before returning.
 */

import { readFile, writeFile, mkdir, readdir, stat, rename, open, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { InternError } from "../errors.js";
import { loadManifest } from "./manifest.js";

export const CORPUS_SCHEMA_VERSION = 2;
/**
 * Hard cap on in-memory chunk count per corpus. A single JSON file that
 * holds 1M+ chunks will blow past Node's string-length ceiling and OOM on
 * write. If you hit this, split the corpus.
 */
export const MAX_CHUNKS = 100_000;
/**
 * Stamped into every write so a newer-schema file is never silently
 * downgraded by an older build. Resolved at import time from the running
 * package version.
 */
const PKG_VERSION = (() => {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
export const SCHEMA_WRITER_VERSION = PKG_VERSION;

export type ChunkType = "heading" | "paragraph" | "code" | "list" | "frontmatter";

export interface CorpusChunk {
  id: string;
  path: string;
  file_hash: string;
  file_mtime: string;
  chunk_index: number;
  char_start: number;
  char_end: number;
  text: string;
  vector: number[];
  heading_path: string[];
  chunk_type: ChunkType;
}

export interface CorpusFile {
  schema_version: number;
  /**
   * Package version that wrote this file. Used to reject the case where a
   * newer build wrote the corpus and an older build (still on the same
   * schema number) loads it and silently downgrades. Optional for
   * backward-compat with files written before this field existed.
   */
  schema_version_written_by?: string;
  name: string;
  model_version: string;
  model_digest: string | null;
  indexed_at: string;
  chunk_chars: number;
  chunk_overlap: number;
  stats: {
    documents: number;
    chunks: number;
    total_chars: number;
  };
  titles: Record<string, string | null>;
  chunks: CorpusChunk[];
}

/** semver-ish compare: returns -1 if a<b, 0 if equal, 1 if a>b. Falls back to 0 on parse error. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export function corpusDir(): string {
  return process.env.INTERN_CORPUS_DIR ?? join(homedir(), ".ollama-intern", "corpora");
}

export function corpusPath(name: string): string {
  return join(corpusDir(), `${name}.json`);
}

const NAME_RX = /^[a-zA-Z0-9_-]+$/;

export function assertValidCorpusName(name: string): void {
  if (!NAME_RX.test(name)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Invalid corpus name "${name}"`,
      "Corpus names must match [a-zA-Z0-9_-]+ so they map safely to filenames.",
      false,
    );
  }
}

export async function loadCorpus(name: string): Promise<CorpusFile | null> {
  assertValidCorpusName(name);
  const path = corpusPath(name);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<CorpusFile> & { schema_version?: number };
  const found = parsed.schema_version;
  if (found !== CORPUS_SCHEMA_VERSION) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${name}" is at schema v${found ?? "unknown"}; this build expects v${CORPUS_SCHEMA_VERSION}. File: ${path}`,
      `Re-index to upgrade in place: ollama_corpus_index({ name: "${name}", paths: [<your source paths>] }). No migration is performed — the re-index rewrites ${path} with the current schema.`,
      false,
    );
  }
  // Refuse to load a corpus that was written by a newer pkg version than
  // ours. Same schema number, but a newer build may have added fields the
  // current build would lose on the next write.
  const writtenBy = parsed.schema_version_written_by;
  if (typeof writtenBy === "string" && compareVersions(writtenBy, SCHEMA_WRITER_VERSION) > 0) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${name}" was written by v${writtenBy}; this build is v${SCHEMA_WRITER_VERSION} and refuses to downgrade. File: ${path}`,
      `Upgrade ollama-intern-mcp to v${writtenBy} or newer, or re-index after downgrading the package deliberately.`,
      false,
    );
  }
  return parsed as CorpusFile;
}

export async function saveCorpus(corpus: CorpusFile): Promise<void> {
  assertValidCorpusName(corpus.name);
  // Refuse to serialize absurdly large corpora — a single JSON.stringify
  // over 100k+ chunks will hit Node's max string length and OOM.
  if (corpus.chunks.length > MAX_CHUNKS) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${corpus.name}" has ${corpus.chunks.length} chunks; cap is ${MAX_CHUNKS}.`,
      `Split this into multiple smaller corpora (e.g. by directory or topic). A single JSON file this large will blow Node's string-length ceiling on write.`,
      false,
    );
  }
  const path = corpusPath(corpus.name);
  await mkdir(dirname(path), { recursive: true });
  // Stamp the writer version so older builds can refuse to downgrade.
  const stamped: CorpusFile = { ...corpus, schema_version_written_by: SCHEMA_WRITER_VERSION };
  const payload = JSON.stringify(stamped);
  // Observability: payload size in bytes (UTF-8) so ops can spot runaway growth.
  // Using Buffer.byteLength is accurate for non-ASCII content.
  // eslint-disable-next-line no-console
  console.error(`[corpus:save] name=${corpus.name} chunks=${corpus.chunks.length} bytes=${Buffer.byteLength(payload, "utf8")}`);
  // Atomic write: write to <path>.tmp, fsync, then rename. If Node crashes
  // mid-write the original file is intact — rename on the same filesystem
  // is atomic on both POSIX and NTFS.
  const tmpPath = `${path}.tmp`;
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(payload, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the temp file if rename failed.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export interface CorpusSummary {
  name: string;
  model_version: string;
  indexed_at: string;
  documents: number;
  chunks: number;
  total_chars: number;
  bytes_on_disk: number;
  /**
   * Number of paths the last index/refresh recorded as failed to read
   * (symlink, size cap, TOCTOU, permission). 0 on the happy path. Non-zero
   * means callers should consider ollama_corpus_refresh({retry_failed: true}).
   */
  failed_path_count?: number;
  /**
   * False when the manifest is missing `completed_at` — the previous
   * mutation landed the corpus JSON but was interrupted before the
   * manifest completed. Absent (undefined) on legacy pre-Stage-B+C
   * manifests that never had the marker. Treat undefined as "unknown, not
   * necessarily bad"; treat false as "run corpus_refresh to restore
   * inter-file consistency".
   */
  write_complete?: boolean;
}

export async function listCorpora(): Promise<CorpusSummary[]> {
  const dir = corpusDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const summaries: CorpusSummary[] = [];
  for (const entry of entries) {
    // Skip the manifest sibling files — listCorpora is the "primary file
    // per corpus" view, and we derive manifest info by loading alongside.
    if (!entry.endsWith(".json")) continue;
    if (entry.endsWith(".manifest.json")) continue;
    const name = entry.slice(0, -".json".length);
    if (!NAME_RX.test(name)) continue;
    try {
      const full = join(dir, entry);
      const [corpus, st, manifest] = await Promise.all([
        loadCorpus(name),
        stat(full),
        loadManifest(name).catch(() => null),
      ]);
      if (!corpus) continue;
      const failedCount = manifest?.failed_paths?.length ?? 0;
      // `completed_at` is only present on manifests written after the
      // Stage B+C atomic-marker landed. Undefined on legacy manifests —
      // emit `write_complete: undefined` there so callers can distinguish
      // "unknown" from "known-incomplete".
      const writeComplete =
        manifest == null
          ? undefined
          : typeof manifest.completed_at === "string" && manifest.completed_at.length > 0;
      summaries.push({
        name: corpus.name,
        model_version: corpus.model_version,
        indexed_at: corpus.indexed_at,
        documents: corpus.stats.documents,
        chunks: corpus.stats.chunks,
        total_chars: corpus.stats.total_chars,
        bytes_on_disk: st.size,
        ...(failedCount > 0 ? { failed_path_count: failedCount } : {}),
        ...(writeComplete === undefined ? {} : { write_complete: writeComplete }),
      });
    } catch {
      // Skip malformed corpora silently in list; load will surface the error.
    }
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

/**
 * Fast stale-detection primitive.
 *
 * Compares each manifest-declared path's current stat.mtime against the
 * mtime stored in the corpus's chunks. Returns as soon as any drift is
 * found — does NOT re-read file contents or re-hash, so it's cheap enough
 * for callers to poll before deciding whether to pay the full refresh
 * cost.
 *
 * Reasons:
 *   - "no_corpus"   — corpus JSON missing
 *   - "no_manifest" — manifest JSON missing
 *   - "path_missing:<path>"  — manifest declares a path that isn't on disk
 *   - "path_added:<path>"    — manifest declares a path the corpus has never seen
 *   - "path_removed:<path>"  — corpus has a path the manifest no longer lists
 *   - "mtime_drift:<path>"   — file's mtime is later than the corpus record
 */
export async function isCorpusStale(
  name: string,
): Promise<{ stale: boolean; reason?: string }> {
  assertValidCorpusName(name);
  let corpus: CorpusFile | null = null;
  try {
    corpus = await loadCorpus(name);
  } catch {
    // A schema-invalid corpus IS stale (re-index needed).
    return { stale: true, reason: "no_corpus" };
  }
  if (!corpus) return { stale: true, reason: "no_corpus" };

  const manifest = await loadManifest(name).catch(() => null);
  if (!manifest) return { stale: true, reason: "no_manifest" };

  // Build a map path → latest stored mtime from chunks.
  const storedMtimeByPath = new Map<string, number>();
  for (const c of corpus.chunks) {
    const t = Date.parse(c.file_mtime);
    if (Number.isNaN(t)) continue;
    const prev = storedMtimeByPath.get(c.path);
    if (prev === undefined || t > prev) storedMtimeByPath.set(c.path, t);
  }

  const manifestSet = new Set(manifest.paths);
  // Paths in corpus that are no longer declared by the manifest.
  for (const p of storedMtimeByPath.keys()) {
    if (!manifestSet.has(p)) return { stale: true, reason: `path_removed:${p}` };
  }

  for (const p of manifest.paths) {
    let currentMtime: number;
    try {
      const st = await stat(p);
      currentMtime = st.mtimeMs;
    } catch {
      return { stale: true, reason: `path_missing:${p}` };
    }
    const stored = storedMtimeByPath.get(p);
    if (stored === undefined) return { stale: true, reason: `path_added:${p}` };
    // Only flag when current is strictly later — allow clock skew that
    // happens to produce an earlier mtime (e.g. touch to an older date).
    if (currentMtime > stored + 1) return { stale: true, reason: `mtime_drift:${p}` };
  }
  return { stale: false };
}
