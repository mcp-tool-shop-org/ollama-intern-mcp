/**
 * Timeout + fallback guardrail.
 *
 * Every tier has a hard timeout (see TIER_TIMEOUT_MS). When the timeout
 * fires, we log the timeout event, decide whether to fall back to a
 * cheaper tier, log the fallback decision, and re-run.
 *
 * Both events land in the NDJSON log. Later this is what proves the
 * system degraded correctly under pressure, not just that a call was slow.
 */

import { InternError } from "../errors.js";
import { TIER_FALLBACK, TIER_TIMEOUT_MS, type Tier } from "../tiers.js";
import type { Logger } from "../observability.js";
import { timestamp } from "../observability.js";

export interface RunWithTimeoutInput<T> {
  tool: string;
  tier: Tier;
  run: (tier: Tier, signal: AbortSignal) => Promise<T>;
  logger: Logger;
  /** If true, cascade through TIER_FALLBACK on timeout. Default true. */
  allowFallback?: boolean;
  /** Override timeouts per tier. Production leaves this undefined; tests inject short values. */
  timeoutOverrideMs?: Partial<Record<Tier, number>>;
  /**
   * Optional resolver so the terminal TIER_TIMEOUT error can include the
   * concrete model that actually timed out. Left undefined, the error
   * message falls back to just the tier — existing behavior is preserved.
   */
  modelFor?: (tier: Tier) => string;
}

export interface RunWithTimeoutResult<T> {
  value: T;
  actualTier: Tier;
  fallbackFrom?: Tier;
}

/**
 * Run `run(tier)` with the tier's timeout. On timeout:
 *   1. log a "timeout" event
 *   2. if TIER_FALLBACK[tier] exists and allowFallback, log a "fallback" event and retry
 *   3. if no fallback or fallback also times out, throw TIER_TIMEOUT
 */
export async function runWithTimeoutAndFallback<T>(
  input: RunWithTimeoutInput<T>,
): Promise<RunWithTimeoutResult<T>> {
  const allowFallback = input.allowFallback ?? true;
  return attempt(input.tier, undefined);

  async function attempt(tier: Tier, fallbackFrom: Tier | undefined): Promise<RunWithTimeoutResult<T>> {
    const controller = new AbortController();
    const timeoutMs = input.timeoutOverrideMs?.[tier] ?? TIER_TIMEOUT_MS[tier];
    const startedAt = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const value = await input.run(tier, controller.signal);
      return { value, actualTier: tier, ...(fallbackFrom ? { fallbackFrom } : {}) };
    } catch (err) {
      if (!timedOut) throw err;
      await input.logger.log({ kind: "timeout", ts: timestamp(), tool: input.tool, tier, timeout_ms: timeoutMs });
      const next = allowFallback ? TIER_FALLBACK[tier] : null;
      if (!next) {
        // Include model (if available), elapsed, budget, and whether a
        // fallback was even attempted. "timeout" alone is useless for
        // debugging — a human reading the error should be able to tell
        // whether this was a cold-load issue, a true runaway call, or a
        // cascade that ran out of runway.
        const elapsedMs = Date.now() - startedAt;
        const model = input.modelFor ? input.modelFor(tier) : undefined;
        const fallbackAttempted = fallbackFrom !== undefined;
        const parts = [
          `Tool ${input.tool} timed out on tier ${tier}`,
          model ? `model=${model}` : null,
          `elapsed=${elapsedMs}ms`,
          `budget=${timeoutMs}ms`,
          `fallback_attempted=${fallbackAttempted}`,
          allowFallback ? "no cheaper tier available" : "fallback disabled",
        ].filter(Boolean);
        throw new InternError(
          "TIER_TIMEOUT",
          parts.join(" "),
          "Increase the tier's timeout, reduce input size, or ensure the model is resident (check /api/ps).",
          true,
        );
      }
      await input.logger.log({
        kind: "fallback",
        ts: timestamp(),
        tool: input.tool,
        from: tier,
        to: next,
        reason: `timeout after ${timeoutMs}ms`,
      });
      return attempt(next, fallbackFrom ?? tier);
    } finally {
      clearTimeout(timer);
    }
  }
}
