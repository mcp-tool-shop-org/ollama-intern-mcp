/**
 * ollama_corpus_index — build or update a named corpus on disk.
 *
 * Tier: Embed. Idempotent: unchanged files are reused from the existing
 * corpus (by sha256); changed files are re-embedded; removed files are
 * dropped from the corpus.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { indexCorpus, type IndexReport } from "../corpus/indexer.js";
import { assertValidCorpusName } from "../corpus/storage.js";
import type { RunContext } from "../runContext.js";

export const corpusIndexSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .describe("Corpus name (e.g. 'memory', 'canon', 'handbook'). Maps to a file under ~/.ollama-intern/corpora/."),
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Absolute file paths to include in the corpus. Unchanged files are reused from the existing corpus by sha256."),
  chunk_chars: z
    .number()
    .int()
    .min(100)
    .max(8000)
    .optional()
    .describe("Chars per chunk (default 800)."),
  chunk_overlap: z
    .number()
    .int()
    .min(0)
    .max(4000)
    .optional()
    .describe("Overlap between adjacent chunks (default 100)."),
});

export type CorpusIndexInput = z.infer<typeof corpusIndexSchema>;

export async function handleCorpusIndex(
  input: CorpusIndexInput,
  ctx: RunContext,
): Promise<Envelope<IndexReport>> {
  assertValidCorpusName(input.name);
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);

  const report = await indexCorpus({
    name: input.name,
    paths: input.paths,
    model,
    chunk_chars: input.chunk_chars,
    chunk_overlap: input.chunk_overlap,
    client: ctx.client,
  });

  const residency = await ctx.client.residency(model);

  // Approximate token count: chars/4 for what was embedded this run.
  const approxTokensIn = Math.ceil((report.total_chars / 4));

  const envelope = buildEnvelope<IndexReport>({
    result: report,
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: approxTokensIn,
    tokensOut: 0,
    startedAt,
    residency,
  });

  await ctx.logger.log(callEvent("ollama_corpus_index", envelope, input));
  return envelope;
}
