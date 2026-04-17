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
    items.push({
      id: `e${nextId++}`,
      kind: "corpus",
      ref: `${h.path}#${h.chunk_index}`,
      excerpt: (h.preview ?? "").slice(0, EVIDENCE_CONFIG.CORPUS_EXCERPT_CHARS),
    });
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
