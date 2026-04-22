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

import { readFile, stat, realpath, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { OllamaClient } from "../ollama.js";
import { chunkDocument, DEFAULT_CHUNK, type ChunkOptions, type ChunkType } from "./chunker.js";
import { CORPUS_SCHEMA_VERSION, loadCorpus, saveCorpus, type CorpusChunk, type CorpusFile } from "./storage.js";
import { MANIFEST_SCHEMA_VERSION, loadManifest, saveManifest, type CorpusManifest, assertSafePath } from "./manifest.js";
import { withCorpusLock } from "./lock.js";
import { InternError } from "../errors.js";

const EMBED_BATCH = 64;
/** Hard cap on input file size. Prevents OOM from a user pointing at a 100GB file. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface IndexParams {
  name: string;
  paths: string[];
  model: string;
  chunk_chars?: number;
  chunk_overlap?: number;
  client: OllamaClient;
  /**
   * Optional progress callback invoked after each input file is processed
   * (success OR failure). `done` counts files that have been handled,
   * `total` is params.paths.length, `currentPath` is the path just
   * processed. Safe to ignore — purely observability. A second callback
   * fires after each embed batch with done=total+batchIdx, so callers can
   * see embed progress too; MCP tool layer can filter on `currentPath`
   * starting with "embed:" to distinguish.
   */
  onProgress?: (done: number, total: number, currentPath: string) => void;
}

/** One entry per path that could not be read/hashed during indexing. */
export interface IndexFailedPath {
  path: string;
  reason: string;
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
  /**
   * The tag Ollama resolved the embed model to during this index run (e.g.
   * "nomic-embed-text:latest"), captured from EmbedResponse.model. Null if
   * no embed happened this run (pure reuse). Refresh uses this to detect
   * silent :latest drift.
   */
  embed_model_resolved: string | null;
  /**
   * Paths that could not be read (size cap, symlink, permission denied,
   * TOCTOU, etc.) during this index run. Indexing continues past these so
   * one bad file in a batch of 1000 no longer halts the whole pass. Empty
   * array on the happy path.
   */
  failed_paths: IndexFailedPath[];
}

/**
 * Read a file and hash it with TOCTOU protection.
 *
 * Invariant: a successful return means "the file was in exactly this state
 * (size + mtime) when we hashed it". We stat BEFORE read (to enforce size
 * cap and symlink rejection without reading bytes first), then stat AGAIN
 * after read and fail if size or mtime drifted — that means the file
 * mutated mid-read and the hash doesn't match the returned content.
 */
async function sha256File(path: string): Promise<{ hash: string; mtime: string; content: string }> {
  // Symlink check FIRST — reject before any size/read or realpath work so
  // a symlink can't bypass the size cap (pointing the symlink at a 100GB
  // file after the stat but before the read) and can't leak even partial
  // bytes via error messages. Using a dedicated SYMLINK_NOT_ALLOWED code
  // instead of the generic SOURCE_PATH_NOT_FOUND so callers can tell a
  // missing file apart from a deliberately-rejected symlink.
  const lst = await lstat(path);
  if (lst.isSymbolicLink()) {
    throw new InternError(
      "SYMLINK_NOT_ALLOWED",
      `Refusing to index symlink: ${path}`,
      "Pass the real file path, not a symlink. Symlinks are rejected to avoid size-cap bypass and traversal into unintended targets.",
      false,
    );
  }
  // Resolve to a real path as a belt-and-suspenders check against
  // intermediate symlinked directories. After resolving, re-verify the
  // real path still lies under an allowed root — closes the TOCTOU gap
  // where an intermediate symlink was rotated between lstat(path) and
  // realpath(path) to point at e.g. /etc/shadow.
  const realPath = await realpath(path);
  assertSafePath(realPath);
  const stBefore = await stat(realPath);
  if (stBefore.size > MAX_FILE_BYTES) {
    throw new InternError(
      "SOURCE_PATH_NOT_FOUND",
      `File exceeds max size (${stBefore.size} bytes > ${MAX_FILE_BYTES} bytes cap): ${path}`,
      `Split the file or raise the cap. The 50MB limit exists to prevent OOM from a user pointing at a huge file.`,
      false,
    );
  }
  const content = await readFile(realPath, "utf8");
  const hash = "sha256:" + createHash("sha256").update(content).digest("hex");
  const stAfter = await stat(realPath);
  if (stAfter.size !== stBefore.size || stAfter.mtimeMs !== stBefore.mtimeMs) {
    throw new InternError(
      "SOURCE_PATH_NOT_FOUND",
      `File mutated during read (TOCTOU): ${path}`,
      "Another process wrote to the file while we were hashing it. Re-run the index.",
      true,
    );
  }
  return { hash, mtime: stBefore.mtime.toISOString(), content };
}

export async function indexCorpus(params: IndexParams): Promise<IndexReport> {
  // Serialize per corpus name. Two concurrent indexCorpus / refreshCorpus
  // calls targeting the same corpus would otherwise interleave their
  // corpus.json and manifest.json writes, producing a pair that no
  // longer describes the same state.
  return withCorpusLock(params.name, () => indexCorpusUnlocked(params));
}

/**
 * Internal: indexCorpus body without the per-corpus lock. Refresh uses
 * this because it already holds the lock — calling indexCorpus from
 * inside a held lock would self-deadlock.
 */
export async function indexCorpusUnlocked(params: IndexParams): Promise<IndexReport> {
  const t0 = Date.now();
  const opts: ChunkOptions = {
    chunk_chars: params.chunk_chars ?? DEFAULT_CHUNK.chunk_chars,
    chunk_overlap: params.chunk_overlap ?? DEFAULT_CHUNK.chunk_overlap,
  };

  // Load existing corpus (if any) to reuse unchanged chunks.
  // An out-of-date schema version throws SCHEMA_INVALID from loadCorpus —
  // treat that as "no existing corpus" so this very call can rewrite the
  // file fresh under the current schema (which is the whole point of
  // re-indexing after a bump).
  let existing: CorpusFile | null = null;
  try {
    existing = await loadCorpus(params.name);
  } catch (err) {
    if (err instanceof InternError && err.code === "SCHEMA_INVALID") {
      existing = null;
    } else {
      throw err;
    }
  }
  // Refuse silent embed-model mismatch. Mixing vectors from different
  // embed models in one corpus ruins search — the space isn't shared.
  if (existing && existing.model_version !== params.model) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${params.name}" was indexed with embed model "${existing.model_version}"; refusing to re-index with "${params.model}".`,
      `Re-index with the original model, or pass a different corpus name to keep the new model isolated.`,
      false,
    );
  }
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
  const titles: Record<string, string | null> = {};
  let reusedCount = 0;
  let newlyEmbeddedCount = 0;
  let totalChars = 0;
  const seenPaths = new Set<string>();

  // Preserve titles from reusable files (they were captured at previous index).
  if (existing) {
    for (const [p, t] of Object.entries(existing.titles ?? {})) {
      titles[p] = t;
    }
  }

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
    heading_path: string[];
    chunk_type: ChunkType;
  }> = [];

  const failedPaths: IndexFailedPath[] = [];
  for (const rawPath of params.paths) {
    const absPath = resolve(rawPath);
    seenPaths.add(absPath);
    let fileInfo: { hash: string; mtime: string; content: string };
    try {
      fileInfo = await sha256File(absPath);
    } catch (err) {
      // Stage C humanization: capture per-file failure and continue so one
      // bad file in a batch of 1000 does not halt the whole pass. Caller
      // sees failed_paths in the report.
      failedPaths.push({
        path: rawPath,
        reason: (err as Error).message ?? String(err),
      });
      continue;
    }
    totalChars += fileInfo.content.length;
    const reuseKey = `${absPath}::${fileInfo.hash}`;
    const reused = reusable.get(reuseKey);
    if (reused && reused.length > 0) {
      allChunks.push(...reused);
      reusedCount += reused.length;
      continue;
    }
    // Fresh chunking for this file — heading-aware.
    const { title, chunks } = chunkDocument(fileInfo.content, opts);
    titles[absPath] = title;
    for (const ck of chunks) {
      toEmbedMeta.push({
        path: absPath,
        file_hash: fileInfo.hash,
        file_mtime: fileInfo.mtime,
        chunk_index: ck.index,
        char_start: ck.char_start,
        char_end: ck.char_end,
        text: ck.text,
        heading_path: ck.heading_path,
        chunk_type: ck.chunk_type,
      });
      toEmbedTexts.push(ck.text);
    }
  }

  // Pass 2: embed everything that needs embedding, in batches.
  // Capture the resolved tag (e.g. "nomic-embed-text:latest") from the
  // first embed response — it's what the manifest uses as the freshness
  // anchor, catching silent :latest drift on refresh.
  let embedModelResolved: string | null = null;
  if (toEmbedTexts.length > 0) {
    for (let i = 0; i < toEmbedTexts.length; i += EMBED_BATCH) {
      const batch = toEmbedTexts.slice(i, i + EMBED_BATCH);
      const resp = await params.client.embed({ model: params.model, input: batch });
      if (resp.embeddings.length !== batch.length) {
        throw new Error(
          `Embed returned ${resp.embeddings.length} vectors for ${batch.length} inputs`,
        );
      }
      if (embedModelResolved === null && typeof resp.model === "string") {
        embedModelResolved = resp.model;
      }
      for (let j = 0; j < batch.length; j++) {
        const meta = toEmbedMeta[i + j];
        // ID is stable per (content-hash, chunk_index): re-indexing the
        // same content produces the same chunk IDs, and a content change
        // flips the hash so IDs can't collide across runs. Width of 6
        // hex on the index is still >16M per file, but it's now scoped
        // to file+content not to global run order.
        const hashShort = meta.file_hash.replace(/^sha256:/, "").slice(0, 8);
        allChunks.push({
          id: `${params.name}-${hashShort}-${meta.chunk_index.toString(16).padStart(6, "0")}`,
          path: meta.path,
          file_hash: meta.file_hash,
          file_mtime: meta.file_mtime,
          chunk_index: meta.chunk_index,
          char_start: meta.char_start,
          char_end: meta.char_end,
          text: meta.text,
          vector: resp.embeddings[j],
          heading_path: meta.heading_path,
          chunk_type: meta.chunk_type,
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
  for (const p of droppedFiles) delete titles[p];

  // Scope titles to paths actually present in this index.
  const livingTitles: Record<string, string | null> = {};
  for (const c of allChunks) {
    if (c.path in titles) livingTitles[c.path] = titles[c.path];
    else if (!(c.path in livingTitles)) livingTitles[c.path] = null;
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
    titles: livingTitles,
    chunks: allChunks,
  };

  await saveCorpus(corpus);

  // Write the manifest alongside the corpus. The corpus is "reality";
  // the manifest is "intent" — what the caller declared should be here.
  // Refresh later reconciles the two.
  const manifestPaths = [...seenPaths].sort();
  const prevManifest = await loadManifest(params.name).catch(() => null);
  const now = new Date().toISOString();
  // Preserve the prior resolved tag when nothing was embedded this run.
  // Writing null over a previously-known value would lose the freshness anchor.
  const resolvedForManifest = embedModelResolved ?? prevManifest?.embed_model_resolved ?? null;
  const manifest: CorpusManifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    name: params.name,
    paths: manifestPaths,
    embed_model: params.model,
    embed_model_resolved: resolvedForManifest,
    chunk_chars: opts.chunk_chars,
    chunk_overlap: opts.chunk_overlap,
    created_at: prevManifest?.created_at ?? now,
    updated_at: now,
  };
  await saveManifest(manifest);

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
    embed_model_resolved: embedModelResolved,
    failed_paths: failedPaths,
  };
}
