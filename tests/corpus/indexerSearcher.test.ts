import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexCorpus } from "../../src/corpus/indexer.js";
import { searchCorpus } from "../../src/corpus/searcher.js";
import { loadCorpus, listCorpora, assertValidCorpusName } from "../../src/corpus/storage.js";
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-corpus-"));
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  process.env.INTERN_CORPUS_DIR = tempDir;
});

afterEach(async () => {
  if (origCorpusDir === undefined) delete process.env.INTERN_CORPUS_DIR;
  else process.env.INTERN_CORPUS_DIR = origCorpusDir;
  await rm(tempDir, { recursive: true, force: true });
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
});
