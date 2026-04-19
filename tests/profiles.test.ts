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

  it("m5-max ladder uses Qwen 3 workhorse + Llama 4 Scout deep (post-2026-04-18 upgrade)", () => {
    const p = PROFILES["m5-max"];
    // Llama 4 Scout uses a different chat template than 3.x; if this drifts back to llama3.x,
    // formatter misalignment would silently corrupt outputs — worth an explicit assertion.
    expect(p.tiers.instant).toMatch(/^qwen3/);
    expect(p.tiers.workhorse).toMatch(/^qwen3/);
    expect(p.tiers.deep).toMatch(/^llama4/);
  });

  it("selects profile by INTERN_PROFILE env var", () => {
    expect(loadProfile({ INTERN_PROFILE: "m5-max" }).name).toBe("m5-max");
    expect(loadProfile({ INTERN_PROFILE: "dev-rtx5080" }).name).toBe("dev-rtx5080");
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

  it("dev profiles prewarm Instant only; m5-max prewarms nothing", () => {
    expect(PROFILES["dev-rtx5080"].prewarm).toEqual(["instant"]);
    expect(PROFILES["m5-max"].prewarm).toEqual([]);
  });

  it("no profile prewarms Workhorse or Deep (VRAM pressure not yet justified)", () => {
    for (const p of Object.values(PROFILES)) {
      expect(p.prewarm).not.toContain("workhorse");
      expect(p.prewarm).not.toContain("deep");
    }
  });

  it("loadProfile carries prewarm through to caller", () => {
    expect(loadProfile({}).prewarm).toEqual(PROFILES[DEFAULT_PROFILE].prewarm);
  });
});
