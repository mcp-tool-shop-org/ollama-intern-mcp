/**
 * Hardware profiles — pick the right tier ladder for the machine running Ollama.
 *
 * The same code runs against very different hardware. This module encodes
 * the "which model belongs on which tier for which box" decision explicitly
 * so it's a product choice, not an env-var scavenger hunt.
 *
 * - dev-rtx5080 (default): hermes3:8b ladder. Validated Hermes Agent
 *   integration path — Nous Research's hermes3:8b emits clean tool_calls
 *   over Ollama's /v1 chat endpoint and is the proven default for driving
 *   this MCP from an external agent (2026-04-19).
 * - dev-rtx5080-qwen3: Qwen 3 alternate rail. Same-family top-to-bottom
 *   Qwen 3 ladder for users who prefer Qwen tooling or want to compare.
 *   Picks up the `think` / THINK_BY_SHAPE plumbing in tiers.ts.
 * - m5-max: prod target. Qwen 3 ladder sized for 128GB unified memory.
 *
 * Per-tier env vars (INTERN_TIER_INSTANT, etc.) still override a profile's
 * model picks, so one-off experiments don't require a new profile.
 *
 * The retired `dev-rtx5080-llama` profile (Llama 3.1 on Deep) was dropped
 * at v2.0.0 — Llama 3.1 8B is obsolete, and the parity-rail experiment ran
 * its course.
 *
 * The retired qwen2.5 defaults (`qwen2.5:*-instruct-q4_K_M`) were dropped
 * at v2.0.0 — qwen2.5 is retired on modern Ollama installs and the
 * `INTERN_TIER_*` env knobs are sufficient for anyone pinning an older model.
 */

import type { Tier, TierConfig } from "./tiers.js";

export type ProfileName = "dev-rtx5080" | "dev-rtx5080-qwen3" | "m5-max";

export interface Profile {
  name: ProfileName;
  description: string;
  tiers: TierConfig;
  /**
   * Per-tier timeouts in ms. Lives on the profile (not as a global constant)
   * because cold-load behavior is hardware-bound — Instant needs 15s of
   * margin on a 16GB-VRAM dev box but only 5s on M5 Max unified memory.
   * Found via the first live dogfood pass: all Instant calls on RTX 5080
   * timed out at 5s before first token.
   */
  timeouts: Record<Tier, number>;
  /**
   * Tiers to prewarm on server startup. Targeted adoption aid for tiers
   * most likely to become habit (Instant), where cold-load drag would
   * poison early product feel. NOT a blanket "make everything hot" knob —
   * Workhorse and Deep are deliberately excluded so VRAM pressure and
   * unintended residency churn don't start mattering.
   */
  prewarm: Tier[];
}

/** Timeouts sized for a 16GB-VRAM discrete-GPU box where cold load costs 3-5s. */
const DEV_RTX5080_TIMEOUTS: Record<Tier, number> = {
  instant: 15_000,
  workhorse: 20_000,
  deep: 90_000,
  embed: 10_000,
};

/** Timeouts sized for M5 Max 128GB unified memory where cold load is ~instant. */
const M5_MAX_TIMEOUTS: Record<Tier, number> = {
  instant: 5_000,
  workhorse: 20_000,
  deep: 90_000,
  embed: 10_000,
};

export const PROFILES: Record<ProfileName, Profile> = {
  "dev-rtx5080": {
    name: "dev-rtx5080",
    description:
      "RTX 5080 16GB VRAM — hermes3:8b ladder. Default dev profile. Validated Hermes Agent integration path (Nous Research hermes3:8b emits clean tool_calls over Ollama /v1).",
    tiers: {
      instant: "hermes3:8b",
      workhorse: "hermes3:8b",
      deep: "hermes3:8b",
      embed: "nomic-embed-text",
    },
    timeouts: DEV_RTX5080_TIMEOUTS,
    prewarm: ["instant"],
  },
  "dev-rtx5080-qwen3": {
    name: "dev-rtx5080-qwen3",
    description:
      "RTX 5080 16GB VRAM — Qwen 3 alternate rail. Same-family top-to-bottom Qwen 3 ladder for callers who prefer it; uses THINK_BY_SHAPE plumbing.",
    tiers: {
      instant: "qwen3:8b",
      workhorse: "qwen3:8b",
      deep: "qwen3:14b",
      embed: "nomic-embed-text",
    },
    timeouts: DEV_RTX5080_TIMEOUTS,
    prewarm: ["instant"],
  },
  "m5-max": {
    name: "m5-max",
    description: "M5 Max 128GB unified — Qwen 3 ladder sized for unified memory. Prod target.",
    tiers: {
      instant: "qwen3:14b",
      workhorse: "qwen3:14b",
      deep: "qwen3:32b",
      embed: "nomic-embed-text",
    },
    timeouts: M5_MAX_TIMEOUTS,
    prewarm: [],
  },
};

export const DEFAULT_PROFILE: ProfileName = "dev-rtx5080";

function isProfileName(x: string | undefined): x is ProfileName {
  return x === "dev-rtx5080" || x === "dev-rtx5080-qwen3" || x === "m5-max";
}

/**
 * Resolve the active profile from env. Selection order:
 *   1. INTERN_PROFILE env var, if a known name
 *   2. DEFAULT_PROFILE (dev-rtx5080)
 *
 * Per-tier env vars (INTERN_TIER_INSTANT, etc.) override the profile's picks.
 * Profile.timeouts are not env-overridable — they are a hardware property,
 * not a one-off tuning knob.
 */
export function loadProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const name: ProfileName = isProfileName(env.INTERN_PROFILE) ? env.INTERN_PROFILE : DEFAULT_PROFILE;
  const base = PROFILES[name];
  const tiers: TierConfig = {
    instant: env.INTERN_TIER_INSTANT || base.tiers.instant,
    workhorse: env.INTERN_TIER_WORKHORSE || base.tiers.workhorse,
    deep: env.INTERN_TIER_DEEP || base.tiers.deep,
    embed: env.INTERN_EMBED_MODEL || base.tiers.embed,
  };
  return { name, description: base.description, tiers, timeouts: base.timeouts, prewarm: base.prewarm };
}
