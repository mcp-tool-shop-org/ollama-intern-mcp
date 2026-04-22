/**
 * ollama_corpus_refresh — reconcile a named corpus against its manifest.
 *
 * Tier: Embed (only when actual re-embedding is needed). No-op refreshes
 * don't touch the embed rail at all.
 *
 * Single argument: `name`. All other parameters (paths, chunk_chars,
 * chunk_overlap, embed_model) live in the manifest — refresh is
 * faithful to what's declared there, not to whatever the caller feels
 * like passing this turn.
 *
 * Returns a drift report: added / changed / unchanged / deleted /
 * missing (per-path lists) plus reused / reembedded / dropped
 * (chunk-level counts) plus elapsed_ms and no_op.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { refreshCorpus, type RefreshReport } from "../corpus/refresh.js";
import type { RunContext } from "../runContext.js";

export const corpusRefreshSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .describe("Corpus to refresh. Must already have a manifest (created by ollama_corpus_index). Call ollama_corpus_list to see which corpora exist."),
  retry_failed: z
    .boolean()
    .optional()
    .describe(
      "When true, re-attempt any paths recorded as failed in the manifest (e.g. symlink rejects, TOCTOU races, oversized files). Default false — a normal refresh honors only the declared manifest paths. Use after you've fixed the underlying cause (resized the file, replaced the symlink, fixed permissions) to retry without re-indexing the whole corpus.",
    ),
});

export type CorpusRefreshInput = z.infer<typeof corpusRefreshSchema>;

export async function handleCorpusRefresh(
  input: CorpusRefreshInput,
  ctx: RunContext,
): Promise<Envelope<RefreshReport>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);

  const report = await refreshCorpus({
    name: input.name,
    model,
    client: ctx.client,
    retry_failed: input.retry_failed,
  });

  // Probe residency only if the refresh actually touched the embed rail.
  // A no-op refresh is the whole point of "idempotence is sacred" — we
  // don't want to pay for a residency probe just to report "nothing happened".
  const touchedEmbed = !report.no_op && report.reembedded_chunks > 0;
  const residency = touchedEmbed ? await ctx.client.residency(model) : null;

  // Approximate tokens_in from whatever we actually re-embedded.
  const tokensIn = report.reembedded_chunks > 0
    ? Math.ceil(report.reembedded_chunks * 200) // rough: ~200 tokens/chunk
    : 0;

  const envelope = buildEnvelope<RefreshReport>({
    result: report,
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut: 0,
    startedAt,
    residency,
  });

  await ctx.logger.log(callEvent("ollama_corpus_refresh", envelope));
  return envelope;
}
