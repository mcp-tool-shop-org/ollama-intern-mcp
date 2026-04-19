/**
 * ollama_embed_search — FLAGSHIP concept-search mode.
 *
 * Claude passes a query + candidates[{id, text}]; the server embeds all of
 * them in one batch, computes cosine similarity, and returns a ranked list
 * of {id, score, preview?}. No raw vectors cross the MCP boundary — that's
 * the whole point. The sibling ollama_embed tool still returns raw vectors
 * for callers building external indexes.
 *
 * Tier: Embed.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { rankByCosine } from "../embedMath.js";
import type { RunContext } from "../runContext.js";

export const embedSearchSchema = z.object({
  query: z.string().min(1).describe("The question or concept to search for."),
  candidates: z
    .array(
      z.object({
        id: z.string().min(1).describe("Caller-chosen identifier returned unchanged in the ranking."),
        text: z.string().min(1).describe("Candidate text to compare against the query."),
      }),
    )
    .min(1)
    .max(256)
    .describe("Candidates to rank. 1-256 items; text is what gets embedded, id is what gets ranked."),
  top_k: z.number().int().min(1).max(256).optional().describe("Return only the top K candidates (default: all of them)."),
  preview_chars: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe("Include this many chars of each candidate's text in the result (default 0 = no preview)."),
});

export type EmbedSearchInput = z.infer<typeof embedSearchSchema>;

export interface EmbedSearchHit {
  id: string;
  score: number;
  preview?: string;
}

export interface EmbedSearchResult {
  ranked: EmbedSearchHit[];
  model_version: string;
  candidates_embedded: number;
}

export async function handleEmbedSearch(
  input: EmbedSearchInput,
  ctx: RunContext,
): Promise<Envelope<EmbedSearchResult>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);
  const previewChars = input.preview_chars ?? 0;
  const topK = input.top_k ?? input.candidates.length;

  // One embed call for query + all candidates; split the result by index.
  const inputs = [input.query, ...input.candidates.map((c) => c.text)];
  const resp = await ctx.client.embed({ model, input: inputs });
  if (resp.embeddings.length !== inputs.length) {
    // Defensive — shouldn't happen, but if the embed server returns the wrong
    // count we can't trust the ranking.
    throw new Error(
      `Embed returned ${resp.embeddings.length} vectors for ${inputs.length} inputs`,
    );
  }
  const [queryVec, ...candVecs] = resp.embeddings;

  const ranked = rankByCosine(
    queryVec,
    input.candidates.map((c, i) => ({ item: c, vec: candVecs[i] })),
  )
    .slice(0, topK)
    .map<EmbedSearchHit>((r) => ({
      id: r.item.id,
      score: r.score,
      ...(previewChars > 0 ? { preview: r.item.text.slice(0, previewChars) } : {}),
    }));

  const residency = await ctx.client.residency(model);
  const tokensIn = inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0);

  const envelope = buildEnvelope<EmbedSearchResult>({
    result: {
      ranked,
      model_version: model,
      candidates_embedded: input.candidates.length,
    },
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut: 0,
    startedAt,
    residency,
  });

  await ctx.logger.log(callEvent("ollama_embed_search", envelope, input));
  return envelope;
}
