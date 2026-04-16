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
}

export async function runTool<T>(input: RunToolInput<T>): Promise<Envelope<T>> {
  const startedAt = Date.now();
  const { ctx } = input;

  const { value, actualTier, fallbackFrom } = await runWithTimeoutAndFallback({
    tool: input.tool,
    tier: input.tier,
    logger: ctx.logger,
    allowFallback: input.allowFallback,
    run: async (tier, signal) => {
      const model = resolveTier(tier, ctx.tiers);
      const req = input.build(tier, model);
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
    ...(input.warnings ? { warnings: input.warnings } : {}),
  });

  await ctx.logger.log(callEvent(input.tool, envelope));
  return envelope;
}
