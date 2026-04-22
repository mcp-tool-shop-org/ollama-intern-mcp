import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexCorpus } from "../../src/corpus/indexer.js";
import { searchCorpus } from "../../src/corpus/searcher.js";
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
    const r1 = await indexCorpus({ name: "ch", paths: [p1], model: "nomic-embed-text", client });
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
    // allowedRoots() always implicitly includes homedir(). On Windows,
    // tmpdir() is under homedir(), so we can't use a tmpdir-based fixture
    // to exercise "outside". Skip on that platform.
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
