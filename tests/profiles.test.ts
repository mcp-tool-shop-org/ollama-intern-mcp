import { describe, it, expect } from "vitest";
import {
  loadProfile,
  PROFILES,
  DEFAULT_PROFILE,
  OLLAMA_MODEL_NAME_RE,
  NUM_CTX_MIN,
  NUM_CTX_MAX,
  validateNumCtx,
} from "../src/profiles.js";
import { InternError } from "../src/errors.js";

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

  it("throws CONFIG_INVALID on unknown profile names (incl. retired dev-rtx5080-llama)", () => {
    // Stage B+C behavior change: silent fallback to default was masking typos
    // against the wrong hardware ladder. Unknown profile names now fail fast.
    expect(() => loadProfile({ INTERN_PROFILE: "not-a-real-profile" })).toThrow(/Unknown profile/);
    // Retired in v2.0.0 — old env settings must not silently match a removed profile.
    expect(() => loadProfile({ INTERN_PROFILE: "dev-rtx5080-llama" })).toThrow(/Unknown profile/);

    // Error shape should point operators at the available names.
    let caught: unknown;
    try {
      loadProfile({ INTERN_PROFILE: "not-a-real-profile" });
    } catch (e) {
      caught = e;
    }
    const err = caught as { code?: string; hint?: string };
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.hint).toContain("dev-rtx5080");
    expect(err.hint).toContain("m5-max");
  });

  it("empty or unset INTERN_PROFILE still defaults to dev-rtx5080 (no throw)", () => {
    expect(loadProfile({}).name).toBe(DEFAULT_PROFILE);
    expect(loadProfile({ INTERN_PROFILE: "" }).name).toBe(DEFAULT_PROFILE);
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

  // ── Per-tier num_ctx (v2.4.0) ────────────────────────────────────
  //
  // Operational driver: hermes3:8b at 32K context on RTX 5080 16GB VRAM
  // spills to CPU and kills workhorse latency. Profiles now declare
  // per-tier num_ctx to keep mid-sized models resident.

  it("dev-rtx5080 sets instant=4096 / workhorse=8192 (RTX 5080 VRAM fit)", () => {
    const p = PROFILES["dev-rtx5080"];
    expect(p.tiers.num_ctx?.instant).toBe(4096);
    expect(p.tiers.num_ctx?.workhorse).toBe(8192);
  });

  it("dev-rtx5080 leaves deep + embed num_ctx UNSET (current behavior preserved)", () => {
    // Deep stays at the model-loaded default — long-context briefs /
    // research keep current behavior. Embed has no context-window
    // pressure. Both must be undefined, not 0.
    const p = PROFILES["dev-rtx5080"];
    expect(p.tiers.num_ctx?.deep).toBeUndefined();
    expect(p.tiers.num_ctx?.embed).toBeUndefined();
  });

  it("dev-rtx5080-qwen3 mirrors the RTX 5080 instant/workhorse caps", () => {
    // Same VRAM constraint applies to Qwen3 8B as hermes3:8b.
    const p = PROFILES["dev-rtx5080-qwen3"];
    expect(p.tiers.num_ctx?.instant).toBe(4096);
    expect(p.tiers.num_ctx?.workhorse).toBe(8192);
    expect(p.tiers.num_ctx?.deep).toBeUndefined();
    expect(p.tiers.num_ctx?.embed).toBeUndefined();
  });

  it("m5-max leaves num_ctx UNSET on every tier (128GB unified, no spill problem)", () => {
    const p = PROFILES["m5-max"];
    // The whole map is allowed to be undefined OR present with all
    // tiers absent — both shapes mean "let Ollama use its default".
    const map = p.tiers.num_ctx;
    if (map !== undefined) {
      expect(map.instant).toBeUndefined();
      expect(map.workhorse).toBeUndefined();
      expect(map.deep).toBeUndefined();
      expect(map.embed).toBeUndefined();
    }
  });

  it("loadProfile carries num_ctx through to caller (dev-rtx5080)", () => {
    const p = loadProfile({ INTERN_PROFILE: "dev-rtx5080" });
    expect(p.tiers.num_ctx?.instant).toBe(4096);
    expect(p.tiers.num_ctx?.workhorse).toBe(8192);
    expect(p.tiers.num_ctx?.deep).toBeUndefined();
  });

  it("loadProfile carries num_ctx through to caller (m5-max — all unset)", () => {
    // m5-max defines no num_ctx; the loader must not synthesize one.
    const p = loadProfile({ INTERN_PROFILE: "m5-max" });
    if (p.tiers.num_ctx !== undefined) {
      expect(p.tiers.num_ctx.instant).toBeUndefined();
      expect(p.tiers.num_ctx.workhorse).toBeUndefined();
      expect(p.tiers.num_ctx.deep).toBeUndefined();
    }
  });

  // ── FT-002 — env-supplied model-name validation (Phase 7) ────────
  //
  // A typo like `INTERN_TIER_DEEP=hermes3-8b` (dash where colon belongs)
  // used to survive loadProfile() and bubble up HOURS later as an
  // OLLAMA_MODEL_MISSING from /api/generate. The fail-fast validator now
  // catches the typo at startup with a CONFIG_INVALID + targeted hint.
  //
  // These tests pin:
  //  1. Common typos throw CONFIG_INVALID at load.
  //  2. The thrown error names the variable, the bad value, and (where
  //     reasonable) the most-likely intended value.
  //  3. The validator no-ops on unset/empty values (back-compat).
  //  4. The regex pattern is exported for callers that need their own
  //     copy of the contract.

  describe("env model-name validation (FT-002)", () => {
    // The validator has TWO rejection paths:
    //  1. Structural regex (OLLAMA_MODEL_NAME_RE) — rejects uppercase
    //     in name segment, whitespace, slashes, etc.
    //  2. Dash-for-colon typo heuristic — rejects `hermes3-8b` even
    //     though the bare regex would accept it, because the trailing
    //     `-8b` shape is almost certainly a typo for `:8b`.
    // Tags after `:` are allowed to use mixed case (real-world quantization
    // labels like `:q4_K_M`).

    it("throws CONFIG_INVALID when INTERN_TIER_DEEP is the dash-typo `hermes3-8b`", () => {
      let caught: unknown;
      try {
        loadProfile({ INTERN_TIER_DEEP: "hermes3-8b" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InternError);
      const err = caught as InternError;
      expect(err.code).toBe("CONFIG_INVALID");
      // Helpful diagnostics: the message should name the variable,
      // the bad value, and the hint should suggest the colon form so
      // the operator can act without consulting docs.
      expect(err.message).toContain("INTERN_TIER_DEEP");
      expect(err.message).toContain("hermes3-8b");
      expect(err.hint).toContain("hermes3:8b");
    });

    it("throws CONFIG_INVALID on every tier env when the value is the dash typo", () => {
      for (const key of [
        "INTERN_TIER_INSTANT",
        "INTERN_TIER_WORKHORSE",
        "INTERN_TIER_DEEP",
        "INTERN_EMBED_MODEL",
      ]) {
        let caught: unknown;
        try {
          loadProfile({ [key]: "hermes3-8b" });
        } catch (e) {
          caught = e;
        }
        expect(caught, `${key} must reject the dash typo`).toBeInstanceOf(InternError);
        expect((caught as InternError).code).toBe("CONFIG_INVALID");
      }
    });

    it("throws CONFIG_INVALID on UPPERCASE in the name segment", () => {
      // Uppercase in `name` (before `:`) is structural rejection — Ollama
      // refuses these at `ollama pull` time.
      let caught: unknown;
      try {
        loadProfile({ INTERN_TIER_WORKHORSE: "Hermes3:8b" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InternError);
      expect((caught as InternError).code).toBe("CONFIG_INVALID");
      const err = caught as InternError;
      expect(err.message).toContain("INTERN_TIER_WORKHORSE");
    });

    it("throws CONFIG_INVALID on whitespace-bearing model names", () => {
      // The validator runs after env merge, where whitespace is preserved
      // verbatim. Names with spaces are categorically invalid in Ollama.
      let caught: unknown;
      try {
        loadProfile({ INTERN_TIER_INSTANT: "hermes3:8 b" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InternError);
      expect((caught as InternError).code).toBe("CONFIG_INVALID");
    });

    it("accepts the canonical colon form (back-compat for legitimate overrides)", () => {
      const p = loadProfile({ INTERN_TIER_DEEP: "hermes3:8b" });
      expect(p.tiers.deep).toBe("hermes3:8b");
    });

    it("accepts hyphenated names that contain no colon (e.g. nomic-embed-text)", () => {
      // The validator must not over-fire on legitimate hyphenated names.
      // `nomic-embed-text` ends in `-text` (letters not digits) so the
      // dash-typo heuristic correctly skips it.
      const p = loadProfile({ INTERN_EMBED_MODEL: "nomic-embed-text" });
      expect(p.tiers.embed).toBe("nomic-embed-text");
    });

    it("accepts mixed-case quantization tags (e.g. custom:model-q4_K_M)", () => {
      // Real-world env overrides routinely pin a quantized variant. The
      // tag-side of the regex `[A-Za-z0-9._-]+` lets `q4_K_M` through.
      const p = loadProfile({ INTERN_TIER_DEEP: "custom:model-q4_K_M" });
      expect(p.tiers.deep).toBe("custom:model-q4_K_M");
    });

    it("no-ops on unset env (falls through to profile default)", () => {
      const p = loadProfile({});
      expect(p.tiers.deep).toBe(PROFILES["dev-rtx5080"].tiers.deep);
    });

    it("no-ops on empty env string (falls through to profile default)", () => {
      // Empty string is the documented "don't override" path so a shell
      // that exports an empty value doesn't accidentally pin the default.
      const p = loadProfile({ INTERN_TIER_DEEP: "" });
      expect(p.tiers.deep).toBe(PROFILES["dev-rtx5080"].tiers.deep);
    });

    it("OLLAMA_MODEL_NAME_RE is exported and matches the documented pattern", () => {
      expect(OLLAMA_MODEL_NAME_RE).toBeInstanceOf(RegExp);
      // Spot-check the contract — lowercase name, optional :tag (mixed case).
      expect(OLLAMA_MODEL_NAME_RE.test("hermes3:8b")).toBe(true);
      expect(OLLAMA_MODEL_NAME_RE.test("nomic-embed-text")).toBe(true);
      // Mixed-case quantization tag (allowed AFTER the colon).
      expect(OLLAMA_MODEL_NAME_RE.test("custom:model-q4_K_M")).toBe(true);
      // The negative lookahead in the regex catches the `<name>-<digits>[letter]`
      // dash-typo shape directly, so `hermes3-8b` fails at the structural step.
      expect(OLLAMA_MODEL_NAME_RE.test("hermes3-8b")).toBe(false);
      // Uppercase in the name segment is always rejected.
      expect(OLLAMA_MODEL_NAME_RE.test("Hermes3:8B")).toBe(false);
      expect(OLLAMA_MODEL_NAME_RE.test("hermes 3:8b")).toBe(false);
    });
  });

  // ── FT-002 — num_ctx validator (Phase 7) ─────────────────────────

  describe("validateNumCtx (FT-002)", () => {
    it("accepts integers within [NUM_CTX_MIN, NUM_CTX_MAX]", () => {
      expect(() => validateNumCtx("INTERN_NUM_CTX_INSTANT", 4096)).not.toThrow();
      expect(() => validateNumCtx("X", NUM_CTX_MIN)).not.toThrow();
      expect(() => validateNumCtx("X", NUM_CTX_MAX)).not.toThrow();
    });

    it("no-ops on undefined / null", () => {
      expect(() => validateNumCtx("X", undefined)).not.toThrow();
      expect(() => validateNumCtx("X", null)).not.toThrow();
    });

    it("throws CONFIG_INVALID on values below the lower bound", () => {
      let caught: unknown;
      try {
        validateNumCtx("INTERN_NUM_CTX_INSTANT", NUM_CTX_MIN - 1);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InternError);
      expect((caught as InternError).code).toBe("CONFIG_INVALID");
    });

    it("throws CONFIG_INVALID on values above the upper bound", () => {
      let caught: unknown;
      try {
        validateNumCtx("INTERN_NUM_CTX_DEEP", NUM_CTX_MAX + 1);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InternError);
      expect((caught as InternError).code).toBe("CONFIG_INVALID");
    });

    it("throws CONFIG_INVALID on non-integer numbers (4096.5)", () => {
      expect(() => validateNumCtx("X", 4096.5)).toThrow(/CONFIG_INVALID|not an integer/);
    });

    it("throws CONFIG_INVALID on a non-numeric string", () => {
      expect(() => validateNumCtx("X", "not a number")).toThrow();
    });
  });
});
