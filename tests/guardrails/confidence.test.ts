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

  // ── Table-driven edge cases ──────────────────────────────────
  // Behaviors documented against the actual module contract:
  //   - Threshold comparison is strict `<` (boundary equality passes).
  //   - Module is a pure passthrough for label/confidence — no clamping,
  //     no validation. Callers upstream are responsible for shape.
  //   - allow_none nulls the label only when below_threshold is true.

  describe("boundary confidence values (table-driven)", () => {
    const cases = [
      { name: "exactly at default threshold → passes (strict <)",       conf: 0.7, threshold: undefined, allow_none: true,  expectBelow: false, expectLabel: "x" },
      { name: "just below default threshold → null with allow_none",   conf: 0.6999999, threshold: undefined, allow_none: true, expectBelow: true, expectLabel: null },
      { name: "exactly at custom threshold → passes (strict <)",       conf: 0.5, threshold: 0.5, allow_none: true,  expectBelow: false, expectLabel: "x" },
      { name: "zero confidence with allow_none=true → null",            conf: 0.0, threshold: undefined, allow_none: true,  expectBelow: true,  expectLabel: null },
      { name: "zero confidence without allow_none → kept",              conf: 0.0, threshold: undefined, allow_none: false, expectBelow: true,  expectLabel: "x" },
      { name: "perfect 1.0 confidence → passes",                        conf: 1.0, threshold: undefined, allow_none: true,  expectBelow: false, expectLabel: "x" },
      // Observable behavior for out-of-range values: no clamping, no
      // rejection — the module is a passthrough. Documenting that so a
      // future "silent clamp" change will break this test.
      { name: "negative confidence → treated as below, passthrough",    conf: -0.5, threshold: undefined, allow_none: true,  expectBelow: true, expectLabel: null },
      { name: "confidence > 1 → treated as above, passthrough",         conf: 1.5, threshold: undefined, allow_none: true,  expectBelow: false, expectLabel: "x" },
      { name: "NaN confidence → NaN < n is false → not below",          conf: NaN, threshold: undefined, allow_none: true,  expectBelow: false, expectLabel: "x" },
    ] as const;

    for (const c of cases) {
      it(c.name, () => {
        const r = applyConfidenceThreshold(
          { label: "x", confidence: c.conf },
          { threshold: c.threshold, allow_none: c.allow_none },
        );
        expect(r.below_threshold).toBe(c.expectBelow);
        expect(r.label).toBe(c.expectLabel);
        // confidence is always preserved unchanged (no clamping).
        if (Number.isNaN(c.conf)) {
          expect(Number.isNaN(r.confidence)).toBe(true);
        } else {
          expect(r.confidence).toBe(c.conf);
        }
      });
    }
  });

  describe("null label from model (model omits / refuses)", () => {
    it("null label + high confidence → label stays null, not below threshold", () => {
      const r = applyConfidenceThreshold({ label: null, confidence: 0.95 });
      expect(r.label).toBeNull();
      expect(r.below_threshold).toBe(false);
    });

    it("null label + low confidence + allow_none → label stays null", () => {
      const r = applyConfidenceThreshold({ label: null, confidence: 0.1 }, { allow_none: true });
      expect(r.label).toBeNull();
      expect(r.below_threshold).toBe(true);
    });

    it("null label + low confidence without allow_none → label stays null (no upgrade)", () => {
      const r = applyConfidenceThreshold({ label: null, confidence: 0.1 });
      expect(r.label).toBeNull();
      expect(r.below_threshold).toBe(true);
    });
  });

  describe("threshold reporting", () => {
    it("reports default threshold when none provided", () => {
      const r = applyConfidenceThreshold({ label: "a", confidence: 0.8 });
      expect(r.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    });

    it("reports custom threshold verbatim", () => {
      const r = applyConfidenceThreshold({ label: "a", confidence: 0.8 }, { threshold: 0.42 });
      expect(r.threshold).toBe(0.42);
    });

    it("threshold=0 is honored (nothing is ever below)", () => {
      const r = applyConfidenceThreshold({ label: "a", confidence: 0.0 }, { threshold: 0, allow_none: true });
      expect(r.threshold).toBe(0);
      expect(r.below_threshold).toBe(false);
      expect(r.label).toBe("a");
    });

    it("threshold=1 is honored (everything except exactly 1.0 is below)", () => {
      const atCeiling = applyConfidenceThreshold({ label: "a", confidence: 1.0 }, { threshold: 1, allow_none: true });
      expect(atCeiling.below_threshold).toBe(false);
      expect(atCeiling.label).toBe("a");
      const justUnder = applyConfidenceThreshold({ label: "a", confidence: 0.999 }, { threshold: 1, allow_none: true });
      expect(justUnder.below_threshold).toBe(true);
      expect(justUnder.label).toBeNull();
    });
  });
});
