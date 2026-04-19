/**
 * ollama_memory_neighbors — records near a given record in embedding space.
 *
 * Pure math — uses the source record's stored embedding against every
 * other record's stored embedding. No query, no model call. A neighbor
 * is a neighbor; this surface deliberately does NOT recommend or route.
 *
 * Results are typed: returned both as a flat ranked list and grouped by
 * kind, so the caller can answer "what other skill_receipts look like
 * this one" or "what approved_skill is nearest to this candidate
 * proposal" without further filtering.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import { memoryKindSchema } from "../memory/types.js";
import { neighborsOf, type MemoryNeighborsResult } from "../memory/explain.js";

export const memoryNeighborsSchema = z.object({
  memory_id: z.string().min(1).describe("Id of the anchor record whose neighbors you want."),
  kinds: z.array(memoryKindSchema).optional().describe("Restrict neighbors to these kinds. Omit to consider all kinds."),
  top_k: z.number().int().min(1).max(50).optional().describe("Cap on returned neighbors (default 8)."),
});

export type MemoryNeighborsInput = z.infer<typeof memoryNeighborsSchema>;

export async function handleMemoryNeighbors(
  input: MemoryNeighborsInput,
  ctx: RunContext,
): Promise<Envelope<MemoryNeighborsResult>> {
  const startedAt = Date.now();
  let result: MemoryNeighborsResult;
  try {
    result = await neighborsOf(input.memory_id, {
      kinds: input.kinds,
      top_k: input.top_k,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InternError(
      "SCHEMA_INVALID",
      msg,
      "Pass a valid memory_id. Run ollama_memory_refresh if the record exists but was just added.",
      false,
    );
  }

  const warnings: string[] = [];
  if (result.considered === 0) warnings.push("No embeddable candidates — either the anchor is missing its embedding or the filter excluded everything. Run ollama_memory_refresh.");
  else if (result.neighbors.length === 0) warnings.push("No positive-cosine neighbors found.");
  else if (result.neighbors[0].band === "weak") warnings.push("Top neighbor is in the weak band (<0.35 cosine).");

  const envelope = buildEnvelope<MemoryNeighborsResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  await ctx.logger.log(callEvent("ollama_memory_neighbors", envelope, input));
  return envelope;
}
