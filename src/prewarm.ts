/**
 * Targeted prewarm — pulls profile.prewarm tiers into VRAM at server startup
 * so the first real Claude call doesn't eat cold-load latency.
 *
 * Behavior is profile policy, not magic:
 *   - dev-rtx5080:        prewarm = ["instant"]
 *   - dev-rtx5080-llama:  prewarm = ["instant"]
 *   - m5-max:             prewarm = []  (cold-load on unified memory is ~free)
 *
 * Each prewarm attempt logs a {kind: "prewarm", ...} NDJSON event with
 * model, success/failure, elapsed_ms, and residency. That keeps benchmarks
 * able to distinguish cold from warm and keeps adoption data clean.
 *
 * Failures are logged but never thrown — server startup must not depend on
 * Ollama being reachable. If the model is missing or Ollama is down, the
 * server still comes up; the user sees the prewarm failure in the log.
 */

import { resolveTier, type Tier } from "./tiers.js";
import type { RunContext } from "./runContext.js";
import { timestamp } from "./observability.js";

/** Hard cap on per-tier prewarm wait. Long enough for a 14B cold load, short enough not to hang server startup. */
const PREWARM_TIMEOUT_MS = 60_000;

/**
 * Run prewarm for the given tiers. Each tier issues a minimal generate
 * (`prompt: "ok", num_predict: 1`) with `keep_alive: -1` so the model
 * stays resident afterwards.
 *
 * Returns the count of successful prewarms; never throws.
 */
export async function runPrewarm(ctx: RunContext, tiers: Tier[]): Promise<number> {
  let successes = 0;
  for (const tier of tiers) {
    const model = resolveTier(tier, ctx.tiers);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREWARM_TIMEOUT_MS);
    let success = false;
    let error: string | undefined;
    try {
      await ctx.client.generate(
        {
          model,
          prompt: "ok",
          options: { num_predict: 1, temperature: 0 },
          keep_alive: -1,
        },
        controller.signal,
      );
      success = true;
      successes++;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    const residency = success ? await ctx.client.residency(model).catch(() => null) : null;

    await ctx.logger.log({
      kind: "prewarm",
      ts: timestamp(),
      tier,
      model,
      hardware_profile: ctx.hardwareProfile,
      success,
      elapsed_ms: Date.now() - startedAt,
      residency,
      ...(error ? { error } : {}),
    });
  }
  return successes;
}
