/**
 * Hardware profiles — pick the right tier ladder for the machine running Ollama.
 *
 * The same code runs across hardware. This module encodes which model belongs
 * on which tier for which box as an explicit product decision, not an env-var
 * scavenger hunt. Model generations are named precisely so a stale repo can be
 * caught at code-review time rather than silently running an obsolete ladder.
 *
 * Current defaults (April 2026): Qwen 3 for Qwen-family tiers; Llama 4 Scout
 * for the M5 Max prod deep slot (supersedes Llama 3.3 70B — Scout is 109B-
 * total / 17B-active MoE with a different chat template, `<|header_start|>`
 * and `<|eot|>`; the Llama 3.x formatter would silently misalign).
 *
 * - dev-rtx5080 (default): Qwen 3 ladder. 16GB VRAM caps the workhorse at
 *   qwen3:8b for now — Qwen3-Coder-30B-A3B doesn't fit comfortably even as
 *   an MoE. Revisit when quantized MoE tooling catches up.
 * - m5-max: prod target. Full Qwen 3 + Llama 4 ladder.
 *
 * The old dev-rtx5080-llama profile was retired on 2026-04-18 — Llama 3.1
 * 8B is obsolete and Llama 4 Scout doesn't fit on 16GB VRAM. If a Llama
 * parity lane is needed later, it'll target a Llama 4 variant sized for
 * consumer cards.
 *
 * Per-tier env vars (INTERN_TIER_INSTANT, etc.) still override a profile's
 * model picks, so one-off experiments don't require a new profile.
 */

import type { Tier, TierConfig } from "./tiers.js";

export type ProfileName = "dev-rtx5080" | "m5-max";

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
      "RTX 5080 16GB VRAM — Qwen 3 ladder. Workhorse stays on qwen3:8b until a quantized Qwen3-Coder variant fits the VRAM budget comfortably.",
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
    description:
      "M5 Max 128GB unified — prod target. Qwen 3 workhorse + Llama 4 Scout deep. Llama 4 uses a different chat template than 3.x; the formatter layer must branch on model family.",
    tiers: {
      instant: "qwen3:14b",
      workhorse: "qwen3:32b",
      deep: "llama4:scout",
      embed: "nomic-embed-text",
    },
    timeouts: M5_MAX_TIMEOUTS,
    prewarm: [],
  },
};

export const DEFAULT_PROFILE: ProfileName = "dev-rtx5080";

function isProfileName(x: string | undefined): x is ProfileName {
  return x === "dev-rtx5080" || x === "m5-max";
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
