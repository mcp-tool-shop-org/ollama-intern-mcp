/**
 * Artifact diff — pack-shaped structured comparison, not generic text diff.
 *
 * Laws:
 *   - Same-pack only. Cross-pack diffs throw loudly.
 *   - Lists diff as {added, removed, unchanged} matched on a primary key
 *     field per item kind. No "changed" bucket in this slice — keep it
 *     boring and legible.
 *   - Narrative fields diff as {before, after}. release_note_draft also
 *     carries a compact LCS line diff because that's where it materially
 *     helps review.
 *   - Evidence is summarized (counts + referenced paths + path delta),
 *     never exploded chunk-by-chunk.
 *   - Weak flip gets top billing — surfaced at the envelope level, not
 *     buried inside the per-field diff.
 *   - Deterministic ordering: every list is sorted by its primary key
 *     before returning.
 */

import { InternError } from "../../errors.js";
import type {
  PackArtifact,
  PackName,
} from "./scan.js";
import type { IncidentPackArtifact } from "../packs/incidentPack.js";
import type { RepoPackArtifact } from "../packs/repoPack.js";
import type { ChangePackArtifact } from "../packs/changePack.js";

// ── Common diff shapes ──────────────────────────────────────

export interface ListDiff<T> {
  added: T[];
  removed: T[];
  unchanged: T[];
}

export interface StringDiff {
  before: string;
  after: string;
}

export type LineOp = "same" | "add" | "remove";
export interface LineDiffEntry {
  op: LineOp;
  line: string;
}

export interface ReleaseNoteDiff extends StringDiff {
  line_diff: LineDiffEntry[];
}

export interface WeakFlip {
  a: boolean;
  b: boolean;
  flipped: boolean;
  /** Present only when flipped: "weakened" (strong → weak) or "strengthened" (weak → strong). */
  direction?: "weakened" | "strengthened";
}

export interface EvidenceSummary {
  a: { count: number; referenced_paths: string[] };
  b: { count: number; referenced_paths: string[] };
  path_delta: { added: string[]; removed: string[] };
}

// ── Pack-specific diff payloads ─────────────────────────────

export interface IncidentDiff {
  root_cause_hypotheses: ListDiff<{ hypothesis: string; confidence: string }>;
  affected_surfaces: ListDiff<{ surface: string }>;
  timeline_clues: ListDiff<{ clue: string }>;
  next_checks: ListDiff<{ check: string; why: string }>;
  coverage_notes: ListDiff<string>;
  evidence_summary: EvidenceSummary;
}

export interface ExtractedFactsDiff {
  a_present: boolean;
  b_present: boolean;
  package_names?: ListDiff<string>;
  entrypoints?: ListDiff<{ file: string; purpose: string }>;
  scripts?: ListDiff<{ name: string; command: string }>;
  config_files?: ListDiff<string>;
  exposed_surfaces?: ListDiff<string>;
  runtime_hints?: ListDiff<string>;
  scripts_touched?: ListDiff<string>;
  config_surfaces?: ListDiff<string>;
  /** runtime_hints is shared across repo + change packs — same shape. */
}

export interface RepoDiff {
  repo_thesis: StringDiff;
  architecture_shape: StringDiff;
  key_surfaces: ListDiff<{ surface: string; why: string }>;
  risk_areas: ListDiff<{ risk: string }>;
  read_next: ListDiff<{ file: string; why: string }>;
  coverage_notes: ListDiff<string>;
  extracted_facts: ExtractedFactsDiff;
  evidence_summary: EvidenceSummary;
}

export interface ChangeDiff {
  change_summary: StringDiff;
  why_it_matters: StringDiff;
  affected_surfaces: ListDiff<{ surface: string }>;
  likely_breakpoints: ListDiff<{ breakpoint: string }>;
  validation_checks: ListDiff<{ check: string; why: string }>;
  release_note_draft: ReleaseNoteDiff;
  coverage_notes: ListDiff<string>;
  extracted_facts: ExtractedFactsDiff;
  evidence_summary: EvidenceSummary;
}

export interface ArtifactDiffIdentity {
  slug: string;
  created_at: string;
  title: string;
}

export type ArtifactDiffResult =
  | ({ pack: "incident_pack"; a: ArtifactDiffIdentity; b: ArtifactDiffIdentity; weak: WeakFlip; diff: IncidentDiff })
  | ({ pack: "repo_pack"; a: ArtifactDiffIdentity; b: ArtifactDiffIdentity; weak: WeakFlip; diff: RepoDiff })
  | ({ pack: "change_pack"; a: ArtifactDiffIdentity; b: ArtifactDiffIdentity; weak: WeakFlip; diff: ChangeDiff });

// ── Shared helpers ──────────────────────────────────────────

/**
 * Diff two lists of items using a primary-key function. Items present
 * in both (by key) appear in `unchanged` with the B-side value. Sorts
 * every bucket by the primary key for deterministic output.
 */
function diffListByKey<T>(
  a: T[],
  b: T[],
  keyOf: (item: T) => string,
): ListDiff<T> {
  const aByKey = new Map<string, T>();
  const bByKey = new Map<string, T>();
  for (const item of a) aByKey.set(keyOf(item), item);
  for (const item of b) bByKey.set(keyOf(item), item);

  const added: T[] = [];
  const removed: T[] = [];
  const unchanged: T[] = [];
  for (const [key, item] of bByKey) {
    if (!aByKey.has(key)) added.push(item);
    else unchanged.push(item);
  }
  for (const [key, item] of aByKey) {
    if (!bByKey.has(key)) removed.push(item);
  }

  const sortFn = (x: T, y: T): number => {
    const kx = keyOf(x);
    const ky = keyOf(y);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  };
  return {
    added: added.sort(sortFn),
    removed: removed.sort(sortFn),
    unchanged: unchanged.sort(sortFn),
  };
}

/** String list is a list-of-strings with identity = the string itself. */
function diffStringList(a: readonly string[] | undefined, b: readonly string[] | undefined): ListDiff<string> {
  return diffListByKey([...(a ?? [])], [...(b ?? [])], (s) => s);
}

/**
 * Compact LCS-based line diff. Used only for release_note_draft where
 * it materially helps review. O(m*n); release notes are tiny so this
 * is trivial in practice.
 */
export function lineDiff(before: string, after: string): LineDiffEntry[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops: LineDiffEntry[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ op: "same", line: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ op: "add", line: b[j - 1] });
      j -= 1;
    } else {
      ops.unshift({ op: "remove", line: a[i - 1] });
      i -= 1;
    }
  }
  return ops;
}

/**
 * Pull path-like identity from a single evidence ref. Log refs don't
 * carry paths; corpus/diff refs encode them; path refs ARE paths.
 */
function pathFromEvidenceRef(kind: string, ref: string): string | null {
  if (kind === "path") return ref;
  if (kind === "corpus") {
    const hashIdx = ref.indexOf("#");
    return hashIdx > 0 ? ref.slice(0, hashIdx) : ref;
  }
  if (kind === "diff") {
    if (ref === "diff") return null;
    if (ref.startsWith("diff:")) return ref.slice("diff:".length);
    return null;
  }
  return null;
}

function referencedPaths(evidence: Array<{ kind: string; ref: string }>): string[] {
  const set = new Set<string>();
  for (const e of evidence) {
    const p = pathFromEvidenceRef(e.kind, e.ref);
    if (p) set.add(p);
  }
  return [...set].sort();
}

function evidenceSummary(
  a: Array<{ kind: string; ref: string }>,
  b: Array<{ kind: string; ref: string }>,
): EvidenceSummary {
  const pathsA = referencedPaths(a);
  const pathsB = referencedPaths(b);
  const setA = new Set(pathsA);
  const setB = new Set(pathsB);
  return {
    a: { count: a.length, referenced_paths: pathsA },
    b: { count: b.length, referenced_paths: pathsB },
    path_delta: {
      added: pathsB.filter((p) => !setA.has(p)).sort(),
      removed: pathsA.filter((p) => !setB.has(p)).sort(),
    },
  };
}

function computeWeakFlip(aWeak: boolean, bWeak: boolean): WeakFlip {
  const flipped = aWeak !== bWeak;
  const result: WeakFlip = { a: aWeak, b: bWeak, flipped };
  if (flipped) {
    result.direction = bWeak ? "weakened" : "strengthened";
  }
  return result;
}

// ── Per-pack diff functions ─────────────────────────────────

function diffIncident(a: IncidentPackArtifact, b: IncidentPackArtifact): IncidentDiff {
  const ab = a.brief;
  const bb = b.brief;
  return {
    root_cause_hypotheses: diffListByKey(
      ab.root_cause_hypotheses.map((h) => ({ hypothesis: h.hypothesis, confidence: h.confidence })),
      bb.root_cause_hypotheses.map((h) => ({ hypothesis: h.hypothesis, confidence: h.confidence })),
      (h) => h.hypothesis,
    ),
    affected_surfaces: diffListByKey(
      ab.affected_surfaces.map((s) => ({ surface: s.surface })),
      bb.affected_surfaces.map((s) => ({ surface: s.surface })),
      (s) => s.surface,
    ),
    timeline_clues: diffListByKey(
      ab.timeline_clues.map((c) => ({ clue: c.clue })),
      bb.timeline_clues.map((c) => ({ clue: c.clue })),
      (c) => c.clue,
    ),
    next_checks: diffListByKey(
      ab.next_checks.map((c) => ({ check: c.check, why: c.why })),
      bb.next_checks.map((c) => ({ check: c.check, why: c.why })),
      (c) => c.check,
    ),
    coverage_notes: diffStringList(ab.coverage_notes, bb.coverage_notes),
    evidence_summary: evidenceSummary(ab.evidence, bb.evidence),
  };
}

function diffRepoExtractedFacts(
  a: RepoPackArtifact["extracted_facts"],
  b: RepoPackArtifact["extracted_facts"],
): ExtractedFactsDiff {
  const result: ExtractedFactsDiff = {
    a_present: a !== null,
    b_present: b !== null,
  };
  if (a === null || b === null) return result;
  result.package_names = diffStringList(a.package_names, b.package_names);
  result.entrypoints = diffListByKey(
    (a.entrypoints ?? []).map((e) => ({ file: e.file ?? "", purpose: e.purpose ?? "" })),
    (b.entrypoints ?? []).map((e) => ({ file: e.file ?? "", purpose: e.purpose ?? "" })),
    (e) => e.file,
  );
  result.scripts = diffListByKey(
    (a.scripts ?? []).map((s) => ({ name: s.name ?? "", command: s.command ?? "" })),
    (b.scripts ?? []).map((s) => ({ name: s.name ?? "", command: s.command ?? "" })),
    (s) => s.name,
  );
  result.config_files = diffStringList(a.config_files, b.config_files);
  result.exposed_surfaces = diffStringList(a.exposed_surfaces, b.exposed_surfaces);
  result.runtime_hints = diffStringList(a.runtime_hints, b.runtime_hints);
  return result;
}

function diffChangeExtractedFacts(
  a: ChangePackArtifact["extracted_facts"],
  b: ChangePackArtifact["extracted_facts"],
): ExtractedFactsDiff {
  const result: ExtractedFactsDiff = {
    a_present: a !== null,
    b_present: b !== null,
  };
  if (a === null || b === null) return result;
  result.scripts_touched = diffStringList(a.scripts_touched, b.scripts_touched);
  result.config_surfaces = diffStringList(a.config_surfaces, b.config_surfaces);
  result.runtime_hints = diffStringList(a.runtime_hints, b.runtime_hints);
  return result;
}

function diffRepo(a: RepoPackArtifact, b: RepoPackArtifact): RepoDiff {
  const ab = a.brief;
  const bb = b.brief;
  return {
    repo_thesis: { before: ab.repo_thesis, after: bb.repo_thesis },
    architecture_shape: { before: ab.architecture_shape, after: bb.architecture_shape },
    key_surfaces: diffListByKey(
      ab.key_surfaces.map((s) => ({ surface: s.surface, why: s.why })),
      bb.key_surfaces.map((s) => ({ surface: s.surface, why: s.why })),
      (s) => s.surface,
    ),
    risk_areas: diffListByKey(
      ab.risk_areas.map((r) => ({ risk: r.risk })),
      bb.risk_areas.map((r) => ({ risk: r.risk })),
      (r) => r.risk,
    ),
    read_next: diffListByKey(
      ab.read_next.map((r) => ({ file: r.file, why: r.why })),
      bb.read_next.map((r) => ({ file: r.file, why: r.why })),
      (r) => r.file,
    ),
    coverage_notes: diffStringList(ab.coverage_notes, bb.coverage_notes),
    extracted_facts: diffRepoExtractedFacts(a.extracted_facts, b.extracted_facts),
    evidence_summary: evidenceSummary(ab.evidence, bb.evidence),
  };
}

function diffChange(a: ChangePackArtifact, b: ChangePackArtifact): ChangeDiff {
  const ab = a.brief;
  const bb = b.brief;
  return {
    change_summary: { before: ab.change_summary, after: bb.change_summary },
    why_it_matters: { before: ab.why_it_matters, after: bb.why_it_matters },
    affected_surfaces: diffListByKey(
      ab.affected_surfaces.map((s) => ({ surface: s.surface })),
      bb.affected_surfaces.map((s) => ({ surface: s.surface })),
      (s) => s.surface,
    ),
    likely_breakpoints: diffListByKey(
      ab.likely_breakpoints.map((bp) => ({ breakpoint: bp.breakpoint })),
      bb.likely_breakpoints.map((bp) => ({ breakpoint: bp.breakpoint })),
      (bp) => bp.breakpoint,
    ),
    validation_checks: diffListByKey(
      ab.validation_checks.map((c) => ({ check: c.check, why: c.why })),
      bb.validation_checks.map((c) => ({ check: c.check, why: c.why })),
      (c) => c.check,
    ),
    release_note_draft: {
      before: ab.release_note_draft,
      after: bb.release_note_draft,
      line_diff: lineDiff(ab.release_note_draft, bb.release_note_draft),
    },
    coverage_notes: diffStringList(ab.coverage_notes, bb.coverage_notes),
    extracted_facts: diffChangeExtractedFacts(a.extracted_facts, b.extracted_facts),
    evidence_summary: evidenceSummary(ab.evidence, bb.evidence),
  };
}

// ── Public entry ────────────────────────────────────────────

function identityOf(art: PackArtifact): ArtifactDiffIdentity {
  return { slug: art.slug, created_at: art.generated_at, title: art.title };
}

export function diffArtifacts(
  a: PackArtifact,
  b: PackArtifact,
): ArtifactDiffResult {
  if (a.pack !== b.pack) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Cross-pack diff refused: a.pack="${a.pack}" vs b.pack="${b.pack}"`,
      "artifact_diff compares within a single pack only (incident ↔ incident, repo ↔ repo, change ↔ change). Pack payloads stay distinct by design.",
      false,
    );
  }
  // Schema-version gate: comparing artifacts written by different pack
  // schema revisions would silently produce bogus diffs (new fields
  // rendered as `added`, removed fields as `removed`, etc.). Refuse loud.
  const aVer = (a as unknown as { schema_version?: unknown }).schema_version;
  const bVer = (b as unknown as { schema_version?: unknown }).schema_version;
  if (typeof aVer !== "number" || typeof bVer !== "number") {
    throw new InternError(
      "SCHEMA_INVALID",
      `artifact_diff refused: missing schema_version on ${typeof aVer !== "number" ? "a" : "b"} (a=${aVer}, b=${bVer}).`,
      "Use artifact_read on each artifact to confirm its schema_version. Pre-schema_version artifacts need to be re-produced by the current pack — schema drift would turn the diff into noise.",
      false,
    );
  }
  if (aVer !== bVer) {
    throw new InternError(
      "SCHEMA_INVALID",
      `artifact_diff refused: schema_version mismatch (a=${aVer}, b=${bVer}).`,
      "Use artifact_read on each artifact to inspect their shapes. Cross-schema diffs would render renamed/added fields as false 'added'/'removed' deltas — re-run the pack on the older artifact to bring it up to the current schema before diffing.",
      false,
    );
  }
  const weak = computeWeakFlip(a.brief.weak, b.brief.weak);
  const packName: PackName = a.pack;
  if (packName === "incident_pack") {
    const ai = a as IncidentPackArtifact;
    const bi = b as IncidentPackArtifact;
    return {
      pack: "incident_pack",
      a: identityOf(ai),
      b: identityOf(bi),
      weak,
      diff: diffIncident(ai, bi),
    };
  }
  if (packName === "repo_pack") {
    const ar = a as RepoPackArtifact;
    const br = b as RepoPackArtifact;
    return {
      pack: "repo_pack",
      a: identityOf(ar),
      b: identityOf(br),
      weak,
      diff: diffRepo(ar, br),
    };
  }
  // change_pack
  const ac = a as ChangePackArtifact;
  const bc = b as ChangePackArtifact;
  return {
    pack: "change_pack",
    a: identityOf(ac),
    b: identityOf(bc),
    weak,
    diff: diffChange(ac, bc),
  };
}
