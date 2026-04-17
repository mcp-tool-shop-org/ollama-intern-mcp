/**
 * ollama_corpus_search — FLAGSHIP persistent concept search.
 *
 * Tier: Embed. Loads the named corpus from disk, embeds the query once,
 * cosine-ranks against stored chunk vectors, returns ranked hits. Raw
 * vectors never cross the MCP boundary.
 *
 * Use this to search memory/, canon/, handbook/, doctrine/, etc. by
 * concept — the filename-to-idea bridge the handoff called out as the
 * flagship user story.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { loadCorpus } from "../corpus/storage.js";
import { searchCorpus, DEFAULT_SEARCH_MODE, SEARCH_MODES, type CorpusHit, type SearchMode } from "../corpus/searcher.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const corpusSearchSchema = z.object({
  corpus: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .describe("Name of the corpus to search (e.g. 'memory', 'canon'). Must have been indexed first with ollama_corpus_index."),
  query: z.string().min(1).describe("Concept or question to search for."),
  mode: z
    .enum(SEARCH_MODES as unknown as [SearchMode, ...SearchMode[]])
    .optional()
    .describe(
      "Ranking strategy. 'hybrid' (default) fuses dense + lexical via RRF — best for general queries. 'semantic' is dense-only. 'lexical' is BM25-only (no embed call). 'fact' is hybrid with exact-substring + short-chunk boosts for specific-fact lookups. 'title_path' searches only title/heading/path metadata (no embed call, sub-ms).",
    ),
  top_k: z.number().int().min(1).max(100).optional().describe("Return the top K chunks (default 10)."),
  preview_chars: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe("Include this many chars of each chunk's text in the result (default 200)."),
});

export type CorpusSearchInput = z.infer<typeof corpusSearchSchema>;

export interface CorpusSearchResult {
  hits: CorpusHit[];
  corpus_name: string;
  model_version: string;
  total_chunks: number;
  mode: SearchMode;
}

export async function handleCorpusSearch(
  input: CorpusSearchInput,
  ctx: RunContext,
): Promise<Envelope<CorpusSearchResult>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);

  const corpus = await loadCorpus(input.corpus);
  if (!corpus) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${input.corpus}" does not exist`,
      `Build it first with ollama_corpus_index, or use ollama_corpus_list to see available corpora.`,
      false,
    );
  }

  const topK = input.top_k ?? 10;
  const previewChars = input.preview_chars ?? 200;
  const mode: SearchMode = input.mode ?? DEFAULT_SEARCH_MODE;

  const hits = await searchCorpus({
    corpus,
    query: input.query,
    model,
    mode,
    top_k: topK,
    preview_chars: previewChars,
    client: ctx.client,
  });

  // title_path and lexical never embed; skip the residency call too.
  const modeEmbeds = mode === "semantic" || mode === "hybrid" || mode === "fact";
  const residency = modeEmbeds ? await ctx.client.residency(model) : null;

  const envelope = buildEnvelope<CorpusSearchResult>({
    result: {
      hits,
      corpus_name: corpus.name,
      model_version: corpus.model_version,
      total_chunks: corpus.chunks.length,
      mode,
    },
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: Math.ceil(input.query.length / 4),
    tokensOut: 0,
    startedAt,
    residency,
  });

  await ctx.logger.log(callEvent("ollama_corpus_search", envelope));
  return envelope;
}
