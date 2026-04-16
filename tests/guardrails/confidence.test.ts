import { describe, it, expect } from "vitest";
import {
  applyConfidenceThreshold,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "../../src/guardrails/confidence.js";

describe("applyConfidenceThreshold", () => {
  it("passes through high-confidence labels unchanged", () => {
    const r = applyConfidenceThreshold({ label: "bug", confidence: 0.9 });
    expect(r.label).toBe("bug");
    expect(r.below_threshold).toBe(false);
    expect(r.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it("keeps weak labels by default (no allow_none)", () => {
    const r = applyConfidenceThreshold({ label: "bug", confidence: 0.3 });
    expect(r.label).toBe("bug");
    expect(r.below_threshold).toBe(true);
  });

  it("nulls out weak labels when allow_none=true", () => {
    const r = applyConfidenceThreshold({ label: "bug", confidence: 0.3 }, { allow_none: true });
    expect(r.label).toBeNull();
    expect(r.below_threshold).toBe(true);
  });

  it("respects custom threshold", () => {
    const high = applyConfidenceThreshold({ label: "x", confidence: 0.6 }, { threshold: 0.5, allow_none: true });
    expect(high.label).toBe("x");
    const low = applyConfidenceThreshold({ label: "x", confidence: 0.4 }, { threshold: 0.5, allow_none: true });
    expect(low.label).toBeNull();
  });

  it("preserves confidence value regardless of threshold outcome", () => {
    const r = applyConfidenceThreshold({ label: "bug", confidence: 0.3 }, { allow_none: true });
    expect(r.confidence).toBe(0.3);
  });
});
