/**
 * Tier map — the single source of truth for which model backs which tool.
 *
 * Claude picks the tier by picking the tool. Tools declare their tier;
 * resolveTier() turns a Tier into the concrete model name from env.
 */

export type Tier = "instant" | "workhorse" | "deep" | "embed";

export interface TierConfig {
  instant: string;
  workhorse: string;
  deep: string;
  embed: string;
}

/** Default models — matched to Phase 0 research on M-series hardware. */
export const DEFAULT_TIER_CONFIG: TierConfig = {
  instant: "qwen2.5:14b-instruct-q4_K_M",
  workhorse: "qwen2.5-coder:32b-instruct-q4_K_M",
  deep: "llama3.3:70b-instruct-q4_K_M",
  embed: "nomic-embed-text",
};

export function loadTierConfig(env: NodeJS.ProcessEnv = process.env): TierConfig {
  return {
    instant: env.INTERN_TIER_INSTANT || DEFAULT_TIER_CONFIG.instant,
    workhorse: env.INTERN_TIER_WORKHORSE || DEFAULT_TIER_CONFIG.workhorse,
    deep: env.INTERN_TIER_DEEP || DEFAULT_TIER_CONFIG.deep,
    embed: env.INTERN_EMBED_MODEL || DEFAULT_TIER_CONFIG.embed,
  };
}

export function resolveTier(tier: Tier, config: TierConfig): string {
  return config[tier];
}

/**
 * Per-tier timeouts in ms. Used by guardrails/timeouts.ts to enforce
 * degradation rules and decide fallback behavior.
 */
export const TIER_TIMEOUT_MS: Record<Tier, number> = {
  instant: 5_000,
  workhorse: 20_000,
  deep: 90_000,
  embed: 10_000,
};

/**
 * Fallback tier — what to degrade to when a tier's timeout fires.
 * Deep → workhorse → instant. Embed has no fallback (no cheaper embed tier).
 */
export const TIER_FALLBACK: Record<Tier, Tier | null> = {
  deep: "workhorse",
  workhorse: "instant",
  instant: null,
  embed: null,
};

/**
 * Default temperatures by work shape. Small models reward tight scaffolding;
 * these map to the patterns in the handoff prompt-shape notes.
 */
export const TEMPERATURE_BY_SHAPE = {
  classify: 0.1,
  extract: 0.1,
  triage: 0.1,
  summarize: 0.3,
  research: 0.3,
  draft: 0.4,
  chat: 0.7,
} as const;
