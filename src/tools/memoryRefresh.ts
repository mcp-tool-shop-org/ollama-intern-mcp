/**
 * ollama_memory_refresh — scan all four operational sources, normalize into
 * memory records, reconcile with the prior index on disk, and reconcile
 * vector embeddings against the refreshed records. Idempotent: a no-change
 * refresh produces zero added/updated/removed for BOTH the index and the
 * embeddings.
 *
 * Phase 3A built the structural substrate. Phase 3B (this commit) extends
 * refresh so the embedding sidecar stays in sync by content_digest every
 * time records change — the classic "stale vector surviving a content
 * change" regression is caught at the refresh boundary.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { refreshMemory, type RefreshResult } from "../memory/refresh.js";
import { loadIndex } from "../memory/store.js";
import {
  refreshEmbeddings,
  type EmbeddingsDrift,
} from "../memory/embeddings.js";

export const memoryRefreshSchema = z.object({
  dry_run: z
    .boolean()
    .optional()
    .describe("When true, compute the drift report without writing the new index to disk. Useful for previewing what a refresh would change. Embedding refresh is also skipped under dry_run."),
  skip_candidates: z
    .boolean()
    .optional()
    .describe("When true, skip candidate_proposal synthesis (chain reconstruction over the NDJSON log). Default false."),
  skip_embeddings: z
    .boolean()
    .optional()
    .describe("When true, run ONLY the structural refresh — do not touch the embedding sidecar. Useful when Ollama is unreachable or you explicitly want a structural-only sync."),
  chain_gap_ms: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe("Silence gap (ms) used to split NDJSON events into ad-hoc chains. Default 180000 (3 min)."),
  new_skill_thresholds: z
    .object({
      min_support: z.number().int().min(1).optional(),
      min_success_rate: z.number().min(0).max(1).optional(),
      min_shape_agreement: z.number().min(0).max(1).optional(),
      min_sequence_length: z.number().int().min(1).optional(),
    })
    .optional()
    .describe("Override thresholds for turning ad-hoc chains into candidate_proposal records."),
});

export type MemoryRefreshInput = z.infer<typeof memoryRefreshSchema>;

export interface MemoryRefreshFullResult extends RefreshResult {
  embeddings: { skipped: true; reason: string } | EmbeddingsDrift;
}

export async function handleMemoryRefresh(
  input: MemoryRefreshInput,
  ctx: RunContext,
): Promise<Envelope<MemoryRefreshFullResult>> {
  const startedAt = Date.now();
  const structural = await refreshMemory({
    dryRun: input.dry_run,
    skip_candidates: input.skip_candidates,
    chain_gap_ms: input.chain_gap_ms,
    new_skill_thresholds: input.new_skill_thresholds,
  });

  let embeddingsResult: MemoryRefreshFullResult["embeddings"];
  if (input.dry_run) {
    embeddingsResult = { skipped: true, reason: "dry_run — structural drift reported only" };
  } else if (input.skip_embeddings) {
    embeddingsResult = { skipped: true, reason: "skip_embeddings=true" };
  } else {
    try {
      const index = await loadIndex();
      const drift = await refreshEmbeddings(index, {
        client: ctx.client,
        embedModel: ctx.tiers.embed,
      });
      embeddingsResult = drift.drift;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      embeddingsResult = { skipped: true, reason: `embedding refresh failed: ${msg}` };
    }
  }

  const result: MemoryRefreshFullResult = { ...structural, embeddings: embeddingsResult };

  const warnings: string[] = [];
  if (result.total_records === 0) warnings.push("Memory index is empty — run some skills, packs, or author skill files first.");
  if ("skipped" in embeddingsResult && embeddingsResult.skipped === true && !input.skip_embeddings && !input.dry_run) {
    warnings.push(`Embedding refresh was skipped: ${embeddingsResult.reason}`);
  }

  const envelope = buildEnvelope<MemoryRefreshFullResult>({
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
  await ctx.logger.log(callEvent("ollama_memory_refresh", envelope, input));
  return envelope;
}
