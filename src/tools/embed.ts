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

/**
 * Payload-size warning threshold. Exported for tests so the invariant
 * "warnings fire when payload crosses 500KB" stays codified and not a
 * floating magic number in an assertion.
 *
 * 500 KB corresponds to roughly 130 768-dim float32 vectors serialized
 * as JSON text — well under Node/MCP transport limits, but past the
 * point where batch-level concept search via ollama_embed_search is a
 * strictly better shape.
 */
export const EMBED_PAYLOAD_WARN_BYTES = 500 * 1024;

/**
 * Compute the approximate JSON-wire size of the embeddings array. We
 * don't serialize the full envelope to measure — just the vectors, since
 * they're what blows the budget at scale. Each number is counted as a
 * fixed 9-byte estimate (e.g. "-0.123456,") which tracks real JSON
 * payloads to within a few percent.
 */
export function estimateEmbeddingsBytes(embeddings: number[][]): number {
  let total = 2; // enclosing "[]"
  for (const row of embeddings) {
    total += 2 + row.length * 9; // "[" + nums + "]"
  }
  return total;
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

  // Payload-size warning: large raw-vector responses can overflow MCP
  // tool-output limits. We surface a warning (never refuse — some callers
  // genuinely want the raw geometry) and point at ollama_embed_search as
  // the preferred shape for concept search.
  const warnings: string[] = [];
  const approxBytes = estimateEmbeddingsBytes(resp.embeddings);
  if (approxBytes > EMBED_PAYLOAD_WARN_BYTES) {
    warnings.push(
      `ollama_embed returned ~${Math.round(approxBytes / 1024)}KB of raw vectors (threshold ${Math.round(EMBED_PAYLOAD_WARN_BYTES / 1024)}KB). Large batches can overflow MCP tool-output limits; prefer ollama_embed_search for concept search (it returns ranked hits, not raw vectors) or ollama_corpus_index + ollama_corpus_search for persistent recall.`,
    );
  }

  const envelope = buildEnvelope<EmbedResult>({
    result,
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: batch.reduce((n, s) => n + Math.ceil(s.length / 4), 0),
    tokensOut: 0,
    startedAt,
    residency,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  await ctx.logger.log(callEvent("ollama_embed", envelope));
  return envelope;
}
