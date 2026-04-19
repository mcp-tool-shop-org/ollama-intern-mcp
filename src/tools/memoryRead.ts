/**
 * ollama_memory_read — typed, provenance-backed view of one memory record.
 *
 * This is NOT a file reader. It returns the stored record, a typed
 * resolved-provenance block (path, existence, per-kind identity, a
 * read_hint pointing to the right tool for the underlying file), age,
 * and any content-digest duplicates. The memory layer stays compact —
 * opening the underlying artifact/receipt/skill is the caller's job via
 * the hinted tool.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import { readMemory, type MemoryReadResult } from "../memory/explain.js";

export const memoryReadSchema = z.object({
  memory_id: z.string().min(1).describe("Id of the memory record to read. Get one from ollama_memory_search or ollama_memory_refresh."),
  include_excerpt: z
    .boolean()
    .optional()
    .describe("Opt-in: pull a TYPED STRUCTURED excerpt from the source file — step summaries for receipts, pipeline + promotion_history for skills, section_counts + headline for artifacts. Bounded, never raw envelopes. Default false keeps the response compact and deterministic."),
});

export type MemoryReadInput = z.infer<typeof memoryReadSchema>;

export async function handleMemoryRead(
  input: MemoryReadInput,
  ctx: RunContext,
): Promise<Envelope<MemoryReadResult>> {
  const startedAt = Date.now();
  let result: MemoryReadResult;
  try {
    result = await readMemory(input.memory_id, { include_excerpt: input.include_excerpt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InternError(
      "SCHEMA_INVALID",
      msg,
      "Pass a valid memory_id from ollama_memory_search or ollama_memory_refresh.drift.added_ids.",
      false,
    );
  }

  const warnings: string[] = [];
  if (!result.provenance_resolved.exists) warnings.push(`Source file missing at ${result.record.provenance.source_path}.`);
  if (result.duplicates.length > 0) warnings.push(`Record has ${result.duplicates.length} content-digest duplicate(s).`);
  if (result.age.stale) warnings.push(`Record is ${result.age.age_days} days old — stale threshold is 30.`);

  const envelope = buildEnvelope<MemoryReadResult>({
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
  await ctx.logger.log(callEvent("ollama_memory_read", envelope, input));
  return envelope;
}
