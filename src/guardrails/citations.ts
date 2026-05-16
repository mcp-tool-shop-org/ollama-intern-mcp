/**
 * Citation guardrail — `ollama_research` must only cite paths that were
 * provided in its source_paths input. Anything else is a fabrication and
 * gets stripped server-side before returning to the caller.
 *
 * line_range guardrail (added in the abstention slice): when the caller
 * threads in a line-count map keyed by normalized path, we additionally
 * check the cited range falls within the actual file. Out-of-bounds
 * ranges are silently dropped from the citation (path is kept) and a
 * warning is appended to the result envelope.
 *
 * Humanization (Stage C): callers that emit a `kind: "guardrail"` event
 * after a strip should use `buildCitationStripEventDetails` to attach
 * per-path detail (path + reason) rather than a single { count } field.
 * Currently research.ts logs only `{ count: warnings.length }` which is
 * useless for grep — an operator can't find WHICH path the model
 * fabricated without re-running. The per-strip detail makes log_tail
 * actionable.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Phase 7 / FT-001 event-emission pattern (corpus-guards lock):
 * ─────────────────────────────────────────────────────────────────────
 * `buildCitationStripEventDetails(result)` returns one detail object per
 * stripped citation, each tagged with `op: 'guardrail'` (closed enum from
 * observability.CorrelationOp) and `rule: 'citation_strip'`. As with the
 * confidence helper, this module does NOT stamp `run_id`. The NDJSON
 * logger auto-merges `run_id` from the active AsyncLocalStorage
 * `CorrelationContext` at write time (see observability.withCorrelation),
 * so call sites only have to log the event and the correlation lands
 * automatically.
 *
 * Wiring this into the call site is the tools agent's job (see
 * src/tools/research.ts). Pattern:
 *
 *   const details = buildCitationStripEventDetails(result);
 *   for (const detail of details) {
 *     await ctx.logger.log({ kind: 'guardrail', ts: ...,
 *       tool: 'ollama_research', rule: detail.rule, action: 'strip',
 *       detail });
 *   }
 *
 * Per-strip events (one per stripped citation) are preferred to a single
 * `{ count }` event so an operator grepping `log_tail` can find WHICH
 * path was fabricated, not just the cardinality.
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
  /**
   * Citations whose line_range was dropped because it pointed past EOF.
   * The path-only citation is still emitted in `valid`. Callers should
   * surface these as warnings without failing the call — the model still
   * pointed at the right file, just at non-existent lines.
   */
  out_of_bounds_ranges: Array<{ path: string; line_range: string; file_lines: number }>;
}

interface ParsedRange { start: number; end: number }

function parseLineRange(raw: string): ParsedRange | null {
  const m = raw.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 1 || end < start) return null;
  return { start, end };
}

/**
 * Strip any citation whose path is not in allowedPaths.
 * Comparison is on normalized paths — forward slashes, no leading ./.
 *
 * When `linesByPath` is supplied (keyed by normalized path), line_range
 * values that point beyond the file's actual line count have their range
 * dropped (path-only citation is preserved) and the case recorded in
 * `out_of_bounds_ranges` for the handler to surface as a warning.
 */
export function validateCitations(
  citations: RawCitation[],
  allowedPaths: string[],
  linesByPath?: Map<string, number>,
): CitationValidationResult {
  const allowed = new Set(allowedPaths.map(normalizePath));
  const valid: ValidatedCitation[] = [];
  const stripped: RawCitation[] = [];
  const out_of_bounds_ranges: CitationValidationResult["out_of_bounds_ranges"] = [];
  for (const c of citations) {
    const norm = normalizePath(c.path);
    if (!allowed.has(norm)) {
      stripped.push(c);
      continue;
    }
    let line_range = c.line_range;
    if (line_range && linesByPath) {
      const lineCount = linesByPath.get(norm);
      if (typeof lineCount === "number") {
        const parsed = parseLineRange(line_range);
        // Drop only when we could parse it AND the end exceeds the file —
        // unparseable ranges fall through unchanged (matches earlier
        // permissive behavior; range strings have always been free-form).
        if (parsed && parsed.end > lineCount) {
          out_of_bounds_ranges.push({ path: c.path, line_range, file_lines: lineCount });
          line_range = undefined;
        }
      }
    }
    valid.push({ path: c.path, ...(line_range ? { line_range } : {}) });
  }
  return { valid, stripped, out_of_bounds_ranges };
}

/**
 * Per-strip detail payload for an operator-facing structured event.
 * Callers that emit `{ kind: "guardrail", rule: detail.rule, action:
 * "strip", detail: ... }` should use this to surface WHICH path was
 * stripped and why, instead of an opaque `{ count }`.
 *
 * Phase 7 / FT-001: `op` and `rule` are stamped on the detail so every
 * guardrail event in the NDJSON log can be filtered uniformly with
 * `jq 'select(.op=="guardrail" and .detail.rule=="citation_strip")'`
 * regardless of which call site emitted it.
 */
export interface CitationStripEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. Always 'guardrail' here. */
  op: "guardrail";
  /** Stable rule identifier — greppable. */
  rule: "citation_strip";
  /** Reason buckets are closed; an operator can grep for "not_in_source_paths". */
  reason: "not_in_source_paths" | "line_range_past_eof";
  path: string;
  /** Only set for line_range_past_eof — the offending range. */
  line_range?: string;
  /** Only set for line_range_past_eof — the file's actual line count. */
  file_lines?: number;
}

/**
 * Build per-strip event details from a CitationValidationResult so a
 * caller with a logger can emit one structured event per stripped item
 * rather than a single count. Returns an empty array when nothing was
 * stripped so callers can iterate without a branch.
 *
 * Two reason buckets: `not_in_source_paths` (the model fabricated a
 * citation outside the caller-declared source list — full strip) and
 * `line_range_past_eof` (the path is real but the range pointed past
 * EOF — only the range was dropped, path was preserved).
 */
export function buildCitationStripEventDetails(
  result: CitationValidationResult,
): CitationStripEventDetail[] {
  const details: CitationStripEventDetail[] = [];
  for (const s of result.stripped) {
    details.push({
      op: "guardrail",
      rule: "citation_strip",
      reason: "not_in_source_paths",
      path: s.path,
    });
  }
  for (const r of result.out_of_bounds_ranges) {
    details.push({
      op: "guardrail",
      rule: "citation_strip",
      reason: "line_range_past_eof",
      path: r.path,
      line_range: r.line_range,
      file_lines: r.file_lines,
    });
  }
  return details;
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
