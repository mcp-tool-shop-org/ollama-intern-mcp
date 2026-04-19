/**
 * Tier shape and constants — tier→model selection lives in ./profiles.ts.
 *
 * Claude picks the tier by picking the tool. Tools declare their tier;
 * resolveTier() turns a Tier into the concrete model name from a TierConfig,
 * which comes from the active Profile.
 */

export type Tier = "instant" | "workhorse" | "deep" | "embed";

export interface TierConfig {
  instant: string;
  workhorse: string;
  deep: string;
  embed: string;
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
 * Default temperatures by work shape.
 *
 * Calibrated for Qwen 3 (current default ladder). Qwen 3 has a documented
 * regression vs Qwen 2.5: greedy decoding (temp 0) degrades quality — the
 * official model cards publish minimum-safe defaults, which is why classify/
 * extract/triage now floor at 0.2 instead of 0.1 and never hit zero.
 *
 * Thinking vs non-thinking mode lands in prompts (`/no_think` soft-switch
 * for narration/classify/extract/triage/summarize-fast — deterministic short
 * outputs). Briefs / research / code draft leave thinking ON.
 *
 * Upstream docs: Qwen3 HF card recommends Temperature=0.7, TopP=0.8 (non-
 * thinking) and Temperature=0.6, TopP=0.95 (thinking). The structured-JSON
 * shapes here stay cooler than the card defaults — small models producing
 * strict schema need less entropy — but never greedy.
 */
export const TEMPERATURE_BY_SHAPE = {
  classify: 0.2,
  extract: 0.2,
  triage: 0.2,
  summarize: 0.3,
  research: 0.6,
  draft: 0.6,
  chat: 0.7,
} as const;

/**
 * Sampler defaults keyed to Qwen3 official guidance. Apply alongside
 * TEMPERATURE_BY_SHAPE when the tool constructs its options block.
 */
export const TOP_P_BY_MODE = {
  non_thinking: 0.8,
  thinking: 0.95,
} as const;

/**
 * Thinking-mode by work shape.
 *
 * Load-bearing for Qwen 3 on Ollama. When `think=true` and the model is a
 * reasoning model, CoT content is emitted into the response's `thinking`
 * field AND consumes num_predict budget. For short-output tasks (classify,
 * extract, triage, narration, short summaries) that budget is tight — a
 * thinking model can burn the entire num_predict on CoT and return an empty
 * `response`. The prompt-level `/no_think` soft-switch does NOT work on
 * Ollama — only the API field `think` does.
 *
 * Research / briefs / drafts get think=true: they benefit from CoT, and
 * their num_predict is sized for reasoning + response together.
 *
 * Shape-to-tool mapping (roughly):
 *   classify, extract, triage:        false
 *   summarize (fast + deep):          false (direct digestion)
 *   research:                          true  (reasoning over sources)
 *   draft:                             false (short utility code + stub prose)
 *   chat:                              false (caller-controlled conversations)
 *
 * Briefs (incident/repo/change) wire think=true directly via their handlers —
 * they use the "research" temperature but their num_predict is sized for
 * reasoning, so the thinking budget exists.
 */
export const THINK_BY_SHAPE = {
  classify: false,
  extract: false,
  triage: false,
  summarize: false,
  research: true,
  draft: false,
  chat: false,
} as const;
