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
   * Also used to enrich the timeout log event with the model field.
   */
  modelFor?: (tier: Tier) => string;
  /**
   * Optional active profile name. When set, emitted on timeout, fallback,
   * and TIER_TIMEOUT error hints so operators can diff timeouts across
   * profile changes.
   */
  profileName?: string;
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
      const model = input.modelFor ? input.modelFor(tier) : undefined;
      await input.logger.log({
        kind: "timeout",
        ts: timestamp(),
        tool: input.tool,
        tier,
        timeout_ms: timeoutMs,
        ...(model ? { model } : {}),
        ...(input.profileName ? { profile_name: input.profileName } : {}),
      });
      const next = allowFallback ? TIER_FALLBACK[tier] : null;
      if (!next) {
        // Include model (if available), elapsed, budget, and whether a
        // fallback was even attempted. "timeout" alone is useless for
        // debugging — a human reading the error should be able to tell
        // whether this was a cold-load issue, a true runaway call, or a
        // cascade that ran out of runway.
        const elapsedMs = Date.now() - startedAt;
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
          `Increase the tier's timeout (switch INTERN_PROFILE — dev profiles run Instant at 15s, m5-max at 5s), reduce input size, or ensure the model is resident ('ollama ps' / check /api/ps). Fallback target ${TIER_FALLBACK[tier] ?? "(none — terminal tier)"} ${fallbackFrom ? "was exhausted." : "was not used."}`,
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
        ...(input.profileName ? { profile_name: input.profileName } : {}),
      });
      return attempt(next, fallbackFrom ?? tier);
    } finally {
      clearTimeout(timer);
    }
  }
}
