/**
 * Shared tool-runner — wires timeout/fallback, Ollama generate, envelope,
 * residency probe, and NDJSON logging so each tool handler stays thin.
 *
 * Tools describe *what* they want; the runner handles *how*.
 */

import type { OllamaClient, GenerateRequest } from "../ollama.js";
import { countTokens } from "../ollama.js";
import type { Tier, TierConfig } from "../tiers.js";
import { resolveTier } from "../tiers.js";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import type { Logger } from "../observability.js";
import { callEvent } from "../observability.js";
import { runWithTimeoutAndFallback } from "../guardrails/timeouts.js";

export interface RunToolInput<T> {
  tool: string;
  tier: Tier;
  tierConfig: TierConfig;
  client: OllamaClient;
  logger: Logger;
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

  const { value, actualTier, fallbackFrom } = await runWithTimeoutAndFallback({
    tool: input.tool,
    tier: input.tier,
    logger: input.logger,
    allowFallback: input.allowFallback,
    run: async (tier, signal) => {
      const model = resolveTier(tier, input.tierConfig);
      const req = input.build(tier, model);
      const resp = await input.client.generate(req, signal);
      return { resp, model };
    },
  });

  const { resp, model } = value;
  const tokens = countTokens(resp);
  const result = input.parse(resp.response);
  const residency = await input.client.residency(model);

  const envelope = buildEnvelope<T>({
    result,
    tier: actualTier,
    model,
    tokensIn: tokens.in,
    tokensOut: tokens.out,
    startedAt,
    residency,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
  });

  await input.logger.log(callEvent(input.tool, envelope));
  return envelope;
}
