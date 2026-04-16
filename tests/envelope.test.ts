import { describe, it, expect } from "vitest";
import { buildEnvelope, isEvicted, type Residency } from "../src/envelope.js";

describe("envelope", () => {
  it("builds with required fields and omits optional ones", () => {
    const env = buildEnvelope({
      result: { ok: true },
      tier: "instant",
      model: "qwen2.5:14b",
      tokensIn: 10,
      tokensOut: 20,
      startedAt: Date.now() - 100,
      residency: null,
    });
    expect(env.tier_used).toBe("instant");
    expect(env.model).toBe("qwen2.5:14b");
    expect(env.tokens_in).toBe(10);
    expect(env.tokens_out).toBe(20);
    expect(env.elapsed_ms).toBeGreaterThanOrEqual(100);
    expect(env.residency).toBeNull();
    expect(env.fallback_from).toBeUndefined();
    expect(env.warnings).toBeUndefined();
  });

  it("carries fallback_from when set", () => {
    const env = buildEnvelope({
      result: null,
      tier: "workhorse",
      model: "x",
      tokensIn: 0,
      tokensOut: 0,
      startedAt: Date.now(),
      residency: null,
      fallbackFrom: "deep",
    });
    expect(env.fallback_from).toBe("deep");
  });

  it("carries warnings when non-empty, omits when empty", () => {
    const withWarn = buildEnvelope({
      result: null, tier: "deep", model: "x", tokensIn: 0, tokensOut: 0,
      startedAt: Date.now(), residency: null, warnings: ["stripped 1 citation"],
    });
    expect(withWarn.warnings).toEqual(["stripped 1 citation"]);
    const withoutWarn = buildEnvelope({
      result: null, tier: "deep", model: "x", tokensIn: 0, tokensOut: 0,
      startedAt: Date.now(), residency: null, warnings: [],
    });
    expect(withoutWarn.warnings).toBeUndefined();
  });
});

describe("isEvicted", () => {
  it("returns false for null residency", () => {
    expect(isEvicted(null)).toBe(false);
  });

  it("detects eviction flag", () => {
    const r: Residency = { in_vram: true, size_bytes: 100, size_vram_bytes: 100, evicted: true, expires_at: null };
    expect(isEvicted(r)).toBe(true);
  });

  it("detects size_vram < size as eviction (issue #13227 guard)", () => {
    const r: Residency = { in_vram: true, size_bytes: 100, size_vram_bytes: 50, evicted: false, expires_at: null };
    expect(isEvicted(r)).toBe(true);
  });

  it("detects in_vram=false as eviction", () => {
    const r: Residency = { in_vram: false, size_bytes: 100, size_vram_bytes: 100, evicted: false, expires_at: null };
    expect(isEvicted(r)).toBe(true);
  });
});
