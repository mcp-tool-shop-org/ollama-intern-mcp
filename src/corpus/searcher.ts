/**
 * Corpus search dispatcher — picks the retrieval strategy and returns
 * ranked hits with a stable tie-break. No synthesis here: the answer
 * flagship builds on top of this.
 *
 * Modes:
 *   - semantic   : dense cosine only (pre-slice-3 behavior)
 *   - lexical    : BM25 only, never calls embed
 *   - hybrid     : RRF-fused semantic + lexical, default mode
 *   - fact       : hybrid + exact-substring boost + short-chunk preference
 *   - title_path : pure metadata (lexical with body weight = 0), no embed
 *
 * Mode choice controls whether the query is embedded at all; `lexical`
 * and `title_path` skip the embed round-trip entirely, so the model
 * mismatch check only fires on modes that actually touch the embed rail.
 *
 * Tie-break: score desc, then (path asc, chunk_index asc). Zero-score
 * chunks are dropped before top_k slicing.
 */

import type { OllamaClient } from "../ollama.js";
import { rankByCosine } from "../embedMath.js";
import { InternError } from "../errors.js";
import type { ChunkType } from "./chunker.js";
import { buildLexicalIndex, scoreLexical, type LexicalIndex } from "./lexical.js";
import { applyFactBoost, rrfFuse, toRanked } from "./fusion.js";
import type { CorpusChunk, CorpusFile } from "./storage.js";

export type SearchMode = "semantic" | "lexical" | "hybrid" | "fact" | "title_path";

export const DEFAULT_SEARCH_MODE: SearchMode = "hybrid";

export const SEARCH_MODES: readonly SearchMode[] = [
  "semantic",
  "lexical",
  "hybrid",
  "fact",
  "title_path",
] as const;

export interface CorpusHit {
  id: string;
  path: string;
  score: number;
  chunk_index: number;
  char_start: number;
  char_end: number;
  heading_path: string[];
  chunk_type: ChunkType;
  title: string | null;
  preview?: string;
}

export interface SearchParams {
  corpus: CorpusFile;
  query: string;
  model: string;
  mode?: SearchMode;
  top_k?: number;
  preview_chars?: number;
  client: OllamaClient;
}

function modeRequiresEmbedding(mode: SearchMode): boolean {
  return mode === "semantic" || mode === "hybrid" || mode === "fact";
}

function stableSort(hits: CorpusHit[]): CorpusHit[] {
  return hits.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.chunk_index - b.chunk_index;
  });
}

function toHit(
  c: CorpusChunk,
  score: number,
  corpus: CorpusFile,
  previewChars: number,
): CorpusHit {
  return {
    id: c.id,
    path: c.path,
    score,
    chunk_index: c.chunk_index,
    char_start: c.char_start,
    char_end: c.char_end,
    heading_path: c.heading_path,
    chunk_type: c.chunk_type,
    title: corpus.titles?.[c.path] ?? null,
    ...(previewChars > 0 ? { preview: c.text.slice(0, previewChars) } : {}),
  };
}

async function scoreDense(
  params: SearchParams,
): Promise<Array<{ chunkId: string; score: number }>> {
  const resp = await params.client.embed({ model: params.model, input: params.query });
  if (resp.embeddings.length === 0) {
    throw new Error("Embed returned no vectors for query");
  }
  const queryVec = resp.embeddings[0];
  const ranked = rankByCosine(
    queryVec,
    params.corpus.chunks.map((c: CorpusChunk) => ({ item: c, vec: c.vector })),
  );
  // Drop non-positive cosines — they carry no useful similarity signal
  // and would otherwise seed spurious ranks into RRF fusion.
  return ranked.filter((r) => r.score > 0).map((r) => ({ chunkId: r.item.id, score: r.score }));
}

function scoreLex(
  query: string,
  index: LexicalIndex,
  mode: SearchMode,
): Array<{ chunkId: string; score: number }> {
  // title_path suppresses the body field; other modes use default weights.
  const opts = mode === "title_path" ? { weights: { body: 0 } } : {};
  return scoreLexical(query, index, opts).map((r) => ({
    chunkId: r.chunkId,
    score: r.score,
  }));
}

export async function searchCorpus(params: SearchParams): Promise<CorpusHit[]> {
  const mode = params.mode ?? DEFAULT_SEARCH_MODE;
  if (params.corpus.chunks.length === 0) return [];

  if (modeRequiresEmbedding(mode) && params.corpus.model_version !== params.model) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${params.corpus.name}" was indexed with model "${params.corpus.model_version}", but active embed tier is "${params.model}". Mode "${mode}" requires embedding the query.`,
      `Re-index with the current embed model, or call with mode: "lexical" or "title_path" — those don't embed.`,
      false,
    );
  }

  const topK = params.top_k ?? params.corpus.chunks.length;
  const previewChars = params.preview_chars ?? 0;
  const chunkById = new Map(params.corpus.chunks.map((c) => [c.id, c]));

  let lexicalIndex: LexicalIndex | null = null;
  if (mode !== "semantic") {
    lexicalIndex = buildLexicalIndex(params.corpus.chunks, params.corpus.titles ?? {});
  }

  let denseScored: Array<{ chunkId: string; score: number }> | null = null;
  if (modeRequiresEmbedding(mode)) {
    denseScored = await scoreDense(params);
  }

  let lexicalScored: Array<{ chunkId: string; score: number }> | null = null;
  if (mode !== "semantic") {
    lexicalScored = scoreLex(params.query, lexicalIndex!, mode);
  }

  let finalScores: Array<{ chunkId: string; score: number }>;

  if (mode === "semantic") {
    finalScores = denseScored!;
  } else if (mode === "lexical" || mode === "title_path") {
    finalScores = lexicalScored!;
  } else {
    // hybrid and fact: RRF-fuse dense + lexical.
    const fused = rrfFuse([
      { ranked: toRanked(denseScored!), weight: 1.0 },
      { ranked: toRanked(lexicalScored!), weight: 1.0 },
    ]);
    finalScores = [...fused.entries()].map(([chunkId, score]) => ({ chunkId, score }));
    if (mode === "fact") {
      const chunkText = new Map<string, string>();
      for (const c of params.corpus.chunks) chunkText.set(c.id, c.text);
      finalScores = applyFactBoost(finalScores, { query: params.query, chunkText });
    }
  }

  const hits: CorpusHit[] = [];
  for (const { chunkId, score } of finalScores) {
    if (score <= 0) continue;
    const c = chunkById.get(chunkId);
    if (!c) continue;
    hits.push(toHit(c, score, params.corpus, previewChars));
  }

  return stableSort(hits).slice(0, topK);
}
