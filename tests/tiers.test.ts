import { describe, it, expect } from "vitest";
import {
  loadTierConfig,
  resolveTier,
  DEFAULT_TIER_CONFIG,
  TIER_TIMEOUT_MS,
  TIER_FALLBACK,
} from "../src/tiers.js";

describe("tiers", () => {
  it("loads defaults when env is empty", () => {
    const cfg = loadTierConfig({});
    expect(cfg).toEqual(DEFAULT_TIER_CONFIG);
  });

  it("overrides each tier from env independently", () => {
    const cfg = loadTierConfig({
      INTERN_TIER_INSTANT: "a",
      INTERN_TIER_WORKHORSE: "b",
      INTERN_TIER_DEEP: "c",
      INTERN_EMBED_MODEL: "d",
    });
    expect(cfg).toEqual({ instant: "a", workhorse: "b", deep: "c", embed: "d" });
  });

  it("resolveTier picks the right model", () => {
    const cfg = loadTierConfig({});
    expect(resolveTier("instant", cfg)).toBe(DEFAULT_TIER_CONFIG.instant);
    expect(resolveTier("deep", cfg)).toBe(DEFAULT_TIER_CONFIG.deep);
  });

  it("timeouts escalate from instant to deep", () => {
    expect(TIER_TIMEOUT_MS.instant).toBeLessThan(TIER_TIMEOUT_MS.workhorse);
    expect(TIER_TIMEOUT_MS.workhorse).toBeLessThan(TIER_TIMEOUT_MS.deep);
  });

  it("fallback cascade is deep -> workhorse -> instant -> null; embed has no fallback", () => {
    expect(TIER_FALLBACK.deep).toBe("workhorse");
    expect(TIER_FALLBACK.workhorse).toBe("instant");
    expect(TIER_FALLBACK.instant).toBeNull();
    expect(TIER_FALLBACK.embed).toBeNull();
  });
});
