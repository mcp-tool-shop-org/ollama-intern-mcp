/**
 * ollama_corpus_amend — update one file's chunks in a corpus without a
 * full refresh.
 *
 * INVARIANT CAVEAT: the corpus is normally a SNAPSHOT OF DISK. This tool
 * bypasses that — `new_content` does not have to exist on disk, and the
 * corpus is mutated in place from the caller-supplied string. Callers
 * are responsible for keeping source files in sync with what they amend
 * (or for explicitly accepting the divergence). The manifest records
 * `has_amended_content: true` so corpus_list / corpus_health surface the
 * invariant break; a subsequent clean index/refresh clears the flag and
 * re-establishes the snapshot contract.
 *
 * Tier: Embed. Takes the per-corpus lock. The new chunks are embedded
 * using the manifest's declared embed_model (refusing silently different
 * active tier) and the manifest's stored chunk params (unless the caller
 * explicitly overrides). Existing chunks for `file_path` are removed
 * first, so re-amending the same file never accumulates duplicates.
 */

import { z } from "zod";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { loadCorpus, saveCorpus, type CorpusChunk, type CorpusFile } from "../corpus/storage.js";
import { loadManifest, saveManifest, assertSafePath } from "../corpus/manifest.js";
import { withCorpusLock } from "../corpus/lock.js";
import { chunkDocument, type ChunkOptions } from "../corpus/chunker.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

// 5 MB cap matches sha256File's read ceiling in spirit — a multi-MB amend
// via MCP is already an abuse of the shape. Keeps JSON payloads bounded.
const MAX_AMEND_BYTES = 5_000_000;

export const corpusAmendSchema = z
  .object({
    corpus: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
      .describe("Corpus to mutate. Must already exist (ollama_corpus_index writes the initial manifest)."),
    file_path: z
      .string()
      .min(1)
      .describe("Absolute file path this content is associated with. Validated against the manifest's allowed-roots policy even if no file exists there."),
    new_content: z
      .string()
      .min(1)
      .max(MAX_AMEND_BYTES, `new_content must be ≤ ${MAX_AMEND_BYTES} chars`)
      .describe("The replacement text for this file's chunks. Re-chunked + re-embedded server-side. Does NOT have to match what's on disk."),
    chunk_chars: z
      .number()
      .int()
      .min(100)
      .max(8000)
      .optional()
      .describe("Override the manifest's chunk_chars for this amend only. Prefer omitting — the manifest's value keeps the corpus internally consistent."),
    chunk_overlap: z
      .number()
      .int()
      .min(0)
      .max(4000)
      .optional()
      .describe("Override the manifest's chunk_overlap for this amend only."),
  })
  .refine(
    (d) => {
      if (d.chunk_chars === undefined || d.chunk_overlap === undefined) return true;
      return d.chunk_overlap < d.chunk_chars;
    },
    { message: "chunk_overlap must be less than chunk_chars" },
  );

export type CorpusAmendInput = z.infer<typeof corpusAmendSchema>;

export interface CorpusAmendResult {
  corpus: string;
  file_path: string;
  chunks_removed: number;
  chunks_added: number;
  embed_model_resolved: string | null;
}

export async function handleCorpusAmend(
  input: CorpusAmendInput,
  ctx: RunContext,
): Promise<Envelope<CorpusAmendResult>> {
  const startedAt = Date.now();
  const activeModel = resolveTier("embed", ctx.tiers);

  // All writes happen under the per-corpus lock — corpus JSON + manifest
  // are mutated together; interleaving with index/refresh on the same
  // name would produce a corpus/manifest pair that disagree.
  const result = await withCorpusLock(input.corpus, async () => {
    // Validate file_path against the same allowed-roots policy the
    // manifest enforces. An amend that points at /etc/shadow is rejected
    // even though we never read the file — the manifest path listing
    // still has to pass the safe-path check.
    const absPath = resolve(input.file_path);
    try {
      assertSafePath(absPath);
    } catch (err) {
      // Re-wrap as CORPUS_AMEND_FAILED so callers can tell input-shape
      // rejections from generic schema failures. Preserve the original
      // hint which already names allowed roots.
      if (err instanceof InternError) {
        throw new InternError(
          "CORPUS_AMEND_FAILED",
          err.message,
          err.hint,
          false,
        );
      }
      throw err;
    }

    const manifest = await loadManifest(input.corpus);
    if (!manifest) {
      throw new InternError(
        "CORPUS_AMEND_FAILED",
        `No manifest found for corpus "${input.corpus}".`,
        `Run ollama_corpus_index({ name: "${input.corpus}", paths: [...] }) first — amend requires an existing corpus to mutate.`,
        false,
      );
    }
    const corpus = await loadCorpus(input.corpus);
    if (!corpus) {
      throw new InternError(
        "CORPUS_AMEND_FAILED",
        `Corpus "${input.corpus}" is missing its JSON payload (manifest exists but corpus does not).`,
        `Re-run ollama_corpus_index to rebuild, or ollama_corpus_refresh to reconcile.`,
        false,
      );
    }

    // Embed model must match the manifest — amending with a different
    // model would splice foreign vectors into the same corpus. This is
    // the same rule the indexer enforces; enforcing it here stops a
    // silent tier change from corrupting search.
    if (manifest.embed_model !== activeModel) {
      throw new InternError(
        "CORPUS_AMEND_FAILED",
        `Corpus "${input.corpus}" uses embed model "${manifest.embed_model}"; active tier is "${activeModel}".`,
        `Switch the embed tier back to "${manifest.embed_model}" (or re-index the whole corpus) before amending. Mixing vectors across models ruins search.`,
        false,
      );
    }

    // Remove any existing chunks for this file_path. Re-amending the same
    // file should replace, not accumulate.
    const keptChunks: CorpusChunk[] = [];
    let removed = 0;
    for (const c of corpus.chunks) {
      if (c.path === absPath) {
        removed += 1;
      } else {
        keptChunks.push(c);
      }
    }

    const chunkOpts: ChunkOptions = {
      chunk_chars: input.chunk_chars ?? manifest.chunk_chars,
      chunk_overlap: input.chunk_overlap ?? manifest.chunk_overlap,
    };
    const { title, chunks: fresh } = chunkDocument(input.new_content, chunkOpts);

    // Synthetic file stats — we never read disk. file_hash is the sha256
    // of the amended content so the ID-generation scheme (hash-prefix +
    // chunk_index) keeps its uniqueness properties. file_mtime is "now"
    // — callers who want mtime-accuracy should do a proper index pass.
    const fileHash = "sha256:" + createHash("sha256").update(input.new_content).digest("hex");
    const fileMtime = new Date().toISOString();

    // Embed new chunks if any. Zero-chunk amend (empty doc after chunking)
    // is allowed — it's effectively "delete this file from the corpus".
    let embedModelResolved: string | null = null;
    const newChunks: CorpusChunk[] = [];
    if (fresh.length > 0) {
      const texts = fresh.map((c) => c.text);
      const resp = await ctx.client.embed({ model: activeModel, input: texts });
      if (resp.embeddings.length !== texts.length) {
        throw new InternError(
          "CORPUS_AMEND_FAILED",
          `Embed returned ${resp.embeddings.length} vectors for ${texts.length} inputs.`,
          `Transient Ollama error — retry the amend. Persistent mismatches indicate the model returned an unexpected shape.`,
          true,
        );
      }
      if (typeof resp.model === "string" && resp.model.length > 0) {
        embedModelResolved = resp.model;
      }
      const hashShort = fileHash.replace(/^sha256:/, "").slice(0, 8);
      for (let i = 0; i < fresh.length; i++) {
        const ck = fresh[i];
        newChunks.push({
          id: `${corpus.name}-${hashShort}-${ck.index.toString(16).padStart(6, "0")}`,
          path: absPath,
          file_hash: fileHash,
          file_mtime: fileMtime,
          chunk_index: ck.index,
          char_start: ck.char_start,
          char_end: ck.char_end,
          text: ck.text,
          vector: resp.embeddings[i],
          heading_path: ck.heading_path,
          chunk_type: ck.chunk_type,
        });
      }
    }

    const mergedChunks = [...keptChunks, ...newChunks];
    // Recompute stats + titles to reflect the amended set.
    const livingTitles: Record<string, string | null> = { ...corpus.titles };
    if (newChunks.length > 0) livingTitles[absPath] = title;
    else delete livingTitles[absPath];
    // Drop titles for paths that vanished entirely.
    const remainingPaths = new Set(mergedChunks.map((c) => c.path));
    for (const p of Object.keys(livingTitles)) {
      if (!remainingPaths.has(p)) delete livingTitles[p];
    }
    const totalChars = mergedChunks.reduce((n, c) => n + c.text.length, 0);
    const updatedCorpus: CorpusFile = {
      ...corpus,
      chunks: mergedChunks,
      titles: livingTitles,
      stats: {
        documents: remainingPaths.size,
        chunks: mergedChunks.length,
        total_chars: totalChars,
      },
      indexed_at: new Date().toISOString(),
    };
    await saveCorpus(updatedCorpus);

    // Manifest bookkeeping:
    //   - paths list gains `absPath` if this amend introduced a previously
    //     unknown file (callers should re-index afterward, but the list
    //     stays honest in the meantime).
    //   - has_amended_content set true — the invariant is broken until a
    //     clean index/refresh rebuilds the corpus from disk.
    //   - embed_model_resolved updated to whatever Ollama just reported
    //     (if anything embedded); otherwise preserved.
    const pathSet = new Set(manifest.paths);
    pathSet.add(absPath);
    // If the file was fully deleted from the corpus (zero chunks added,
    // and it existed before), don't remove it from manifest.paths — the
    // manifest tracks DECLARED intent; the empty amend is effectively
    // "clear this file's chunks", not "forget the file". A future refresh
    // will re-scan it from disk.
    const updatedManifest = {
      ...manifest,
      paths: [...pathSet].sort(),
      has_amended_content: true,
      embed_model_resolved: embedModelResolved ?? manifest.embed_model_resolved ?? null,
      updated_at: new Date().toISOString(),
    };
    await saveManifest(updatedManifest);

    return {
      corpus: corpus.name,
      file_path: absPath,
      chunks_removed: removed,
      chunks_added: newChunks.length,
      embed_model_resolved: embedModelResolved,
    } satisfies CorpusAmendResult;
  });

  const residency = await ctx.client.residency(activeModel);
  // Approximate token count for observability — chars / 4 of the embedded payload.
  const approxTokensIn = Math.ceil(input.new_content.length / 4);

  const envelope = buildEnvelope<CorpusAmendResult>({
    result,
    tier: "embed",
    model: activeModel,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: approxTokensIn,
    tokensOut: 0,
    startedAt,
    residency,
    warnings: [
      "corpus_amend mutated a corpus in place — it no longer mirrors disk. Re-run ollama_corpus_index when you want to restore the snapshot invariant.",
    ],
  });

  await ctx.logger.log(callEvent("ollama_corpus_amend", envelope));
  return envelope;
}
