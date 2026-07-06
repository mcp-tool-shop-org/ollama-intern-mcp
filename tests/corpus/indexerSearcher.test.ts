import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexCorpus } from "../../src/corpus/indexer.js";
import { searchCorpus } from "../../src/corpus/searcher.js";
import { clearCompletedMarker, manifestPath } from "../../src/corpus/manifest.js";
import { loadCorpus, listCorpora, assertValidCorpusName, CORPUS_SCHEMA_VERSION, corpusPath } from "../../src/corpus/storage.js";
import { corpusIndexSchema } from "../../src/tools/corpusIndex.js";
import { InternError } from "../../src/errors.js";
import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "../../src/ollama.js";
import type { Residency } from "../../src/envelope.js";

/**
 * Mock that returns a deterministic vector per input text via stable
 * hash-to-float math. Enough to make cosine ranking meaningful.
 */
class HashEmbedMock implements OllamaClient {
  public embedCalls = 0;
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      embeddings: inputs.map((t) => toVec(t)),
    };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

/** Cheap deterministic text→vector: 8-dim, lowercase letter buckets. */
function toVec(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const ch of text.toLowerCase()) {
    const code = ch.charCodeAt(0);
    if (code >= 97 && code <= 122) v[(code - 97) % 8] += 1;
  }
  // normalize softly to keep magnitudes reasonable
  const sum = v.reduce((s, x) => s + x, 0) || 1;
  return v.map((x) => x / sum);
}

let tempDir: string;
let origCorpusDir: string | undefined;
let origAllowedRoots: string | undefined;

// Module-load snapshot — if a beforeEach throws before its own snapshot
// line runs, afterEach still has a correct pre-test value to restore. (T001)
const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;
const MODULE_ORIG_ALLOWED_ROOTS = process.env.INTERN_CORPUS_ALLOWED_ROOTS;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-corpus-"));
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  origAllowedRoots = process.env.INTERN_CORPUS_ALLOWED_ROOTS;
  process.env.INTERN_CORPUS_DIR = tempDir;
  // tmpdir() is outside homedir on Linux/CI — whitelist it so the
  // realpath safety check in sha256File accepts test fixtures.
  process.env.INTERN_CORPUS_ALLOWED_ROOTS = tmpdir();
});

afterEach(async () => {
  const toRestore = origCorpusDir ?? MODULE_ORIG_CORPUS_DIR;
  const toRestoreRoots = origAllowedRoots ?? MODULE_ORIG_ALLOWED_ROOTS;
  try {
    if (toRestore === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = toRestore;
    if (toRestoreRoots === undefined) delete process.env.INTERN_CORPUS_ALLOWED_ROOTS;
    else process.env.INTERN_CORPUS_ALLOWED_ROOTS = toRestoreRoots;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("indexCorpus + searchCorpus", () => {
  it("indexes files, persists corpus, searches by query", async () => {
    const p1 = join(tempDir, "alpha.md");
    const p2 = join(tempDir, "bravo.md");
    await writeFile(p1, "alpha content talks about cats and felines purring", "utf8");
    await writeFile(p2, "bravo content talks about dogs and canines barking", "utf8");

    const client = new HashEmbedMock();
    const report = await indexCorpus({
      name: "t1",
      paths: [p1, p2],
      model: "nomic-embed-text",
      chunk_chars: 200,
      chunk_overlap: 20,
      client,
    });
    expect(report.documents).toBe(2);
    expect(report.newly_embedded_chunks).toBeGreaterThan(0);
    expect(report.reused_chunks).toBe(0);

    const corpus = await loadCorpus("t1");
    expect(corpus).not.toBeNull();
    expect(corpus!.chunks.length).toBe(report.chunks);
    expect(corpus!.name).toBe("t1");

    // Search for "felines" → alpha.md should rank first.
    const hits = await searchCorpus({
      corpus: corpus!,
      query: "felines",
      model: "nomic-embed-text",
      top_k: 2,
      preview_chars: 40,
      client,
    });
    expect(hits).toHaveLength(2);
    expect(hits[0].path).toBe(p1);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits[0].preview).toBeDefined();
  });

  it("idempotent: re-indexing unchanged files reuses vectors (no new embeds)", async () => {
    const p1 = join(tempDir, "a.md");
    await writeFile(p1, "stable content about frogs".repeat(40), "utf8");

    const client = new HashEmbedMock();
    const r1 = await indexCorpus({
      name: "idempo", paths: [p1], model: "nomic-embed-text",
      chunk_chars: 200, chunk_overlap: 20, client,
    });
    const callsAfterFirst = client.embedCalls;

    const r2 = await indexCorpus({
      name: "idempo", paths: [p1], model: "nomic-embed-text",
      chunk_chars: 200, chunk_overlap: 20, client,
    });
    // Second run should have reused all chunks from the first.
    expect(r2.newly_embedded_chunks).toBe(0);
    expect(r2.reused_chunks).toBe(r1.chunks);
    // And NO new embed calls should have fired.
    expect(client.embedCalls).toBe(callsAfterFirst);
  });

  it("drops files that are no longer in the input set", async () => {
    const p1 = join(tempDir, "keep.md");
    const p2 = join(tempDir, "drop.md");
    await writeFile(p1, "keep keep keep", "utf8");
    await writeFile(p2, "drop drop drop", "utf8");

    const client = new HashEmbedMock();
    await indexCorpus({ name: "d", paths: [p1, p2], model: "nomic-embed-text", client });
    const r2 = await indexCorpus({ name: "d", paths: [p1], model: "nomic-embed-text", client });

    expect(r2.documents).toBe(1);
    expect(r2.dropped_files).toContain(p2);
  });

  it("re-embeds changed files (detected by sha256)", async () => {
    const p1 = join(tempDir, "changes.md");
    await writeFile(p1, "original content", "utf8");

    const client = new HashEmbedMock();
    await indexCorpus({ name: "ch", paths: [p1], model: "nomic-embed-text", client });
    const embedsAfterFirst = client.embedCalls;

    await writeFile(p1, "completely different content now, longer too", "utf8");
    const r2 = await indexCorpus({ name: "ch", paths: [p1], model: "nomic-embed-text", client });

    expect(r2.newly_embedded_chunks).toBeGreaterThan(0);
    expect(r2.reused_chunks).toBe(0);
    expect(client.embedCalls).toBeGreaterThan(embedsAfterFirst);
  });

  it("listCorpora returns summaries sorted by name", async () => {
    const p = join(tempDir, "x.md");
    await writeFile(p, "hello", "utf8");
    const client = new HashEmbedMock();
    await indexCorpus({ name: "zebra", paths: [p], model: "nomic-embed-text", client });
    await indexCorpus({ name: "apple", paths: [p], model: "nomic-embed-text", client });
    const summaries = await listCorpora();
    expect(summaries.map((s) => s.name)).toEqual(["apple", "zebra"]);
    for (const s of summaries) {
      expect(s.chunks).toBeGreaterThan(0);
      expect(s.bytes_on_disk).toBeGreaterThan(0);
    }
  });

  it("search refuses when corpus model doesn't match active embed model", async () => {
    const p = join(tempDir, "a.md");
    await writeFile(p, "hello world", "utf8");
    const client = new HashEmbedMock();
    await indexCorpus({ name: "m", paths: [p], model: "nomic-embed-text", client });
    const corpus = (await loadCorpus("m"))!;
    await expect(
      searchCorpus({ corpus, query: "q", model: "some-other-embed-model", client }),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects invalid corpus names", () => {
    expect(() => assertValidCorpusName("has space")).toThrow(InternError);
    expect(() => assertValidCorpusName("has/slash")).toThrow(InternError);
    expect(() => assertValidCorpusName("OK_name-123")).not.toThrow();
  });

  it("persists heading_path + chunk_type + titles on indexed chunks (schema v2)", async () => {
    const p = join(tempDir, "doc.md");
    await writeFile(
      p,
      [
        "# The Title",
        "intro line",
        "",
        "## Section Alpha",
        "alpha body content",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
      "utf8",
    );
    const client = new HashEmbedMock();
    await indexCorpus({ name: "v2", paths: [p], model: "nomic-embed-text", client });
    const corpus = (await loadCorpus("v2"))!;
    expect(corpus.schema_version).toBe(CORPUS_SCHEMA_VERSION);
    expect(corpus.titles[p]).toBe("The Title");
    const alpha = corpus.chunks.find((c) => c.text.includes("alpha body"))!;
    expect(alpha.heading_path).toEqual(["The Title", "Section Alpha"]);
    expect(alpha.chunk_type).toBe("paragraph");
    const code = corpus.chunks.find((c) => c.chunk_type === "code")!;
    expect(code.text).toContain("const x = 1;");
    expect(code.heading_path).toEqual(["The Title", "Section Alpha"]);
  });

  it("loading a v1 corpus throws SCHEMA_INVALID with corpus name, path, versions, and re-index command", async () => {
    // Hand-craft a v1-shaped file at the corpus path and try to load it.
    const p = join(tempDir, "old.md");
    await writeFile(p, "anything", "utf8");
    const v1Corpus = {
      schema_version: 1,
      name: "legacy",
      model_version: "nomic-embed-text",
      model_digest: null,
      indexed_at: new Date().toISOString(),
      chunk_chars: 800,
      chunk_overlap: 100,
      stats: { documents: 0, chunks: 0, total_chars: 0 },
      chunks: [],
    };
    await writeFile(corpusPath("legacy"), JSON.stringify(v1Corpus), "utf8");
    let caught: InternError | undefined;
    try {
      await loadCorpus("legacy");
    } catch (err) {
      caught = err as InternError;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect(caught!.code).toBe("SCHEMA_INVALID");
    // Message carries the corpus name, both schema versions, and the file path.
    expect(caught!.message).toContain("legacy");
    expect(caught!.message).toContain("v1");
    expect(caught!.message).toContain(`v${CORPUS_SCHEMA_VERSION}`);
    expect(caught!.message).toContain(corpusPath("legacy"));
    // Hint carries the exact re-index command.
    expect(caught!.hint).toContain("ollama_corpus_index");
    expect(caught!.hint).toContain(`"legacy"`);
  });

  it("indexing over a v1 corpus rebuilds it fresh instead of crashing", async () => {
    const p = join(tempDir, "a.md");
    await writeFile(p, "# Hello\ncontent", "utf8");
    // Plant a v1 file at the target path.
    const v1Corpus = {
      schema_version: 1,
      name: "upgrade",
      model_version: "nomic-embed-text",
      model_digest: null,
      indexed_at: new Date().toISOString(),
      chunk_chars: 800,
      chunk_overlap: 100,
      stats: { documents: 0, chunks: 0, total_chars: 0 },
      chunks: [],
    };
    await writeFile(corpusPath("upgrade"), JSON.stringify(v1Corpus), "utf8");
    const client = new HashEmbedMock();
    // Re-index should not throw — it should overwrite with v2.
    const report = await indexCorpus({
      name: "upgrade",
      paths: [p],
      model: "nomic-embed-text",
      client,
    });
    expect(report.newly_embedded_chunks).toBeGreaterThan(0);
    const corpus = (await loadCorpus("upgrade"))!;
    expect(corpus.schema_version).toBe(CORPUS_SCHEMA_VERSION);
    expect(corpus.titles[p]).toBe("Hello");
  });

  it("rejects symlinks with SYMLINK_NOT_ALLOWED before any size or read work", async () => {
    // A symlink must be rejected BEFORE the size check — otherwise a user
    // could swap the target between stat and read (size-cap bypass).
    const real = join(tempDir, "real.md");
    const link = join(tempDir, "link.md");
    await writeFile(real, "real content", "utf8");
    try {
      await symlink(real, link);
    } catch {
      // Some test environments (e.g. Windows without dev mode) disallow
      // symlink creation — skip silently rather than fail the suite.
      return;
    }
    const client = new HashEmbedMock();
    const report = await indexCorpus({
      name: "symlink",
      paths: [link],
      model: "nomic-embed-text",
      client,
    });
    expect(report.failed_paths).toHaveLength(1);
    expect(report.failed_paths[0].path).toBe(link);
    expect(report.failed_paths[0].reason).toContain("symlink");
  });

  it("torn write on the Nth mutation reports write_complete:false, and a clean re-index heals it (M5)", async () => {
    const p = join(tempDir, "torn.md");
    await writeFile(p, "content that has been indexed once already", "utf8");
    const client = new HashEmbedMock();

    // 1st mutation completes cleanly → manifest carries completed_at.
    await indexCorpus({ name: "torn", paths: [p], model: "nomic-embed-text", client });
    expect((await listCorpora()).find((s) => s.name === "torn")!.write_complete).toBe(true);

    // The two-phase marker (phase 1) clears completed_at BEFORE the corpus
    // write. Simulate a crash right after that clear + saveCorpus but before
    // the final manifest write: the on-disk manifest has no completed_at, so
    // the torn state is DETECTED. Before the fix, the prior run's completed_at
    // stayed on disk and falsely reported the torn state as complete.
    await clearCompletedMarker("torn");
    expect((await listCorpora()).find((s) => s.name === "torn")!.write_complete).toBe(false);

    // A clean re-index runs the full two-phase (clear → saveCorpus → final
    // saveManifest with completed_at) and ends complete again.
    await indexCorpus({ name: "torn", paths: [p], model: "nomic-embed-text", client });
    expect((await listCorpora()).find((s) => s.name === "torn")!.write_complete).toBe(true);
  });

  it("a v1-migrated manifest does NOT trip the interrupted-write warning (M5)", async () => {
    const p = join(tempDir, "leg.md");
    await writeFile(p, "legacy corpus content", "utf8");
    const client = new HashEmbedMock();
    await indexCorpus({ name: "legacy", paths: [p], model: "nomic-embed-text", client });

    // Rewrite the manifest as a legacy v1 (schema_version 1, no completed_at) —
    // a manifest from before the torn-write marker existed.
    const mPath = manifestPath("legacy");
    const current = JSON.parse(await readFile(mPath, "utf8")) as Record<string, unknown>;
    delete current.completed_at;
    delete current.schema_version_written_by;
    current.schema_version = 1;
    await writeFile(mPath, JSON.stringify(current), "utf8");

    // Loading migrates v1→v2 and stamps completed_at (from updated_at), so it
    // reads as legacy-assumed-complete — NOT a false-positive torn write.
    expect((await listCorpora()).find((s) => s.name === "legacy")!.write_complete).toBe(true);
  });

  it("re-index with changed chunk params re-chunks unchanged files, no stale geometry (L2)", async () => {
    const p = join(tempDir, "geo.md");
    await writeFile(p, "sentence one here. ".repeat(80), "utf8"); // ~1520 chars

    const client = new HashEmbedMock();
    const r1 = await indexCorpus({
      name: "geo",
      paths: [p],
      model: "nomic-embed-text",
      chunk_chars: 500,
      chunk_overlap: 50,
      client,
    });

    // Re-index the SAME unchanged file with DIFFERENT (smaller) chunk params.
    const r2 = await indexCorpus({
      name: "geo",
      paths: [p],
      model: "nomic-embed-text",
      chunk_chars: 150,
      chunk_overlap: 20,
      client,
    });

    // The unchanged file was RE-CHUNKED under the new params, NOT reused with
    // the old geometry (which would leave the manifest's stamped params lying
    // about the on-disk chunk sizes).
    expect(r2.reused_chunks).toBe(0);
    expect(r2.newly_embedded_chunks).toBeGreaterThan(0);

    const corpus = (await loadCorpus("geo"))!;
    expect(corpus.chunk_chars).toBe(150);
    expect(corpus.chunk_overlap).toBe(20);
    // Smaller chunk_chars → strictly more chunks than the first (500-char) index.
    expect(corpus.chunks.length).toBeGreaterThan(r1.chunks);
  });

  it("distinct paths with identical content get globally-unique chunk IDs (M8)", async () => {
    const p1 = join(tempDir, "dup-a.md");
    const p2 = join(tempDir, "dup-b.md");
    const identical = "the same content appears in two different files here";
    await writeFile(p1, identical, "utf8");
    await writeFile(p2, identical, "utf8");

    const client = new HashEmbedMock();
    await indexCorpus({
      name: "dup",
      paths: [p1, p2],
      model: "nomic-embed-text",
      chunk_chars: 200,
      chunk_overlap: 20,
      client,
    });
    const corpus = (await loadCorpus("dup"))!;

    // Two files with identical content → two chunks with DISTINCT ids (an
    // ID scheme without a path component would collide them into one).
    expect(corpus.chunks.length).toBe(2);
    const ids = corpus.chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // globally unique
    expect(new Set(corpus.chunks.map((c) => c.path))).toEqual(new Set([p1, p2]));

    // Search returns BOTH chunks, each resolving to its own correct path —
    // no shadowing in the chunkById map, no duplicate/inflated hit.
    const hits = await searchCorpus({
      corpus,
      query: "content",
      model: "nomic-embed-text",
      mode: "semantic",
      top_k: 10,
      client,
    });
    expect(hits.map((h) => h.path).sort()).toEqual([p1, p2].sort());
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length); // each chunk once
  });

  it("corpusIndexSchema rejects chunk_overlap >= chunk_chars (degenerate chunking)", () => {
    // Overlap >= chunk_chars would collapse every chunk's window to at
    // most chunk_chars of novel content — pointless, wastes embed budget.
    const bad = corpusIndexSchema.safeParse({
      name: "x",
      paths: ["/tmp/a.md"],
      chunk_chars: 500,
      chunk_overlap: 500,
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(JSON.stringify(bad.error.issues)).toContain("chunk_overlap must be less than chunk_chars");
    }
    const worse = corpusIndexSchema.safeParse({
      name: "x",
      paths: ["/tmp/a.md"],
      chunk_chars: 500,
      chunk_overlap: 900,
    });
    expect(worse.success).toBe(false);
    // Valid case still parses clean.
    const good = corpusIndexSchema.safeParse({
      name: "x",
      paths: ["/tmp/a.md"],
      chunk_chars: 500,
      chunk_overlap: 100,
    });
    expect(good.success).toBe(true);
  });

  it("rejects paths whose realpath is outside allowed roots (TOCTOU on intermediate symlinks)", async () => {
    // Simulate the outcome of an intermediate symlink being rotated
    // between lstat(path) and realpath(path): final realpath resolves to
    // a location NOT covered by INTERN_CORPUS_ALLOWED_ROOTS. We can't
    // race the rotation deterministically, but we can narrow the roots
    // and verify assertSafePath runs on the resolved real path.
    //
    // allowedRoots() always implicitly includes homedir(). Windows is
    // skipped unconditionally — the local-dev case (tmpdir under homedir)
    // and the GH Actions case (tmpdir on D:\a\_temp while homedir is on
    // C:\Users\runneradmin) both prevent a clean "outside" assertion: in
    // local-dev the file IS under an allowed root; in GH Actions the
    // narrowed sibling root + homedir leave gaps the test setup can't
    // bridge without inventing a path nobody owns. assertSafePath itself
    // has direct unit tests; this test exists to verify the indexer's
    // realpath→assertSafePath wiring on POSIX where the topology is
    // controllable.
    if (process.platform === "win32") {
      return;
    }
    const home = (await import("node:os")).homedir();
    if (tmpdir().startsWith(home)) {
      return; // tmpdir is inside homedir — can't simulate "outside" here.
    }
    const outside = join(tempDir, "outside.md");
    await writeFile(outside, "should not be indexed", "utf8");
    // Shrink allowed roots to a sibling path so the real file is outside.
    const siblingDir = await mkdtemp(join(tmpdir(), "intern-sibling-"));
    try {
      process.env.INTERN_CORPUS_ALLOWED_ROOTS = siblingDir;
      const client = new HashEmbedMock();
      const report = await indexCorpus({
        name: "toctou",
        paths: [outside],
        model: "nomic-embed-text",
        client,
      });
      expect(report.failed_paths).toHaveLength(1);
      expect(report.failed_paths[0].reason).toMatch(/outside allowed roots/);
    } finally {
      await rm(siblingDir, { recursive: true, force: true });
    }
  });
});
