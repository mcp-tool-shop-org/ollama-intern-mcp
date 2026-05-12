/**
 * Shared tool-runner — wires timeout/fallback, Ollama generate, envelope,
 * residency probe, and NDJSON logging so each tool handler stays thin.
 *
 * Tools describe *what* they want; the runner handles *how*.
 */

import type { GenerateRequest } from "../ollama.js";
import { countTokens } from "../ollama.js";
import type { Tier } from "../tiers.js";
import { resolveTier } from "../tiers.js";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { runWithTimeoutAndFallback } from "../guardrails/timeouts.js";
import type { RunContext } from "../runContext.js";

export interface RunToolInput<T> {
  tool: string;
  tier: Tier;
  ctx: RunContext;
  allowFallback?: boolean;
  /** Build the generate request for the given (possibly-fallback) tier. */
  build: (tier: Tier, model: string) => GenerateRequest;
  /** Turn the raw model response into the tool's result shape. */
  parse: (raw: string) => T;
  /** Optional extra warnings from guardrails (e.g. stripped citations). */
  warnings?: string[];
  /**
   * Override `think` on the generate request. If unset, inherits whatever
   * build() set. Recommended: tools set it explicitly per shape via
   * THINK_BY_SHAPE so Qwen 3 thinking behavior is predictable. Non-thinking
   * models (hermes3:8b) ignore the field.
   */
  think?: boolean;
  /**
   * Optional per-call model override (atom tools only — added v2.3.0). When
   * set, the FIRST attempt on the requested tier runs against this model
   * instead of the tier-resolved default. On timeout, fallback retries
   * resolve their model from the fallback tier — NOT this override. The
   * caller-asked model is propagated to `envelope.model_requested` so
   * receipt-backed orchestrators can detect substitution by comparing
   * `model_requested` vs `model`.
   */
  modelOverride?: string;
}

export async function runTool<T>(input: RunToolInput<T>): Promise<Envelope<T>> {
  const startedAt = Date.now();
  const { ctx } = input;
  const initialTier = input.tier;

  const { value, actualTier, fallbackFrom } = await runWithTimeoutAndFallback({
    tool: input.tool,
    tier: input.tier,
    logger: ctx.logger,
    allowFallback: input.allowFallback,
    timeoutOverrideMs: ctx.timeouts,
    run: async (tier, signal) => {
      // Per-call model override applies ONLY to the initial attempt. Any
      // fallback retry resolves its model from the fallback tier so the
      // degraded path remains predictable (caller's chosen model may not
      // even fit the cheaper tier's role).
      const model =
        input.modelOverride !== undefined && tier === initialTier
          ? input.modelOverride
          : resolveTier(tier, ctx.tiers);
      const built = input.build(tier, model);
      const req: GenerateRequest = input.think === undefined ? built : { ...built, think: input.think };
      const resp = await ctx.client.generate(req, signal);
      return { resp, model };
    },
  });

  const { resp, model } = value;
  const tokens = countTokens(resp);
  const result = input.parse(resp.response);
  const residency = await ctx.client.residency(model);

  const envelope = buildEnvelope<T>({
    result,
    tier: actualTier,
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: tokens.in,
    tokensOut: tokens.out,
    startedAt,
    residency,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    ...(input.modelOverride !== undefined ? { modelRequested: input.modelOverride } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
  });

  await ctx.logger.log(callEvent(input.tool, envelope));
  return envelope;
}
