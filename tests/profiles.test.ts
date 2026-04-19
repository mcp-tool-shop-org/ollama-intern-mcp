import { describe, it, expect } from "vitest";
import { loadProfile, PROFILES, DEFAULT_PROFILE } from "../src/profiles.js";

describe("profiles", () => {
  it("defaults to dev-rtx5080 when INTERN_PROFILE is empty", () => {
    const p = loadProfile({});
    expect(p.name).toBe(DEFAULT_PROFILE);
    expect(p.name).toBe("dev-rtx5080");
    expect(p.tiers).toEqual(PROFILES["dev-rtx5080"].tiers);
  });

  it("dev-rtx5080 default ladder uses hermes3:8b across Instant/Workhorse/Deep", () => {
    // Validated Hermes Agent integration path, 2026-04-19. Single model
    // across non-embed tiers keeps the Hermes wiring predictable; callers
    // that want a Qwen 3 rail opt into dev-rtx5080-qwen3.
    const p = PROFILES["dev-rtx5080"];
    expect(p.tiers.instant).toBe("hermes3:8b");
    expect(p.tiers.workhorse).toBe("hermes3:8b");
    expect(p.tiers.deep).toBe("hermes3:8b");
    expect(p.tiers.embed).toBe("nomic-embed-text");
  });

  it("dev-rtx5080-qwen3 is a coherent Qwen 3 ladder (same family top to bottom)", () => {
    const p = PROFILES["dev-rtx5080-qwen3"];
    expect(p.tiers.instant).toMatch(/^qwen3/);
    expect(p.tiers.workhorse).toMatch(/^qwen3/);
    expect(p.tiers.deep).toMatch(/^qwen3/);
    expect(p.tiers.embed).toBe("nomic-embed-text");
  });

  it("m5-max ladder sized for 128GB unified memory (Qwen 3)", () => {
    const p = PROFILES["m5-max"];
    expect(p.tiers.instant).toMatch(/^qwen3/);
    expect(p.tiers.workhorse).toMatch(/^qwen3/);
    expect(p.tiers.deep).toMatch(/^qwen3/);
    // Deep > Instant parameter count.
    expect(p.tiers.deep).toContain("32b");
  });

  it("no profile ships a qwen2.5 model (retired at v2.0.0)", () => {
    for (const p of Object.values(PROFILES)) {
      expect(p.tiers.instant).not.toMatch(/^qwen2\.5/);
      expect(p.tiers.workhorse).not.toMatch(/^qwen2\.5/);
      expect(p.tiers.deep).not.toMatch(/^qwen2\.5/);
    }
  });

  it("selects profile by INTERN_PROFILE env var", () => {
    expect(loadProfile({ INTERN_PROFILE: "m5-max" }).name).toBe("m5-max");
    expect(loadProfile({ INTERN_PROFILE: "dev-rtx5080-qwen3" }).name).toBe("dev-rtx5080-qwen3");
  });

  it("falls back to default for unknown profile names (incl. retired dev-rtx5080-llama)", () => {
    expect(loadProfile({ INTERN_PROFILE: "not-a-real-profile" }).name).toBe(DEFAULT_PROFILE);
    // Retired in v2.0.0 — old env settings must not silently match a removed profile.
    expect(loadProfile({ INTERN_PROFILE: "dev-rtx5080-llama" }).name).toBe(DEFAULT_PROFILE);
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
    expect(PROFILES["dev-rtx5080-qwen3"].timeouts.instant).toBe(15_000);
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
    expect(PROFILES["dev-rtx5080-qwen3"].prewarm).toEqual(["instant"]);
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
