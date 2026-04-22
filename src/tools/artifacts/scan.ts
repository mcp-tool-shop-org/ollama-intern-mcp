/**
 * Artifact discovery — shared scanner used by artifact_list and
 * artifact_read. The point of this module is to make artifacts into a
 * working surface instead of one-shot files on disk:
 *
 *   - Canonical identity is (pack, slug). Paths are secondary.
 *   - Listing is metadata-only. Full payloads live in read.
 *   - Slug collisions within a pack fail loud rather than guess.
 *   - extra_artifact_dirs are read-only SEARCH surfaces; they don't
 *     change the identity rules.
 *   - {json_path} reads are path-safety-guarded — must normalize
 *     absolute, must end in .json, must live under a recognized dir.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { InternError } from "../../errors.js";
import type { IncidentPackArtifact } from "../packs/incidentPack.js";
import type { RepoPackArtifact } from "../packs/repoPack.js";
import type { ChangePackArtifact } from "../packs/changePack.js";

export type PackName = "incident_pack" | "repo_pack" | "change_pack";

export const KNOWN_PACKS: readonly PackName[] = [
  "incident_pack",
  "repo_pack",
  "change_pack",
] as const;

export type PackArtifact =
  | IncidentPackArtifact
  | RepoPackArtifact
  | ChangePackArtifact;

/** Compact metadata — what artifact_list returns per artifact. */
export interface ArtifactMetadata {
  pack: PackName;
  slug: string;
  title: string;
  created_at: string;
  weak: boolean;
  corpus_used: { name: string; chunks_used: number } | null;
  evidence_count: number;
  /** Pack-specific section item counts. Keys depend on pack; never flattened. */
  section_counts: Record<string, number>;
  md_path: string;
  json_path: string;
}

export interface ScanOptions {
  /** Extra directories to search in addition to the canonical set. Read-only — identity stays (pack, slug). */
  extra_artifact_dirs?: string[];
}

// ── Canonical artifact root ─────────────────────────────────

/** Base artifact dir: INTERN_ARTIFACT_DIR if set, else ~/.ollama-intern/artifacts/. */
export function artifactRoot(): string {
  return process.env.INTERN_ARTIFACT_DIR ?? join(homedir(), ".ollama-intern", "artifacts");
}

/** Per-pack subdirs under the canonical root. */
export function canonicalPackDirs(): Record<PackName, string> {
  const root = artifactRoot();
  return {
    incident_pack: join(root, "incident"),
    repo_pack: join(root, "repo"),
    change_pack: join(root, "change"),
  };
}

/** Normalize an absolute path; reject paths with traversal or relative components. */
function safeNormalizePath(p: string): string {
  if (!isAbsolute(p)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Path must be absolute: ${p}`,
      "Pass the absolute path returned from an artifact write, not a relative path.",
      false,
    );
  }
  // Reject ANY '..' segment in the input, even if it would normalize to a
  // safe path. Traversal attempts fail loud — we don't silently accept a
  // redirected path. Split on both separators so Windows and POSIX inputs
  // are treated the same way.
  const rawSegments = p.split(/[/\\]/);
  if (rawSegments.includes("..")) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Path contains parent traversal: ${p}`,
      "Artifact paths must resolve cleanly without '..' segments.",
      false,
    );
  }
  return normalize(p);
}

/**
 * Assert that an absolute path lives under one of the allowed artifact
 * dirs. Used by artifact_read for the secondary {json_path} entry point
 * to keep the tool from drifting into a generic file reader.
 */
export function assertPathUnderAllowedDir(absPath: string, extraDirs: string[] = []): void {
  const allowed = [
    artifactRoot(),
    ...Object.values(canonicalPackDirs()),
    ...extraDirs.map(safeNormalizePath),
  ].map((d) => normalize(d));
  const normalized = safeNormalizePath(absPath);
  const underAllowed = allowed.some((root) => {
    // Ensure we match at a path boundary, not a prefix substring.
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    return normalized === root || normalized.startsWith(rootWithSep);
  });
  if (!underAllowed) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Path is not under a recognized artifact dir: ${absPath}`,
      `Allowed roots: ${allowed.join(", ")}. Pass extra_artifact_dirs to widen the search.`,
      false,
    );
  }
}

// ── Metadata extraction ─────────────────────────────────────

function isKnownPack(v: unknown): v is PackName {
  return typeof v === "string" && (KNOWN_PACKS as readonly string[]).includes(v);
}

function extractSectionCounts(pack: PackName, brief: unknown): Record<string, number> {
  if (!brief || typeof brief !== "object") return {};
  const b = brief as Record<string, unknown>;
  const countOf = (k: string): number => (Array.isArray(b[k]) ? (b[k] as unknown[]).length : 0);
  if (pack === "incident_pack") {
    return {
      root_cause_hypotheses: countOf("root_cause_hypotheses"),
      affected_surfaces: countOf("affected_surfaces"),
      timeline_clues: countOf("timeline_clues"),
      next_checks: countOf("next_checks"),
    };
  }
  if (pack === "repo_pack") {
    return {
      key_surfaces: countOf("key_surfaces"),
      risk_areas: countOf("risk_areas"),
      read_next: countOf("read_next"),
    };
  }
  // change_pack
  return {
    affected_surfaces: countOf("affected_surfaces"),
    likely_breakpoints: countOf("likely_breakpoints"),
    validation_checks: countOf("validation_checks"),
  };
}

/**
 * Extract metadata from a parsed artifact JSON. Returns null when the
 * shape doesn't match a known pack artifact — the scanner skips such
 * files silently rather than crashing on an unrelated .json file that
 * happens to sit in an artifact dir.
 */
export function metadataFromArtifact(obj: unknown, jsonPath: string): ArtifactMetadata | null {
  if (!obj || typeof obj !== "object") return null;
  const a = obj as Record<string, unknown>;
  if (!isKnownPack(a.pack)) return null;
  if (typeof a.slug !== "string" || typeof a.title !== "string" || typeof a.generated_at !== "string") return null;
  const brief =
    a.brief && typeof a.brief === "object"
      ? (a.brief as Record<string, unknown>)
      : undefined;
  const weak = typeof brief?.weak === "boolean" ? brief.weak : false;
  const evidence = brief && Array.isArray(brief.evidence) ? (brief.evidence as unknown[]).length : 0;
  const corpusUsed = (brief?.corpus_used as ArtifactMetadata["corpus_used"]) ?? null;
  const artifactBlock = a.artifact as { markdown_path?: unknown; json_path?: unknown } | undefined;
  const md_path = typeof artifactBlock?.markdown_path === "string" ? artifactBlock.markdown_path : jsonPath.replace(/\.json$/, ".md");
  const json_path = typeof artifactBlock?.json_path === "string" ? artifactBlock.json_path : jsonPath;
  return {
    pack: a.pack,
    slug: a.slug,
    title: a.title,
    created_at: a.generated_at,
    weak,
    corpus_used: corpusUsed,
    evidence_count: evidence,
    section_counts: extractSectionCounts(a.pack, brief),
    md_path,
    json_path,
  };
}

// ── Full scan ───────────────────────────────────────────────

async function safeListDir(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return [];
    return (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch (err) {
    // Don't throw — artifact scans should degrade gracefully when a dir is
    // unreadable (EACCES, transient I/O, etc.). But don't hide the reason
    // either: emit a structured stderr line so operators can diagnose
    // "why is my artifact missing?" without attaching a debugger.
    const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    const event = {
      kind: "artifact_scan_skip",
      ts: new Date().toISOString(),
      dir,
      code,
      message,
    };
    try {
      process.stderr.write(JSON.stringify(event) + "\n");
    } catch {
      // stderr itself broken — nothing useful to do.
    }
    return [];
  }
}

export interface ScanResult {
  /** Every artifact metadata discovered (including collision duplicates — callers decide how to handle). */
  all: ArtifactMetadata[];
  /** (pack, slug) pairs that appear in more than one location. */
  duplicates: Array<{ pack: PackName; slug: string; paths: string[] }>;
}

/**
 * Walk the canonical pack dirs + any extras, extract metadata from
 * every .json file that matches the known-pack shape, and flag slug
 * collisions. Files that don't match a known pack shape are skipped
 * silently — artifact dirs may legitimately contain unrelated JSON.
 */
export async function scanAllArtifacts(opts: ScanOptions = {}): Promise<ScanResult> {
  const dirs = new Set<string>();
  // Canonical per-pack dirs.
  for (const d of Object.values(canonicalPackDirs())) dirs.add(normalize(d));
  // Extras.
  for (const d of opts.extra_artifact_dirs ?? []) dirs.add(safeNormalizePath(d));

  const all: ArtifactMetadata[] = [];
  for (const dir of dirs) {
    const files = await safeListDir(dir);
    for (const fname of files) {
      const full = resolve(join(dir, fname));
      let raw: string;
      try {
        raw = await readFile(full, "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const meta = metadataFromArtifact(parsed, full);
      if (meta) all.push(meta);
    }
  }

  // Detect duplicates on (pack, slug).
  const seen = new Map<string, ArtifactMetadata[]>();
  for (const m of all) {
    const key = `${m.pack}::${m.slug}`;
    const arr = seen.get(key) ?? [];
    arr.push(m);
    seen.set(key, arr);
  }
  const duplicates: ScanResult["duplicates"] = [];
  for (const [key, arr] of seen.entries()) {
    if (arr.length > 1) {
      const [pack, slug] = key.split("::") as [PackName, string];
      duplicates.push({ pack, slug, paths: arr.map((m) => m.json_path) });
    }
  }

  return { all, duplicates };
}

// ── Identity resolution ─────────────────────────────────────

/**
 * Look up a single artifact by (pack, slug). Fails loud on collision
 * so callers never unknowingly pick one of several candidates.
 */
export async function resolveArtifactByIdentity(
  pack: PackName,
  slug: string,
  opts: ScanOptions = {},
): Promise<ArtifactMetadata> {
  const scan = await scanAllArtifacts(opts);
  const matches = scan.all.filter((m) => m.pack === pack && m.slug === slug);
  if (matches.length === 0) {
    throw new InternError(
      "SOURCE_PATH_NOT_FOUND",
      `No artifact found for pack="${pack}" slug="${slug}".`,
      "Check artifact_list for what's available, or pass extra_artifact_dirs if the artifact lives outside the canonical dirs.",
      false,
    );
  }
  if (matches.length > 1) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Ambiguous artifact identity pack="${pack}" slug="${slug}" — found ${matches.length} candidates: ${matches.map((m) => m.json_path).join(", ")}`,
      "Slug collisions within a pack are never resolved automatically. Rename or remove the duplicate before reading by identity, or use json_path to pick one explicitly.",
      false,
    );
  }
  return matches[0];
}

/**
 * Read the full artifact JSON at a validated path.
 * Path must be absolute, must end in .json, and must live under a
 * recognized artifact dir (canonical roots + extras).
 */
export async function readArtifactAtPath(
  absPath: string,
  opts: ScanOptions = {},
): Promise<PackArtifact> {
  const normalized = safeNormalizePath(absPath);
  if (!normalized.endsWith(".json")) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Artifact path must end in .json: ${absPath}`,
      "Pass the json_path from an artifact_list entry, not the markdown path.",
      false,
    );
  }
  assertPathUnderAllowedDir(normalized, opts.extra_artifact_dirs ?? []);
  if (!existsSync(normalized)) {
    throw new InternError(
      "SOURCE_PATH_NOT_FOUND",
      `Artifact file does not exist: ${absPath}`,
      "Check the path — the file may have been moved or deleted. Run `ollama_artifact_list` to see current (pack, slug) pairs, or re-run the pack that produced this artifact to regenerate it.",
      false,
    );
  }
  const raw = await readFile(normalized, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Artifact JSON is malformed at ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
      "Re-run the pack that produced this artifact, or delete the malformed file.",
      false,
    );
  }
  if (!parsed || typeof parsed !== "object" || !isKnownPack((parsed as { pack?: unknown }).pack)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `File at ${absPath} is not a recognized pack artifact.`,
      "The file's pack field must be one of: incident_pack, repo_pack, change_pack.",
      false,
    );
  }
  return parsed as PackArtifact;
}
