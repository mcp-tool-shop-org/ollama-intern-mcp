/**
 * ollama_memory_explain — deterministic legibility for a retrieval result.
 *
 * Answers: "for this query + these filters, why does THIS record match?"
 * Pure — no model call, no fresh embedding. Derives everything from the
 * stored record + tokenized query + filter predicates.
 *
 * The caller already knows the cosine score from their preceding
 * ollama_memory_search call; this surface is for the WHAT, not the score.
 * If no tokens overlap but cosine was strong, that's a legitimate semantic
 * match and the response explicitly calls it out in `notes`.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import { memoryKindSchema } from "../memory/types.js";
import { explainRecord, type MemoryExplainResult } from "../memory/explain.js";

const facetPredicateSchema = z.object({
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const memoryExplainSchema = z.object({
  memory_id: z.string().min(1).describe("Id of the memory record to explain."),
  query: z.string().min(1).describe("The query text the caller used in ollama_memory_search. Server tokenizes it; no embedding is computed by default."),
  filters: z
    .object({
      kinds: z.array(memoryKindSchema).optional(),
      tags: z.array(z.string().min(1)).optional(),
      facets: z.record(facetPredicateSchema).optional(),
      since: z.string().optional(),
    })
    .optional()
    .describe("The same filter block passed to the preceding ollama_memory_search call."),
  narrate: z
    .boolean()
    .optional()
    .describe("Opt-in: produce a ONE-sentence plain-English 'why this matched' via the Instant tier. Default false keeps the response deterministic. Narration is grounded in the deterministic facts (tokens, predicates), not the underlying text of the record."),
});

export type MemoryExplainInput = z.infer<typeof memoryExplainSchema>;

export async function handleMemoryExplain(
  input: MemoryExplainInput,
  ctx: RunContext,
): Promise<Envelope<MemoryExplainResult>> {
  const startedAt = Date.now();
  let result: MemoryExplainResult;
  try {
    result = await explainRecord(input.memory_id, {
      query: input.query,
      filters: input.filters,
      narrate: input.narrate,
      client: input.narrate ? ctx.client : undefined,
      instantModel: input.narrate ? ctx.tiers.instant : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InternError(
      "SCHEMA_INVALID",
      msg,
      "Pass a valid memory_id and the same query you used in ollama_memory_search.",
      false,
    );
  }

  const warnings: string[] = [];
  if (!result.filter_effects.passed_prefilter) warnings.push("Record does NOT pass the provided filters.");
  if (result.total_matched_tokens === 0) warnings.push("Zero lexical overlap with the query — if search returned this record, the match is purely semantic (embedding-space).");

  const envelope = buildEnvelope<MemoryExplainResult>({
    result,
    tier: input.narrate ? "instant" : "instant",
    model: input.narrate ? ctx.tiers.instant : "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  await ctx.logger.log(callEvent("ollama_memory_explain", envelope, input));
  return envelope;
}
