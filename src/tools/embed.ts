/**
 * ollama_embed — FLAGSHIP TOOL.
 *
 * Batch-aware vector embeddings. Powers concept-search over memory/,
 * canon, doctrine, protocols — the bridge from filename search to idea search.
 *
 * Tier: Embed. Pin model version alongside vectors so drift is detectable.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import type { RunContext } from "../runContext.js";

export const embedSchema = z.object({
  input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(256)]).describe("Text or batch of texts to embed."),
});

export type EmbedInput = z.infer<typeof embedSchema>;

export interface EmbedResult {
  embeddings: number[][];
  model_version: string;
  count: number;
  dim: number;
}

export async function handleEmbed(
  input: EmbedInput,
  ctx: RunContext,
): Promise<Envelope<EmbedResult>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);
  const batch = Array.isArray(input.input) ? input.input : [input.input];

  const resp = await ctx.client.embed({ model, input: batch });
  const residency = await ctx.client.residency(model);

  const result: EmbedResult = {
    embeddings: resp.embeddings,
    model_version: model,
    count: resp.embeddings.length,
    dim: resp.embeddings[0]?.length ?? 0,
  };

  const envelope = buildEnvelope<EmbedResult>({
    result,
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: batch.reduce((n, s) => n + Math.ceil(s.length / 4), 0),
    tokensOut: 0,
    startedAt,
    residency,
  });

  await ctx.logger.log(callEvent("ollama_embed", envelope));
  return envelope;
}
