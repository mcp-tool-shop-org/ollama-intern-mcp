/**
 * Corpus manifest — the source of truth for what a corpus SHOULD contain.
 *
 * The corpus JSON (<name>.json) represents reality: the chunks actually
 * indexed right now. The manifest (<name>.manifest.json) represents
 * intent: the paths + chunk parameters + embed model the caller declared.
 * Refresh reconciles intent vs reality and reports the drift.
 *
 * Kept as a separate file so intent can be inspected and edited without
 * touching the corpus payload. ollama_corpus_index always writes a
 * manifest as a side effect; ollama_corpus_refresh reads it.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { InternError } from "../errors.js";
import { assertValidCorpusName } from "./storage.js";

export const MANIFEST_SCHEMA_VERSION = 2;

/**
 * Package version stamped on every manifest write. Loader refuses to read
 * a manifest whose writer version is newer than this build, to prevent
 * silent downgrade even when schema_version matches.
 */
const MANIFEST_WRITER_VERSION = (() => {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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

/**
 * Allowlisted roots a manifest's paths may live under. Defaults to the
 * user's home dir; extendable via INTERN_CORPUS_ALLOWED_ROOTS (colon-
 * separated on POSIX, semicolon-separated on Windows). A malicious
 * manifest that points at /etc/shadow or C:/Windows/... is rejected here.
 */
function allowedRoots(): string[] {
  const extra = process.env.INTERN_CORPUS_ALLOWED_ROOTS;
  const roots = [homedir()];
  if (extra) {
    const sep = process.platform === "win32" ? ";" : ":";
    for (const r of extra.split(sep)) {
      if (r.trim()) roots.push(r.trim());
    }
  }
  return roots.map((r) => normalize(r));
}

export function assertSafePath(p: string): void {
  if (!isAbsolute(p)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest path is not absolute: ${p}`,
      "All manifest paths must be absolute. Re-run ollama_corpus_index to rewrite the manifest with resolved paths.",
      false,
    );
  }
  const normalized = normalize(p);
  // Reject any `..` segments that survived normalize (shouldn't happen on
  // absolute paths, but be defensive).
  const segments = normalized.split(sep);
  if (segments.includes("..")) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest path contains traversal segment after normalize: ${p}`,
      "Reject corpora whose manifest was hand-edited with `..` segments. Re-index with trusted paths.",
      false,
    );
  }
  const roots = allowedRoots();
  const ok = roots.some((root) => {
    const r = root.endsWith(sep) ? root : root + sep;
    return normalized === root || normalized.startsWith(r);
  });
  if (!ok) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest path is outside allowed roots: ${p}`,
      `Path must live under one of: ${roots.join(", ")}. Set INTERN_CORPUS_ALLOWED_ROOTS to add more.`,
      false,
    );
  }
}

export interface ManifestFailedPath {
  path: string;
  reason: string;
}

export interface CorpusManifest {
  schema_version: number;
  /**
   * Package version that wrote this manifest. Loader rejects when this is
   * higher than the current build — prevents a newer build writing a
   * manifest that an older build would silently downgrade.
   */
  schema_version_written_by?: string;
  name: string;
  /** Absolute paths the corpus is declared to contain. */
  paths: string[];
  /** Embed model this manifest was built against — refresh refuses on mismatch. */
  embed_model: string;
  /**
   * Model identifier as Ollama RESOLVED it at index time (e.g.
   * "nomic-embed-text:latest"). Captured from EmbedResponse.model on the
   * first embed call during index. Refresh compares this against a live
   * probe to detect the silent case where Ollama updates a :latest tag
   * behind a stable profile name — vectors from the old resolved model
   * are not comparable to vectors from the new one. Null on manifests
   * written before schema v2 (auto-migrated on load).
   */
  embed_model_resolved: string | null;
  /**
   * Set only when more than one distinct resolved tag was observed during
   * a single refresh/index run — i.e. Ollama silently bumped `:latest`
   * mid-stream. Listed in ascending-string order. Absent on the happy path.
   * Cleared on the next clean run (single tag) so this field represents the
   * LAST known inconsistency, not historical ones.
   */
  embed_model_resolved_drift_within_refresh?: string[];
  chunk_chars: number;
  chunk_overlap: number;
  created_at: string;
  updated_at: string;
  /**
   * Timestamp written AFTER the corpus JSON has been saved. Its absence on
   * load is the signal that the previous mutation was interrupted between
   * corpus write and manifest write — callers still load the corpus (we
   * don't block on this), but corpus_list surfaces a warning so the user
   * knows to re-run corpus_refresh to restore inter-file consistency.
   * Optional for backward-compat with manifests written before Stage B+C.
   */
  completed_at?: string;
  /**
   * Paths that failed to read during the most recent index/refresh run.
   * Empty array on the happy path. When non-empty, corpus_refresh with
   * retry_failed:true will scan these in addition to the normal manifest
   * paths. Replaced (not appended) on every index run so the manifest
   * always reflects the latest state.
   */
  failed_paths?: ManifestFailedPath[];
  /**
   * Set true by ollama_corpus_amend when the corpus has had single-file
   * mutations applied on top of the normal "snapshot of disk" invariant.
   * corpus_list / corpus_health surface this as a warning so callers know
   * the corpus no longer mirrors the filesystem. Cleared (set false) by
   * the next clean index/refresh run, which re-establishes the invariant.
   * Absent on manifests written before the amend tool shipped.
   */
  has_amended_content?: boolean;
  /**
   * Per-path amend history. Appended by corpus_amend; cleared by the next
   * clean index/refresh. Surfaced via ollama_corpus_amend_history so callers
   * can inspect what drifted from disk before deciding whether to re-index.
   * Absent on manifests that have never been amended.
   */
  amended_paths?: Array<{
    path: string;
    amended_at: string;
    chunks_before: number;
    chunks_after: number;
  }>;
}

function manifestDir(): string {
  return process.env.INTERN_CORPUS_DIR ?? join(homedir(), ".ollama-intern", "corpora");
}

export function manifestPath(name: string): string {
  return join(manifestDir(), `${name}.manifest.json`);
}

export async function loadManifest(name: string): Promise<CorpusManifest | null> {
  assertValidCorpusName(name);
  const path = manifestPath(name);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<CorpusManifest> & { schema_version?: number };
  const found = parsed.schema_version;
  if (found === 1) {
    // v1 → v2 migration: v1 didn't capture the resolved tag. Treat as
    // "unknown at index time" — refresh will record it on the next embed
    // call and the drift check activates from there forward. failed_paths
    // defaults to empty and completed_at stays undefined (we don't know
    // whether the prior run landed cleanly, but legacy manifests in the
    // wild are almost certainly intact, so skip the interrupted-write
    // warning for them).
    return {
      ...(parsed as CorpusManifest),
      schema_version: MANIFEST_SCHEMA_VERSION,
      embed_model_resolved: null,
    };
  }
  if (found !== MANIFEST_SCHEMA_VERSION) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" is at schema v${found ?? "unknown"}; this build expects v${MANIFEST_SCHEMA_VERSION}. File: ${path}`,
      `Re-run ollama_corpus_index({ name: "${name}", paths: [...] }) to rewrite the manifest under the current schema.`,
      false,
    );
  }
  return parsed as CorpusManifest;
}

export async function saveManifest(manifest: CorpusManifest): Promise<void> {
  assertValidCorpusName(manifest.name);
  const path = manifestPath(manifest.name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}
