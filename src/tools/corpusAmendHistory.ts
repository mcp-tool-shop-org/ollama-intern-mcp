/**
 * ollama_corpus_amend_history — read-only companion to ollama_corpus_amend.
 *
 * Lists which paths have been amended on top of the disk snapshot, when the
 * amendments happened, and the chunk-count deltas. Use this before deciding
 * whether to re-index (ollama_corpus_index / ollama_corpus_refresh), which
 * re-establishes the "snapshot of disk" invariant and clears the history.
 *
 * No LLM call; pure manifest read.
 */

import { z } from "zod";
import { loadManifest } from "../corpus/manifest.js";
import { InternError } from "../errors.js";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";

export const corpusAmendHistorySchema = z.object({
  corpus: z
    .string()
    .min(1)
    .max(64)
    .describe("Corpus name (as passed to ollama_corpus_index)."),
});

export type CorpusAmendHistoryInput = z.infer<typeof corpusAmendHistorySchema>;

export interface CorpusAmendHistoryEntry {
  path: string;
  amended_at: string;
  chunks_before: number;
  chunks_after: number;
  chunks_delta: number;
}

export interface CorpusAmendHistoryResult {
  corpus: string;
  has_amended_content: boolean;
  amended_paths: CorpusAmendHistoryEntry[];
  total_amends: number;
  unique_paths_amended: number;
  last_amend_at: string | null;
  note: string;
}

export async function handleCorpusAmendHistory(
  input: CorpusAmendHistoryInput,
  ctx: RunContext,
): Promise<Envelope<CorpusAmendHistoryResult>> {
  const startedAt = Date.now();
  const manifest = await loadManifest(input.corpus);
  if (!manifest) {
    throw new InternError(
      "SOURCE_PATH_NOT_FOUND",
      `Corpus '${input.corpus}' not found.`,
      "Run ollama_corpus_list to see indexed corpora, or ollama_corpus_index to create one.",
      false,
    );
  }

  const raw = manifest.amended_paths ?? [];
  const entries: CorpusAmendHistoryEntry[] = raw.map((e) => ({
    path: e.path,
    amended_at: e.amended_at,
    chunks_before: e.chunks_before,
    chunks_after: e.chunks_after,
    chunks_delta: e.chunks_after - e.chunks_before,
  }));
  const uniquePaths = new Set(entries.map((e) => e.path));
  const lastAmendAt = entries.length > 0 ? entries[entries.length - 1].amended_at : null;

  const envelope = buildEnvelope<CorpusAmendHistoryResult>({
    result: {
      corpus: input.corpus,
      has_amended_content: manifest.has_amended_content === true,
      amended_paths: entries,
      total_amends: entries.length,
      unique_paths_amended: uniquePaths.size,
      last_amend_at: lastAmendAt,
      note:
        entries.length === 0
          ? "This corpus has no amend history — it mirrors the disk snapshot."
          : "Re-index (ollama_corpus_index or ollama_corpus_refresh) to restore the snapshot invariant and clear this history.",
    },
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });

  await ctx.logger.log(callEvent("ollama_corpus_amend_history", envelope));
  return envelope;
}
