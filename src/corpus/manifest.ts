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

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { InternError } from "../errors.js";
import { assertValidCorpusName, rejectWin32NameAlias } from "./storage.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { withCorpusLock } from "./lock.js";
import { canonicalCorpusKey } from "./identity.js";

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
  // Expand each root to BOTH the literal-normalized form AND its realpath.
  // On macOS, /var/folders/... and /private/var/folders/... point at the
  // same directory through the system /var → /private/var symlink. The
  // input path may or may not exist on disk (synthetic-path amends are a
  // documented use case), so we can't always realpath the input itself —
  // matching against either form on the root side closes the asymmetry
  // without making the input-side realpath load-bearing.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    const literal = normalize(r);
    if (!seen.has(literal)) {
      seen.add(literal);
      out.push(literal);
    }
    try {
      const real = realpathSync(literal);
      if (!seen.has(real)) {
        seen.add(real);
        out.push(real);
      }
    } catch {
      // Root doesn't exist yet — env-var may point at a directory the
      // operator hasn't created. The literal form is already in the set;
      // skip the realpath sibling.
    }
  }
  return out;
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
  // Realpath the input so it compares apples-to-apples with allowedRoots()
  // (which also realpaths each entry). Without this, macOS rejects valid
  // paths because /var/folders/... and /private/var/folders/... read as
  // different strings even though they're the same directory.
  //
  // When realpath succeeds, ONLY the resolved path is allow-checked — a
  // symlink whose lexical path sits under homedir but whose target is
  // /etc/shadow must not pass. The lexical (normalized) path is used
  // solely for ENOENT (synthetic-amend / not-yet-created files). Any
  // other realpath failure (EACCES, ENOTDIR) fails closed.
  let resolved: string | undefined;
  try {
    resolved = realpathSync(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new InternError(
        "SCHEMA_INVALID",
        `Manifest path could not be resolved: ${p} (${code ?? "unknown"})`,
        "The path must exist and be readable, or be a not-yet-created file (ENOENT) under an allowed root. Fix permissions or the path and retry.",
        false,
      );
    }
  }
  const candidate = resolved ?? normalized;
  const roots = allowedRoots();
  const ok = roots.some((root) => pathIsUnderRoot(candidate, root));
  if (!ok) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest path is outside allowed roots: ${p}`,
      `Path must live under one of: ${roots.join(", ")}. Set INTERN_CORPUS_ALLOWED_ROOTS to add more.`,
      false,
    );
  }
}

function pathIsUnderRoot(candidate: string, root: string): boolean {
  let c = candidate;
  let r0 = root;
  if (process.platform === "win32") {
    c = c.normalize("NFC").toLowerCase();
    r0 = r0.normalize("NFC").toLowerCase();
  }
  const r = r0.endsWith(sep) ? r0 : r0 + sep;
  return c === r0 || c.startsWith(r);
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
  return join(manifestDir(), `${canonicalCorpusKey(name)}.manifest.json`);
}

export async function loadManifest(name: string): Promise<CorpusManifest | null> {
  assertValidCorpusName(name);
  const path = manifestPath(name);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  let parsed: Partial<CorpusManifest> & { schema_version?: number };
  try {
    parsed = JSON.parse(raw) as Partial<CorpusManifest> & { schema_version?: number };
  } catch {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" is not valid JSON. File: ${path}`,
      `Re-run ollama_corpus_index({ name: "${name}", paths: [...] }) to rewrite the manifest. The file is corrupt or truncated.`,
      false,
    );
  }
  const found = parsed.schema_version;
  if (found === 1) {
    // v1 → v2 migration: v1 didn't capture the resolved tag. Treat as
    // "unknown at index time" — refresh will record it on the next embed
    // call and the drift check activates from there forward.
    //
    // M5: v1 also predates the completed_at torn-write marker, so it has none.
    // A legacy manifest in the wild is almost certainly intact — stamp
    // completed_at from a real prior timestamp so it migrates as "complete" and
    // does NOT trip the false-positive interrupted-write warning. This is the
    // sentinel that distinguishes "legacy, assumed complete" from a genuinely
    // torn v2 manifest (which has NO completed_at because the two-phase marker
    // cleared it and a crash prevented the restore).
    const migrated: CorpusManifest = {
      ...(parsed as CorpusManifest),
      schema_version: MANIFEST_SCHEMA_VERSION,
      embed_model_resolved: null,
      completed_at: parsed.updated_at ?? parsed.created_at ?? new Date(0).toISOString(),
    };
    return validateManifestShape(name, path, migrated);
  }
  if (found !== MANIFEST_SCHEMA_VERSION) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" is at schema v${found ?? "unknown"}; this build expects v${MANIFEST_SCHEMA_VERSION}. File: ${path}`,
      `Re-run ollama_corpus_index({ name: "${name}", paths: [...] }) to rewrite the manifest under the current schema.`,
      false,
    );
  }
  // Refuse to load a manifest written by a newer pkg version than ours.
  // Same schema number, but a newer build may have added fields the current
  // build would lose on the next write. Mirrors loadCorpus in storage.ts so
  // the manifest gets the same downgrade protection as the corpus payload.
  const writtenBy = parsed.schema_version_written_by;
  if (typeof writtenBy === "string" && compareVersions(writtenBy, MANIFEST_WRITER_VERSION) > 0) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" was written by v${writtenBy}; this build is v${MANIFEST_WRITER_VERSION} and refuses to downgrade. File: ${path}`,
      `Upgrade ollama-intern-mcp to v${writtenBy} or newer, or re-index after downgrading the package deliberately.`,
      false,
    );
  }
  return validateManifestShape(name, path, parsed);
}

function validateManifestShape(
  name: string,
  filePath: string,
  parsed: Partial<CorpusManifest>,
): CorpusManifest {
  const hint = `Re-run ollama_corpus_index({ name: "${name}", paths: [...] }) to rewrite the manifest. File: ${filePath}`;
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new InternError("SCHEMA_INVALID", `Manifest for corpus "${name}" is missing a name. File: ${filePath}`, hint, false);
  }
  if (canonicalCorpusKey(parsed.name) !== canonicalCorpusKey(name)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" has name "${parsed.name}". File: ${filePath}`,
      hint,
      false,
    );
  }
  // Win32: a non-canonical lookup spelling that aliases the stored name
  // (NOTES vs Notes) is rejected with the same save-time helper. Canonical-key
  // lookups (the on-disk filename stem) stay allowed so listCorpora can load
  // mixed-case corpora (F-0e98b29b).
  if (process.platform === "win32" && parsed.name !== name && name !== canonicalCorpusKey(parsed.name)) {
    rejectWin32NameAlias(name, filePath);
  }
  if (!Array.isArray(parsed.paths) || parsed.paths.some((p) => typeof p !== "string" || p.length === 0)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" has invalid paths[]. File: ${filePath}`,
      hint,
      false,
    );
  }
  if (typeof parsed.embed_model !== "string" || parsed.embed_model.length === 0) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" is missing embed_model. File: ${filePath}`,
      hint,
      false,
    );
  }
  if (!Number.isFinite(parsed.chunk_chars) || !Number.isFinite(parsed.chunk_overlap)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" has invalid chunk_chars/chunk_overlap. File: ${filePath}`,
      hint,
      false,
    );
  }
  if (typeof parsed.created_at !== "string" || typeof parsed.updated_at !== "string") {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" is missing created_at/updated_at. File: ${filePath}`,
      hint,
      false,
    );
  }
  if (parsed.failed_paths !== undefined) {
    if (
      !Array.isArray(parsed.failed_paths) ||
      parsed.failed_paths.some((f) => !f || typeof f.path !== "string" || typeof f.reason !== "string")
    ) {
      throw new InternError(
        "SCHEMA_INVALID",
        `Manifest for corpus "${name}" has invalid failed_paths. File: ${filePath}`,
        hint,
        false,
      );
    }
  }
  for (const p of parsed.paths) {
    assertSafePath(p);
  }
  return parsed as CorpusManifest;
}

export async function saveManifest(manifest: CorpusManifest): Promise<void> {
  return withCorpusLock(manifest.name, () => saveManifestUnlocked(manifest, manifest.name));
}

async function saveManifestUnlocked(manifest: CorpusManifest, lookupName: string): Promise<void> {
  assertValidCorpusName(lookupName);
  assertValidCorpusName(manifest.name);
  const path = manifestPath(lookupName);
  rejectWin32NameAlias(manifest.name, path);
  // Stamp the writer version so older builds can refuse to downgrade —
  // mirrors saveCorpus in storage.ts. loadManifest reads this back and
  // rejects when it's newer than the running build.
  const stamped: CorpusManifest = { ...manifest, schema_version_written_by: MANIFEST_WRITER_VERSION };
  // Atomic write: tmp+fsync+rename — mirrors saveCorpus in storage.ts so
  // the corpus JSON and manifest JSON paired under withCorpusLock are
  // each individually durable. A torn manifest write would leave a
  // truncated JSON that loadManifest's silent catch swallows, breaking
  // the lock's "one logical state" guarantee.
  await atomicWriteFile(path, JSON.stringify(stamped, null, 2));
}

/**
 * M5 two-phase torn-write marker (phase 1). Before a mutation overwrites the
 * corpus JSON, clear the manifest's `completed_at` so that a crash landing
 * between the corpus write and the final manifest write leaves NO completed_at
 * on disk — corpus_list / corpus_health then correctly report
 * `write_complete: false`. Without this, the PRIOR (still-valid) completed_at
 * from the last clean run would falsely report the torn state as complete: the
 * detector "structurally can't see a tear after the first index". No-op when
 * there is no manifest yet (first index) or it already lacks the marker. The
 * mutation's own final saveManifest (with completed_at) restores it on success.
 */
export async function clearCompletedMarker(name: string): Promise<void> {
  return withCorpusLock(name, () => clearCompletedMarkerUnlocked(name));
}

async function clearCompletedMarkerUnlocked(name: string): Promise<void> {
  const prev = await loadManifest(name).catch(() => null);
  if (!prev || prev.completed_at === undefined) return;
  const dirty: CorpusManifest = { ...prev };
  delete dirty.completed_at;
  // Persist under the lookup name's lock/path, not dirty.name — otherwise a
  // mismatched stored name would take a different lock and write a different
  // manifest (F-0e98b29b). Stored spelling is kept so rejectWin32NameAlias
  // does not fire on a case-folded lookup.
  await saveManifestUnlocked(dirty, name);
}
