/**
 * Confidence guardrail — `ollama_classify` returns a {label, confidence} shape.
 * Below the threshold and with allow_none=true, we return label=null rather
 * than let a weak guess propagate.
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

export function applyConfidenceThreshold(
  raw: ClassifyRaw,
  opts: { threshold?: number; allow_none?: boolean } = {},
): ClassifyGuarded {
  const threshold = opts.threshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const belowThreshold = raw.confidence < threshold;
  const label = belowThreshold && opts.allow_none ? null : raw.label;
  return {
    label,
    confidence: raw.confidence,
    below_threshold: belowThreshold,
    threshold,
  };
}
