import { describe, it, expect } from "vitest";
import { loadProfile, PROFILES, DEFAULT_PROFILE } from "../src/profiles.js";

describe("profiles", () => {
  it("defaults to dev-rtx5080 when INTERN_PROFILE is empty", () => {
    const p = loadProfile({});
    expect(p.name).toBe(DEFAULT_PROFILE);
    expect(p.name).toBe("dev-rtx5080");
    expect(p.tiers).toEqual(PROFILES["dev-rtx5080"].tiers);
  });

  it("dev-rtx5080 is a coherent Qwen ladder (same family top to bottom)", () => {
    const p = PROFILES["dev-rtx5080"];
    expect(p.tiers.instant).toMatch(/^qwen/);
    expect(p.tiers.workhorse).toMatch(/^qwen/);
    expect(p.tiers.deep).toMatch(/^qwen/);
    expect(p.tiers.embed).toBe("nomic-embed-text");
  });

  it("dev-rtx5080-llama diverges only on Deep (parity rail)", () => {
    const dev = PROFILES["dev-rtx5080"];
    const llama = PROFILES["dev-rtx5080-llama"];
    expect(llama.tiers.instant).toBe(dev.tiers.instant);
    expect(llama.tiers.workhorse).toBe(dev.tiers.workhorse);
    expect(llama.tiers.embed).toBe(dev.tiers.embed);
    expect(llama.tiers.deep).toMatch(/^llama/);
  });

  it("m5-max ladder matches the Phase 0 handoff target models", () => {
    const p = PROFILES["m5-max"];
    expect(p.tiers.instant).toContain("14b");
    expect(p.tiers.workhorse).toContain("32b");
    expect(p.tiers.deep).toContain("70b");
  });

  it("selects profile by INTERN_PROFILE env var", () => {
    expect(loadProfile({ INTERN_PROFILE: "m5-max" }).name).toBe("m5-max");
    expect(loadProfile({ INTERN_PROFILE: "dev-rtx5080-llama" }).name).toBe("dev-rtx5080-llama");
  });

  it("falls back to default for unknown profile names", () => {
    const p = loadProfile({ INTERN_PROFILE: "not-a-real-profile" });
    expect(p.name).toBe(DEFAULT_PROFILE);
  });

  it("per-tier env vars override the profile's picks", () => {
    const p = loadProfile({
      INTERN_PROFILE: "dev-rtx5080",
      INTERN_TIER_DEEP: "custom:model-q4_K_M",
    });
    expect(p.name).toBe("dev-rtx5080");
    expect(p.tiers.deep).toBe("custom:model-q4_K_M");
    expect(p.tiers.instant).toBe(PROFILES["dev-rtx5080"].tiers.instant);
  });

  it("each profile carries a human-readable description", () => {
    for (const name of Object.keys(PROFILES) as Array<keyof typeof PROFILES>) {
      expect(PROFILES[name].description.length).toBeGreaterThan(20);
    }
  });

  it("dev profiles lock Instant to 15s (cold-load margin); m5-max stays at 5s", () => {
    expect(PROFILES["dev-rtx5080"].timeouts.instant).toBe(15_000);
    expect(PROFILES["dev-rtx5080-llama"].timeouts.instant).toBe(15_000);
    expect(PROFILES["m5-max"].timeouts.instant).toBe(5_000);
  });

  it("Workhorse / Deep / Embed timeouts match across all profiles (hardware-invariant for those tiers)", () => {
    const workhorse = PROFILES["m5-max"].timeouts.workhorse;
    const deep = PROFILES["m5-max"].timeouts.deep;
    const embed = PROFILES["m5-max"].timeouts.embed;
    for (const p of Object.values(PROFILES)) {
      expect(p.timeouts.workhorse).toBe(workhorse);
      expect(p.timeouts.deep).toBe(deep);
      expect(p.timeouts.embed).toBe(embed);
    }
  });

  it("loadProfile carries timeouts through to caller", () => {
    const p = loadProfile({});
    expect(p.timeouts).toEqual(PROFILES[DEFAULT_PROFILE].timeouts);
  });
});
