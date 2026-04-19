import { describe, it, expect } from "vitest";
import {
  resolveTier,
  TIER_TIMEOUT_MS,
  TIER_FALLBACK,
  TEMPERATURE_BY_SHAPE,
  TOP_P_BY_MODE,
  THINK_BY_SHAPE,
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

describe("TEMPERATURE_BY_SHAPE — Qwen 3 minimum-safe floors", () => {
  it("structured-JSON shapes stay above greedy (Qwen 3 degrades on temp 0)", () => {
    // Calibrated for Qwen 3 per official HF card. hermes3:8b also fine here.
    expect(TEMPERATURE_BY_SHAPE.classify).toBeGreaterThanOrEqual(0.2);
    expect(TEMPERATURE_BY_SHAPE.extract).toBeGreaterThanOrEqual(0.2);
    expect(TEMPERATURE_BY_SHAPE.triage).toBeGreaterThanOrEqual(0.2);
  });
  it("narrative/research shapes run hotter than structured ones", () => {
    expect(TEMPERATURE_BY_SHAPE.summarize).toBeGreaterThan(TEMPERATURE_BY_SHAPE.classify);
    expect(TEMPERATURE_BY_SHAPE.research).toBeGreaterThan(TEMPERATURE_BY_SHAPE.summarize);
    expect(TEMPERATURE_BY_SHAPE.chat).toBeGreaterThanOrEqual(TEMPERATURE_BY_SHAPE.research);
  });
});

describe("TOP_P_BY_MODE", () => {
  it("thinking mode samples wider than non-thinking (per Qwen 3 card)", () => {
    expect(TOP_P_BY_MODE.thinking).toBeGreaterThan(TOP_P_BY_MODE.non_thinking);
    expect(TOP_P_BY_MODE.non_thinking).toBeGreaterThan(0);
    expect(TOP_P_BY_MODE.thinking).toBeLessThanOrEqual(1);
  });
});

describe("THINK_BY_SHAPE", () => {
  it("short structured shapes disable thinking (Qwen 3 empty-response hazard)", () => {
    // Load-bearing on Qwen 3: thinking on tight num_predict eats the budget.
    expect(THINK_BY_SHAPE.classify).toBe(false);
    expect(THINK_BY_SHAPE.extract).toBe(false);
    expect(THINK_BY_SHAPE.triage).toBe(false);
    expect(THINK_BY_SHAPE.summarize).toBe(false);
    expect(THINK_BY_SHAPE.draft).toBe(false);
  });
  it("research enables thinking — reasoning benefits outweigh budget cost", () => {
    expect(THINK_BY_SHAPE.research).toBe(true);
  });
});
