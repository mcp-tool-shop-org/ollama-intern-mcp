/**
 * Corpus indexer — read files, chunk, embed in batches, persist.
 *
 * Idempotent by file hash: if a path's sha256 matches what's already in
 * the corpus under the same model_version, chunks for that path are
 * reused verbatim (no re-embedding). Files no longer in the input set
 * are dropped. New or changed files are embedded fresh.
 *
 * This means `index` can be called repeatedly in daily use without
 * burning the embed tier on unchanged content.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { OllamaClient } from "../ollama.js";
import { chunk, DEFAULT_CHUNK, type ChunkOptions } from "./chunker.js";
import { CORPUS_SCHEMA_VERSION, loadCorpus, saveCorpus, type CorpusChunk, type CorpusFile } from "./storage.js";
import { InternError } from "../errors.js";

const EMBED_BATCH = 64;

export interface IndexParams {
  name: string;
  paths: string[];
  model: string;
  chunk_chars?: number;
  chunk_overlap?: number;
  client: OllamaClient;
}

export interface IndexReport {
  name: string;
  model_version: string;
  documents: number;
  chunks: number;
  total_chars: number;
  reused_chunks: number;
  newly_embedded_chunks: number;
  dropped_files: string[];
  elapsed_ms: number;
}

async function sha256File(path: string): Promise<{ hash: string; mtime: string; content: string }> {
  const content = await readFile(path, "utf8");
  const hash = "sha256:" + createHash("sha256").update(content).digest("hex");
  const st = await stat(path);
  return { hash, mtime: st.mtime.toISOString(), content };
}

export async function indexCorpus(params: IndexParams): Promise<IndexReport> {
  const t0 = Date.now();
  const opts: ChunkOptions = {
    chunk_chars: params.chunk_chars ?? DEFAULT_CHUNK.chunk_chars,
    chunk_overlap: params.chunk_overlap ?? DEFAULT_CHUNK.chunk_overlap,
  };

  // Load existing corpus (if any) to reuse unchanged chunks.
  const existing = await loadCorpus(params.name);
  const reusable = new Map<string, CorpusChunk[]>();
  if (existing && existing.model_version === params.model) {
    for (const c of existing.chunks) {
      const key = `${c.path}::${c.file_hash}`;
      const arr = reusable.get(key) ?? [];
      arr.push(c);
      reusable.set(key, arr);
    }
  }

  const allChunks: CorpusChunk[] = [];
  let reusedCount = 0;
  let newlyEmbeddedCount = 0;
  let totalChars = 0;
  const seenPaths = new Set<string>();

  // Pass 1: read + hash every input, reuse where possible, collect chunks to embed.
  const toEmbedTexts: string[] = [];
  const toEmbedMeta: Array<{
    path: string;
    file_hash: string;
    file_mtime: string;
    chunk_index: number;
    char_start: number;
    char_end: number;
    text: string;
  }> = [];

  for (const rawPath of params.paths) {
    const absPath = resolve(rawPath);
    seenPaths.add(absPath);
    let fileInfo: { hash: string; mtime: string; content: string };
    try {
      fileInfo = await sha256File(absPath);
    } catch (err) {
      throw new InternError(
        "SOURCE_PATH_NOT_FOUND",
        `Cannot read input file: ${rawPath} — ${(err as Error).message}`,
        "Check the path exists and is readable.",
        false,
      );
    }
    totalChars += fileInfo.content.length;
    const reuseKey = `${absPath}::${fileInfo.hash}`;
    const reused = reusable.get(reuseKey);
    if (reused && reused.length > 0) {
      allChunks.push(...reused);
      reusedCount += reused.length;
      continue;
    }
    // Fresh chunking for this file.
    const chunks = chunk(fileInfo.content, opts);
    for (const ck of chunks) {
      toEmbedMeta.push({
        path: absPath,
        file_hash: fileInfo.hash,
        file_mtime: fileInfo.mtime,
        chunk_index: ck.index,
        char_start: ck.char_start,
        char_end: ck.char_end,
        text: ck.text,
      });
      toEmbedTexts.push(ck.text);
    }
  }

  // Pass 2: embed everything that needs embedding, in batches.
  if (toEmbedTexts.length > 0) {
    for (let i = 0; i < toEmbedTexts.length; i += EMBED_BATCH) {
      const batch = toEmbedTexts.slice(i, i + EMBED_BATCH);
      const resp = await params.client.embed({ model: params.model, input: batch });
      if (resp.embeddings.length !== batch.length) {
        throw new Error(
          `Embed returned ${resp.embeddings.length} vectors for ${batch.length} inputs`,
        );
      }
      for (let j = 0; j < batch.length; j++) {
        const meta = toEmbedMeta[i + j];
        allChunks.push({
          id: `${params.name}-${allChunks.length.toString(16).padStart(6, "0")}`,
          path: meta.path,
          file_hash: meta.file_hash,
          file_mtime: meta.file_mtime,
          chunk_index: meta.chunk_index,
          char_start: meta.char_start,
          char_end: meta.char_end,
          text: meta.text,
          vector: resp.embeddings[j],
        });
        newlyEmbeddedCount += 1;
      }
    }
  }

  // Drop files that were in the old corpus but not in the input.
  const droppedFiles: string[] = [];
  if (existing) {
    const previousPaths = new Set(existing.chunks.map((c) => c.path));
    for (const p of previousPaths) {
      if (!seenPaths.has(p)) droppedFiles.push(p);
    }
  }

  const corpus: CorpusFile = {
    schema_version: CORPUS_SCHEMA_VERSION,
    name: params.name,
    model_version: params.model,
    model_digest: null,
    indexed_at: new Date().toISOString(),
    chunk_chars: opts.chunk_chars,
    chunk_overlap: opts.chunk_overlap,
    stats: {
      documents: new Set(allChunks.map((c) => c.path)).size,
      chunks: allChunks.length,
      total_chars: totalChars,
    },
    chunks: allChunks,
  };

  await saveCorpus(corpus);

  return {
    name: corpus.name,
    model_version: corpus.model_version,
    documents: corpus.stats.documents,
    chunks: corpus.stats.chunks,
    total_chars: corpus.stats.total_chars,
    reused_chunks: reusedCount,
    newly_embedded_chunks: newlyEmbeddedCount,
    dropped_files: droppedFiles,
    elapsed_ms: Date.now() - t0,
  };
}
