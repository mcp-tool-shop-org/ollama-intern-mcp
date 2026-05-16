import { describe, it, expect } from "vitest";
import {
  applyConfidenceThreshold,
  buildConfidenceStripEvent,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "../../src/guardrails/confidence.js";

describe("applyConfidenceThreshold", () => {
  it("passes through high-confidence labels unchanged", () => {
    const r = applyConfidenceThreshold({ label: "bug", confidence: 0.9 });
    expect(r.label).toBe("bug");
    expect(r.below_threshold).toBe(false);
    expect(r.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it("Stage C fail-closed default: weak labels return null when allow_none is omitted", () => {
    // Behavior change (Stage C / corpus-guards): allow_none now
    // defaults to TRUE, so the default treatment of a below-threshold
    // result is "null out the label". Previous behavior (label kept)
    // was the lone fail-open guardrail in this directory.
    const r = applyConfidenceThreshold({ label: "bug", confidence: 0.3 });
    expect(r.label).toBeNull();
    expect(r.below_threshold).toBe(true);
  });

  it("explicit allow_none:false opts back into the legacy fail-open behavior (weak label kept)", () => {
    // The pre-Stage-C default. Callers that NEED the weak label
    // propagated must now opt in explicitly. The below_threshold
    // signal still tells them why.
    const r = applyConfidenceThreshold({ label: "bug", confidence: 0.3 }, { allow_none: false });
    expect(r.label).toBe("bug");
    expect(r.below_threshold).toBe(true);
  });

  it("explicit allow_none:true matches the new default — weak labels return null", () => {
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

  // ── Stage C — fail-closed default coverage ─────────────────
  // Specifically pins the new default behavior so a future revert
  // (back to fail-open) breaks loud rather than silently shipping
  // weak labels into operator workflows again.
  describe("Stage C fail-closed default — no allow_none supplied", () => {
    it("below-threshold weak label is stripped (label=null) under the default", () => {
      const r = applyConfidenceThreshold({ label: "fix", confidence: 0.4 });
      expect(r).toMatchObject({
        label: null,
        below_threshold: true,
        confidence: 0.4,
        threshold: DEFAULT_CONFIDENCE_THRESHOLD,
      });
    });

    it("above-threshold label is kept under the default", () => {
      const r = applyConfidenceThreshold({ label: "fix", confidence: 0.9 });
      expect(r).toMatchObject({
        label: "fix",
        below_threshold: false,
        confidence: 0.9,
      });
    });

    it("at-threshold exact value passes (strict <) under the default", () => {
      const r = applyConfidenceThreshold({ label: "x", confidence: DEFAULT_CONFIDENCE_THRESHOLD });
      expect(r.label).toBe("x");
      expect(r.below_threshold).toBe(false);
    });

    it("explicit allow_none:false restores legacy weak-label-kept behavior (opt-out path)", () => {
      const r = applyConfidenceThreshold({ label: "x", confidence: 0.3 }, { allow_none: false });
      expect(r).toMatchObject({
        label: "x",
        below_threshold: true,
        confidence: 0.3,
      });
    });
  });
});

// ── Stage C — buildConfidenceStripEvent helper ───────────────
// The new helper produces a structured NDJSON detail payload so an
// operator reading log_tail can see WHY a label got stripped and what
// the raw model output was. Returns null when nothing was stripped, so
// callers can branch cheaply.

describe("buildConfidenceStripEvent", () => {
  it("returns the detail when a weak label was stripped", () => {
    const raw = { label: "fix", confidence: 0.3 };
    const guarded = applyConfidenceThreshold(raw); // fail-closed default
    const detail = buildConfidenceStripEvent(raw, guarded);
    expect(detail).toMatchObject({
      raw_label: "fix",
      raw_confidence: 0.3,
      threshold: DEFAULT_CONFIDENCE_THRESHOLD,
      decision: "below_threshold",
    });
  });

  it("returns null when no strip occurred (above threshold)", () => {
    const raw = { label: "fix", confidence: 0.95 };
    const guarded = applyConfidenceThreshold(raw);
    expect(buildConfidenceStripEvent(raw, guarded)).toBeNull();
  });

  it("returns null when the model itself emitted null (not a strip)", () => {
    const raw = { label: null, confidence: 0.2 };
    const guarded = applyConfidenceThreshold(raw);
    expect(buildConfidenceStripEvent(raw, guarded)).toBeNull();
  });

  it("returns null when allow_none:false kept the weak label (no strip happened)", () => {
    const raw = { label: "fix", confidence: 0.3 };
    const guarded = applyConfidenceThreshold(raw, { allow_none: false });
    expect(guarded.label).toBe("fix");
    expect(buildConfidenceStripEvent(raw, guarded)).toBeNull();
  });

  it("captures a custom threshold verbatim on the detail", () => {
    const raw = { label: "x", confidence: 0.4 };
    const guarded = applyConfidenceThreshold(raw, { threshold: 0.5 });
    const detail = buildConfidenceStripEvent(raw, guarded);
    expect(detail?.threshold).toBe(0.5);
  });
});
