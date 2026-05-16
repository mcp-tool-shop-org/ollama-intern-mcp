/**
 * Confidence guardrail — `ollama_classify` returns a {label, confidence} shape.
 * Below the threshold the label is stripped (returned as null) rather than
 * let a weak guess propagate.
 *
 * Stage C — fail-closed by default.
 *
 * Earlier this module shipped with `allow_none` defaulting to `undefined`
 * (treated as false), which meant the default behavior was to RETURN the
 * weak label even when below threshold. Every other guardrail in this
 * directory (bannedPhrases, citations, compileCheck, writeConfirm) fails
 * CLOSED — refuse the questionable output and tell the caller why. The
 * confidence guardrail was the lone fail-open.
 *
 * Stage C flips the default to fail-closed: `allow_none` defaults to true,
 * so the default behavior is "below threshold → label=null". Callers that
 * deliberately want the weak label propagated must opt in via
 * `allow_none: false`. The shape (ClassifyGuarded) is unchanged — the
 * `below_threshold` and `confidence` fields still carry the raw signal
 * for callers that want to do their own thing.
 *
 * Behavior change callout: existing callers that never passed `allow_none`
 * will now see `label: null` on below-threshold classifications instead of
 * the weak label. The `below_threshold: true` flag tells them why.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Phase 7 / FT-001 event-emission pattern (corpus-guards lock):
 * ─────────────────────────────────────────────────────────────────────
 * `buildConfidenceStripEvent(raw, guarded)` returns a self-describing
 * event detail carrying `op: 'guardrail'` + `rule: 'confidence_strip'`
 * (closed enum from observability.CorrelationOp). It does NOT carry
 * `run_id` directly — the NDJSON logger auto-merges that from the active
 * AsyncLocalStorage `CorrelationContext` at write time
 * (see observability.withCorrelation). Callers should NOT thread run_id
 * by hand; the pattern is:
 *
 *   const detail = buildConfidenceStripEvent(raw, guarded);
 *   if (detail) await ctx.logger.log({ kind: 'guardrail', ts: ...,
 *     tool: 'ollama_classify', rule: detail.rule, action: 'strip',
 *     detail });
 *
 * Wiring this into the call site is the tools agent's job (see
 * src/tools/classify.ts). This module only builds the detail shape.
 */

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export interface ClassifyRaw {
  label: string | null;
  confidence: number;
}

export interface ClassifyGuarded {
  label: string | null;
  confidence: number;
  below_threshold: boolean;
  threshold: number;
}

/**
 * Detail payload for an operator-facing structured event emitted when the
 * confidence guardrail strips a weak label. Callers with a logger should
 * wrap this in `{ kind: "guardrail", rule: detail.rule, action: "strip",
 * detail: buildConfidenceStripEvent(...) }` so an operator grepping the
 * NDJSON log can see WHY a label was stripped (the raw model output) and
 * not just THAT one was stripped.
 *
 * Phase 7 / FT-001: `op` and `rule` are stamped on the detail so that
 * every guardrail event in the NDJSON log can be filtered uniformly with
 * `jq 'select(.op=="guardrail" and .detail.rule=="confidence_strip")'`
 * regardless of which call site emitted it. The wrapper event still
 * carries its own `kind`/`rule`/`action` for back-compat with existing
 * log_tail consumers; the new fields are additive.
 */
export interface ConfidenceStripEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. Always 'guardrail' here. */
  op: "guardrail";
  /** Stable rule identifier — greppable. */
  rule: "confidence_strip";
  raw_label: string | null;
  raw_confidence: number;
  threshold: number;
  decision: "below_threshold";
}

export function applyConfidenceThreshold(
  raw: ClassifyRaw,
  opts: { threshold?: number; allow_none?: boolean } = {},
): ClassifyGuarded {
  const threshold = opts.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const belowThreshold = raw.confidence < threshold;
  // Default fail-closed: callers that want the weak-label propagation
  // must opt in via `allow_none: false`. Previous default was fail-open
  // (returned the weak label silently), inconsistent with every other
  // guardrail in this dir. See module header for rationale.
  const allowNone = opts.allow_none ?? true;
  const label = belowThreshold && allowNone ? null : raw.label;
  return {
    label,
    confidence: raw.confidence,
    below_threshold: belowThreshold,
    threshold,
  };
}

/**
 * Build the structured-event detail for an operator log entry when the
 * guardrail stripped a label. Returns null when nothing was stripped, so
 * callers can do `const d = buildConfidenceStripEvent(raw, guarded); if
 * (d) logger.log({kind:"guardrail", rule:"confidence", action:"strip",
 * detail: d})` without an extra branch.
 *
 * Captures the raw model output (label + confidence) AND the threshold so
 * an operator reading log_tail can answer "what did the model produce
 * before the guardrail intervened?" without re-running the call.
 */
export function buildConfidenceStripEvent(
  raw: ClassifyRaw,
  guarded: ClassifyGuarded,
): ConfidenceStripEventDetail | null {
  if (guarded.label !== null) return null; // not stripped
  if (raw.label === null) return null; // model emitted null; not a strip
  return {
    op: "guardrail",
    rule: "confidence_strip",
    raw_label: raw.label,
    raw_confidence: raw.confidence,
    threshold: guarded.threshold,
    decision: "below_threshold",
  };
}
