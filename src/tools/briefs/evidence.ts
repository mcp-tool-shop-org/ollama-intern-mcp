/**
 * Shared evidence types + slicers for operator-brief flagships.
 *
 * Evidence is first-class across every brief tool (incident_brief,
 * repo_brief, change_brief). Claim → evidence id → numbered source is
 * the grounding chain that keeps briefs from drifting into smooth prose
 * over vague retrieval.
 *
 * Four evidence kinds cover every primary input so far:
 *   log    — raw log blob, sliced into line-range windows
 *   diff   — unified-diff text, split per file on `diff --git` markers
 *   path   — file contents loaded server-side, one item per file
 *   corpus — chunks retrieved from a named corpus
 */

import type { CorpusHit } from "../../corpus/searcher.js";
import type { LoadedSource } from "../../sources.js";

export type EvidenceKind = "log" | "path" | "corpus" | "diff";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  ref: string;
  excerpt: string;
  /**
   * Retrieval relevance score. Populated for corpus-sourced items from the
   * underlying CorpusHit (cosine/RRF/lexical, mode-dependent). Absent for
   * log / diff / path evidence — those have no retrieval-time relevance
   * signal, only structural position.
   */
  score?: number;
  /**
   * Short LLM-generated rationale for why this corpus chunk matched. Only
   * present when corpus_search was called with `explain: true` upstream;
   * brief tools don't currently set explain, so this is reserved for
   * forward compatibility when assembleEvidence routes pre-explained hits
   * through.
   */
  why_matched?: string;
}

export const EVIDENCE_CONFIG = {
  LOG_CHUNK_LINES: 60,
  LOG_EXCERPT_CHARS: 400,
  PATH_EXCERPT_CHARS: 600,
  CORPUS_EXCERPT_CHARS: 500,
  DIFF_EXCERPT_CHARS: 700,
} as const;

export function sliceLogIntoEvidence(logText: string, startId: number): EvidenceItem[] {
  const lines = logText.split(/\r?\n/);
  const items: EvidenceItem[] = [];
  let cursor = 0;
  let nextId = startId;
  while (cursor < lines.length) {
    const end = Math.min(cursor + EVIDENCE_CONFIG.LOG_CHUNK_LINES, lines.length);
    const slice = lines.slice(cursor, end).join("\n");
    if (slice.trim().length > 0) {
      items.push({
        id: `e${nextId++}`,
        kind: "log",
        ref: `log:${cursor + 1}-${end}`,
        excerpt: slice.slice(0, EVIDENCE_CONFIG.LOG_EXCERPT_CHARS),
      });
    }
    cursor = end;
  }
  return items;
}

export function pathToEvidence(sources: LoadedSource[], startId: number): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let nextId = startId;
  for (const s of sources) {
    items.push({
      id: `e${nextId++}`,
      kind: "path",
      ref: s.path,
      excerpt: s.body.slice(0, EVIDENCE_CONFIG.PATH_EXCERPT_CHARS),
    });
  }
  return items;
}

export function corpusHitsToEvidence(hits: CorpusHit[], startId: number): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let nextId = startId;
  for (const h of hits) {
    const item: EvidenceItem = {
      id: `e${nextId++}`,
      kind: "corpus",
      ref: `${h.path}#${h.chunk_index}`,
      excerpt: (h.preview ?? "").slice(0, EVIDENCE_CONFIG.CORPUS_EXCERPT_CHARS),
      // Carry the retrieval score through so downstream callers can apply
      // a topicality threshold or surface relevance in coverage notes.
      // This is the dogfood fix: corpusSearch's real cosine/RRF score was
      // computed per chunk and then silently dropped at this seam.
      score: h.score,
    };
    // `why_matched` is forward-compatible only — CorpusHit doesn't carry
    // it today (corpus_search adds it at a higher layer when explain=true).
    // Defensive lookup so future routing through pre-explained hits
    // populates the field without further edits here.
    const why = (h as CorpusHit & { why_matched?: string }).why_matched;
    if (typeof why === "string" && why.length > 0) item.why_matched = why;
    items.push(item);
  }
  return items;
}

/**
 * Split a unified diff into per-file evidence items using `diff --git` as
 * the boundary marker. A diff without those markers is treated as one
 * blob — honest fallback rather than a silent per-file pretense.
 */
export function sliceDiffIntoEvidence(diffText: string, startId: number): EvidenceItem[] {
  const markerRx = /^diff --git a\/(\S+) b\/(\S+)/gm;
  const matches = [...diffText.matchAll(markerRx)];
  if (matches.length === 0) {
    if (diffText.trim().length === 0) return [];
    return [{
      id: `e${startId}`,
      kind: "diff",
      ref: "diff",
      excerpt: diffText.slice(0, EVIDENCE_CONFIG.DIFF_EXCERPT_CHARS),
    }];
  }
  const items: EvidenceItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? diffText.length : diffText.length;
    const text = diffText.slice(start, end);
    // Prefer the b/<path> side (destination file) for rename-aware refs.
    const path = m[2] ?? m[1] ?? "unknown";
    items.push({
      id: `e${startId + i}`,
      kind: "diff",
      ref: `diff:${path}`,
      excerpt: text.slice(0, EVIDENCE_CONFIG.DIFF_EXCERPT_CHARS),
    });
  }
  return items;
}

/**
 * The excerpt cap the slicer above applied when an item of this kind was
 * built. Renderers clip to THIS rather than a flat literal — a hard-coded
 * display cap below the build cap makes the human-readable .md half of an
 * artifact pair show less than the machine-readable .json half stored
 * beside it, while the pair is sold as one diffable unit.
 */
export function excerptCapFor(kind: EvidenceKind): number {
  switch (kind) {
    case "log":
      return EVIDENCE_CONFIG.LOG_EXCERPT_CHARS;
    case "path":
      return EVIDENCE_CONFIG.PATH_EXCERPT_CHARS;
    case "corpus":
      return EVIDENCE_CONFIG.CORPUS_EXCERPT_CHARS;
    case "diff":
      return EVIDENCE_CONFIG.DIFF_EXCERPT_CHARS;
  }
}

/**
 * Render one evidence item as markdown lines: `**[id]** kind — ref`, the
 * excerpt in a fence, then a truncation marker when the excerpt stops
 * short of its source.
 *
 * A fenced block reads as a verbatim quote, so an unmarked clip can stop
 * mid-word with nothing telling the reader evidence was cut. The slicers
 * clip at the per-kind cap, so an excerpt sitting AT the cap is the first
 * N chars of something longer — say so. Same convention as
 * codeCitation.excerptLines / hypothesisDrill's evidence previews, which
 * both mark a display clip rather than letting it pass silently.
 */
export function renderEvidenceMarkdown(e: EvidenceItem): string[] {
  const cap = excerptCapFor(e.kind);
  const shown = e.excerpt.slice(0, cap);
  const lines = [`**[${e.id}]** \`${e.kind}\` — \`${e.ref}\``, "", "```", shown, "```"];
  if (e.excerpt.length >= cap) {
    lines.push("");
    lines.push(`_Excerpt clipped to the first ${cap} chars of \`${e.ref}\`._`);
  }
  lines.push("");
  return lines;
}
