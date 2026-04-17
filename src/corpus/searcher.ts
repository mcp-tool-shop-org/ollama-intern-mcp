/**
 * Corpus searcher — embed the query once, cosine-rank against stored
 * chunk vectors, return ranked hits. Vectors never cross the boundary.
 */

import type { OllamaClient } from "../ollama.js";
import { rankByCosine } from "../embedMath.js";
import { InternError } from "../errors.js";
import type { ChunkType } from "./chunker.js";
import type { CorpusChunk, CorpusFile } from "./storage.js";

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
  top_k?: number;
  preview_chars?: number;
  client: OllamaClient;
}

export async function searchCorpus(params: SearchParams): Promise<CorpusHit[]> {
  if (params.corpus.model_version !== params.model) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${params.corpus.name}" was indexed with model "${params.corpus.model_version}", but active embed tier is "${params.model}"`,
      "Re-index with the current embed model, or change INTERN_EMBED_MODEL to match.",
      false,
    );
  }
  if (params.corpus.chunks.length === 0) return [];

  const resp = await params.client.embed({ model: params.model, input: params.query });
  if (resp.embeddings.length === 0) {
    throw new Error("Embed returned no vectors for query");
  }
  const queryVec = resp.embeddings[0];

  const ranked = rankByCosine(
    queryVec,
    params.corpus.chunks.map((c: CorpusChunk) => ({ item: c, vec: c.vector })),
  );

  const topK = params.top_k ?? ranked.length;
  const preview = params.preview_chars ?? 0;

  return ranked.slice(0, topK).map<CorpusHit>((r) => ({
    id: r.item.id,
    path: r.item.path,
    score: r.score,
    chunk_index: r.item.chunk_index,
    char_start: r.item.char_start,
    char_end: r.item.char_end,
    heading_path: r.item.heading_path,
    chunk_type: r.item.chunk_type,
    title: params.corpus.titles?.[r.item.path] ?? null,
    ...(preview > 0 ? { preview: r.item.text.slice(0, preview) } : {}),
  }));
}
