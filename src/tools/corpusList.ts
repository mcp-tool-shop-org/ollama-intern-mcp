/**
 * ollama_corpus_list — discover available corpora with stats.
 *
 * No Ollama call, no embed — just reads the corpora directory. Useful
 * when you've forgotten whether you already indexed something, or want
 * to confirm which corpus has the freshest `indexed_at`.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { listCorpora, type CorpusSummary } from "../corpus/storage.js";
import type { RunContext } from "../runContext.js";

export const corpusListSchema = z.object({});

export type CorpusListInput = z.infer<typeof corpusListSchema>;

export interface CorpusListResult {
  corpora: CorpusSummary[];
  corpus_dir: string;
}

export async function handleCorpusList(
  _input: CorpusListInput,
  ctx: RunContext,
): Promise<Envelope<CorpusListResult>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);
  const corpora = await listCorpora();

  const envelope = buildEnvelope<CorpusListResult>({
    result: {
      corpora,
      corpus_dir: process.env.INTERN_CORPUS_DIR ?? "~/.ollama-intern/corpora",
    },
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });

  await ctx.logger.log(callEvent("ollama_corpus_list", envelope));
  return envelope;
}
