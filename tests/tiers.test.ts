import { describe, it, expect } from "vitest";
import {
  resolveTier,
  TIER_TIMEOUT_MS,
  TIER_FALLBACK,
  type TierConfig,
} from "../src/tiers.js";

describe("resolveTier", () => {
  const cfg: TierConfig = { instant: "a", workhorse: "b", deep: "c", embed: "d" };

  it("picks the right model per tier", () => {
    expect(resolveTier("instant", cfg)).toBe("a");
    expect(resolveTier("workhorse", cfg)).toBe("b");
    expect(resolveTier("deep", cfg)).toBe("c");
    expect(resolveTier("embed", cfg)).toBe("d");
  });
});

describe("TIER_TIMEOUT_MS", () => {
  it("escalates from instant to deep", () => {
    expect(TIER_TIMEOUT_MS.instant).toBeLessThan(TIER_TIMEOUT_MS.workhorse);
    expect(TIER_TIMEOUT_MS.workhorse).toBeLessThan(TIER_TIMEOUT_MS.deep);
  });
});

describe("TIER_FALLBACK", () => {
  it("cascades deep -> workhorse -> instant -> null; embed has no fallback", () => {
    expect(TIER_FALLBACK.deep).toBe("workhorse");
    expect(TIER_FALLBACK.workhorse).toBe("instant");
    expect(TIER_FALLBACK.instant).toBeNull();
    expect(TIER_FALLBACK.embed).toBeNull();
  });
});
