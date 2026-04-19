/**
 * ollama_memory_search — embedding-backed retrieval over memory records.
 *
 * Pre-filters by kind / tags / facets / since (hard predicates), then
 * cosine-ranks the survivors against the query embedding. Returns typed
 * hits carrying a score band (strong/medium/weak) and a reasons array so
 * Phase 3C can explain matches without re-running the query.
 *
 * Nomic prefixes are applied server-side — caller just passes the question.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { memoryKindSchema } from "../memory/types.js";
import { searchMemory, type MemorySearchResult } from "../memory/retrieval.js";

const facetPredicateSchema = z.object({
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const memorySearchSchema = z.object({
  query: z.string().min(1).describe("Free-text question. Server prepends nomic's `search_query:` task prefix automatically."),
  kinds: z.array(memoryKindSchema).optional().describe("Restrict results to these record kinds. Use ['skill_receipt'] for similar past runs, ['approved_skill'] for similar skills, ['pack_artifact'] for similar artifacts, ['candidate_proposal'] for similar captured workflows."),
  tags: z.array(z.string().min(1)).optional().describe("Each listed tag must appear on the record (AND)."),
  facets: z.record(facetPredicateSchema).optional().describe("Per-facet exact-equality predicates (AND). Example: {ok: {equals: true}, hardware_profile: {equals: 'dev-rtx5080'}}."),
  since: z.string().optional().describe("ISO timestamp. Only consider records with created_at >= since."),
  limit: z.number().int().min(1).max(50).optional().describe("Cap on returned hits (default 8)."),
});

export type MemorySearchInput = z.infer<typeof memorySearchSchema>;

export async function handleMemorySearch(
  input: MemorySearchInput,
  ctx: RunContext,
): Promise<Envelope<MemorySearchResult>> {
  const startedAt = Date.now();
  const result = await searchMemory(
    input.query,
    {
      kinds: input.kinds,
      tags: input.tags,
      facets: input.facets,
      since: input.since,
    },
    {
      client: ctx.client,
      embedModel: ctx.tiers.embed,
      limit: input.limit,
    },
  );

  const warnings: string[] = [];
  if (result.considered === 0) warnings.push("Memory index is empty — run ollama_memory_refresh first.");
  else if (result.candidates_after_prefilter === 0) warnings.push("Pre-filter matched zero records. Loosen kinds / tags / facets.");
  else if (result.weak) warnings.push("Top hit is in the weak band (<0.35 cosine). Caller should degrade honestly rather than act on this.");

  const envelope = buildEnvelope<MemorySearchResult>({
    result,
    tier: "embed",
    model: ctx.tiers.embed,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  await ctx.logger.log(callEvent("ollama_memory_search", envelope, input));
  return envelope;
}
