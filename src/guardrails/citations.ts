/**
 * Citation guardrail — `ollama_research` must only cite paths that were
 * provided in its source_paths input. Anything else is a fabrication and
 * gets stripped server-side before returning to the caller.
 */

import { normalizePath } from "../protectedPaths.js";

export interface RawCitation {
  path: string;
  line_range?: string;
}

export interface ValidatedCitation {
  path: string;
  line_range?: string;
}

export interface CitationValidationResult {
  valid: ValidatedCitation[];
  stripped: RawCitation[];
}

/**
 * Strip any citation whose path is not in allowedPaths.
 * Comparison is on normalized paths — forward slashes, no leading ./.
 */
export function validateCitations(
  citations: RawCitation[],
  allowedPaths: string[],
): CitationValidationResult {
  const allowed = new Set(allowedPaths.map(normalizePath));
  const valid: ValidatedCitation[] = [];
  const stripped: RawCitation[] = [];
  for (const c of citations) {
    if (allowed.has(normalizePath(c.path))) {
      valid.push({ path: c.path, ...(c.line_range ? { line_range: c.line_range } : {}) });
    } else {
      stripped.push(c);
    }
  }
  return { valid, stripped };
}

/**
 * Extract citations from a model's free-text "Sources:" block.
 * Accepts formats like `path.md:10-25` or `path.md (lines 10-25)`.
 */
export function parseCitations(text: string): RawCitation[] {
  const lines = text.split("\n");
  const citations: RawCitation[] = [];
  const pathLine = /^[-*\s]*([^\s:()]+(?:\.[a-z0-9]+)?)(?::(\d+(?:-\d+)?)|\s*\(lines?\s+(\d+(?:-\d+)?)\))?/i;
  for (const line of lines) {
    const m = line.match(pathLine);
    if (m) {
      const path = m[1];
      const range = m[2] || m[3];
      if (path && (path.includes("/") || path.includes("."))) {
        citations.push({ path, ...(range ? { line_range: range } : {}) });
      }
    }
  }
  return citations;
}
