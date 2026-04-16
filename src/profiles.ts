/**
 * Hardware profiles — pick the right tier ladder for the machine running Ollama.
 *
 * The same code runs against very different hardware. This module encodes
 * the "which model belongs on which tier for which box" decision explicitly
 * so it's a product choice, not an env-var scavenger hunt.
 *
 * - dev-rtx5080 (default): Qwen ladder. Coherent day-to-day dogfooding.
 *   Same family top-to-bottom means a bad output is a tool/design problem,
 *   not a cross-family mismatch.
 * - dev-rtx5080-llama: parity rail. Same instant/workhorse as default, but
 *   Llama 8B on Deep. Use this to measure whether Llama-family drift buys
 *   anything real before committing to it on the M5 Max.
 * - m5-max: prod target. Real tier ladder once the box arrives.
 *
 * Per-tier env vars (INTERN_TIER_INSTANT, etc.) still override a profile's
 * model picks, so one-off experiments don't require a new profile.
 */

import type { Tier, TierConfig } from "./tiers.js";

export type ProfileName = "dev-rtx5080" | "dev-rtx5080-llama" | "m5-max";

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
      "RTX 5080 16GB VRAM — Qwen ladder. Default dev profile for dogfooding the delegation spine.",
    tiers: {
      instant: "qwen2.5:7b-instruct-q4_K_M",
      workhorse: "qwen2.5-coder:7b-instruct-q4_K_M",
      deep: "qwen2.5:14b-instruct-q4_K_M",
      embed: "nomic-embed-text",
    },
    timeouts: DEV_RTX5080_TIMEOUTS,
    prewarm: ["instant"],
  },
  "dev-rtx5080-llama": {
    name: "dev-rtx5080-llama",
    description:
      "RTX 5080 with Llama 8B on Deep — parity comparison lane for future Llama-family Deep migration.",
    tiers: {
      instant: "qwen2.5:7b-instruct-q4_K_M",
      workhorse: "qwen2.5-coder:7b-instruct-q4_K_M",
      deep: "llama3.1:8b-instruct-q4_K_M",
      embed: "nomic-embed-text",
    },
    timeouts: DEV_RTX5080_TIMEOUTS,
    prewarm: ["instant"],
  },
  "m5-max": {
    name: "m5-max",
    description: "M5 Max 128GB unified — full tier ladder. Prod target.",
    tiers: {
      instant: "qwen2.5:14b-instruct-q4_K_M",
      workhorse: "qwen2.5-coder:32b-instruct-q4_K_M",
      deep: "llama3.3:70b-instruct-q4_K_M",
      embed: "nomic-embed-text",
    },
    timeouts: M5_MAX_TIMEOUTS,
    prewarm: [],
  },
};

export const DEFAULT_PROFILE: ProfileName = "dev-rtx5080";

function isProfileName(x: string | undefined): x is ProfileName {
  return x === "dev-rtx5080" || x === "dev-rtx5080-llama" || x === "m5-max";
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
