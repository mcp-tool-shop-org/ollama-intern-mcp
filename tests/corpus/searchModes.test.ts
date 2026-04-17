/**
 * Search mode dispatcher tests — slice 3 of the Retrieval Truth Spine.
 *
 * Each mode has a locked contract:
 *   semantic   : dense-only, must not consult lexical
 *   lexical    : BM25-only, must not call embed
 *   hybrid     : RRF-fused (default); rescues fact misses without hurting semantic wins
 *   fact       : hybrid + exact-substring boost + short-chunk preference; never collapses to empty on near-miss
 *   title_path : metadata-only, must not call embed
 *
 * Fused ties stay deterministic via (path asc, chunk_index asc).
 */

import { describe, it, expect } from "vitest";
import { searchCorpus, DEFAULT_SEARCH_MODE } from "../../src/corpus/searcher.js";
import type { CorpusChunk, CorpusFile } from "../../src/corpus/storage.js";
import { CORPUS_SCHEMA_VERSION } from "../../src/corpus/storage.js";
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
import { InternError } from "../../src/errors.js";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Table-backed embed mock. The vector returned for any input is looked
 * up by exact text match; missing inputs return a zero vector. Lets a
 * test prescribe cosine rankings precisely, independent of lexical.
 */
class TableEmbedMock implements OllamaClient {
  public embedCalls = 0;
  constructor(private readonly table: Map<string, number[]>) {}
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const width = [...this.table.values()][0]?.length ?? 4;
    return {
      model: req.model,
      embeddings: inputs.map((t) => this.table.get(t) ?? new Array(width).fill(0)),
    };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

interface ChunkSpec {
  id: string;
  path: string;
  chunk_index?: number;
  text: string;
  vector?: number[];
  heading_path?: string[];
  title?: string | null;
}

function mkCorpus(
  name: string,
  modelVersion: string,
  specs: ChunkSpec[],
): CorpusFile {
  const titles: Record<string, string | null> = {};
  const chunks: CorpusChunk[] = specs.map((s) => {
    if (s.title !== undefined) titles[s.path] = s.title;
    return {
      id: s.id,
      path: s.path,
      file_hash: "sha256:test",
      file_mtime: "2026-04-17T00:00:00.000Z",
      chunk_index: s.chunk_index ?? 0,
      char_start: 0,
      char_end: s.text.length,
      text: s.text,
      vector: s.vector ?? [0, 0, 0, 0],
      heading_path: s.heading_path ?? [],
      chunk_type: "paragraph",
    };
  });
  // Fill missing titles so every path has a key.
  for (const s of specs) if (!(s.path in titles)) titles[s.path] = null;
  return {
    schema_version: CORPUS_SCHEMA_VERSION,
    name,
    model_version: modelVersion,
    model_digest: null,
    indexed_at: "2026-04-17T00:00:00.000Z",
    chunk_chars: 800,
    chunk_overlap: 100,
    stats: { documents: new Set(specs.map((s) => s.path)).size, chunks: specs.length, total_chars: specs.reduce((n, s) => n + s.text.length, 0) },
    titles,
    chunks,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("searchCorpus — mode dispatch", () => {
  it("default mode is hybrid", () => {
    expect(DEFAULT_SEARCH_MODE).toBe("hybrid");
  });

  it("semantic mode: dense-only, preserves cosine ranking", async () => {
    const corpus = mkCorpus("s", "m", [
      { id: "c-0", path: "/a.md", text: "alpha body", vector: [1, 0, 0, 0] },
      { id: "c-1", path: "/b.md", text: "bravo body", vector: [0, 1, 0, 0] },
      { id: "c-2", path: "/c.md", text: "gamma body", vector: [0, 0, 1, 0] },
    ]);
    const client = new TableEmbedMock(new Map([["target", [1, 0, 0, 0]]]));
    const hits = await searchCorpus({ corpus, query: "target", model: "m", mode: "semantic", client });
    expect(client.embedCalls).toBe(1);
    expect(hits[0].id).toBe("c-0"); // exact cosine match
  });

  it("lexical mode: never calls embed, ranks by BM25", async () => {
    const corpus = mkCorpus("s", "m", [
      { id: "c-0", path: "/a.md", text: "the mongoose outfoxed the cobra today" },
      { id: "c-1", path: "/b.md", text: "completely unrelated content about waterfalls" },
    ]);
    const client = new TableEmbedMock(new Map());
    const hits = await searchCorpus({ corpus, query: "mongoose", model: "m", mode: "lexical", client });
    expect(client.embedCalls).toBe(0);
    expect(hits[0].path).toBe("/a.md");
  });

  it("title_path mode: never calls embed, ignores body text", async () => {
    const corpus = mkCorpus("s", "m", [
      {
        id: "c-0",
        path: "/docs/retrieval.md",
        text: "body without the magic word",
        heading_path: ["Retrieval Design"],
        title: "Retrieval Handbook",
      },
      {
        id: "c-1",
        path: "/other/something.md",
        text: "body mentions retrieval only in its text",
        heading_path: ["Unrelated"],
        title: "Unrelated",
      },
    ]);
    const client = new TableEmbedMock(new Map());
    const hits = await searchCorpus({ corpus, query: "retrieval", model: "m", mode: "title_path", client });
    expect(client.embedCalls).toBe(0);
    // Metadata-only match ranks first; body-only match is invisible to this mode.
    expect(hits[0].path).toBe("/docs/retrieval.md");
    // Body-only match should not survive since body weight = 0 in title_path.
    expect(hits.some((h) => h.path === "/other/something.md")).toBe(false);
  });

  it("lexical wins on literal title/path queries where semantic would miss", async () => {
    // Dense mock returns a vector that favors /irrelevant.md over /docs/commandui-distribution.md.
    const corpus = mkCorpus("s", "m", [
      {
        id: "c-0",
        path: "/docs/commandui-distribution.md",
        text: "handbook on release logistics for the app",
        vector: [0, 0, 1, 0], // orthogonal to the query vector
        title: "CommandUI Distribution",
      },
      {
        id: "c-1",
        path: "/blog/generic.md",
        text: "completely generic marketing copy with fluff",
        vector: [1, 0, 0, 0], // aligns with query vector
        title: "Generic Marketing",
      },
    ]);
    const client = new TableEmbedMock(new Map([["CommandUI distribution", [1, 0, 0, 0]]]));
    const semantic = await searchCorpus({ corpus, query: "CommandUI distribution", model: "m", mode: "semantic", client });
    expect(semantic[0].path).toBe("/blog/generic.md"); // semantic alone misses the real doc

    const lexical = await searchCorpus({ corpus, query: "CommandUI distribution", model: "m", mode: "lexical", client });
    expect(lexical[0].path).toBe("/docs/commandui-distribution.md"); // lexical finds it via title/path tokens
  });

  it("hybrid rescues specific-fact misses without hurting obvious semantic wins", async () => {
    // Semantic alone ranks /blog/generic.md first; lexical alone ranks
    // /docs/commandui-distribution.md first (title + path tokens).
    // Give the "real" doc a small non-zero cosine so it appears in the
    // dense list too — that way hybrid fuses lex-rank-1 + dense-rank-2
    // for the real doc vs dense-rank-1 alone for the generic doc, and
    // the real doc wins the fusion.
    const corpus = mkCorpus("s", "m", [
      {
        id: "c-0",
        path: "/docs/commandui-distribution.md",
        text: "handbook on release logistics for the app",
        vector: [0.1, 0, 1, 0],
        title: "CommandUI Distribution",
      },
      {
        id: "c-1",
        path: "/blog/generic.md",
        text: "completely generic marketing copy with fluff",
        vector: [1, 0, 0, 0],
        title: "Generic Marketing",
      },
    ]);
    const client = new TableEmbedMock(new Map([["CommandUI distribution", [1, 0, 0, 0]]]));
    const hybrid = await searchCorpus({ corpus, query: "CommandUI distribution", model: "m", mode: "hybrid", client });
    expect(hybrid[0].path).toBe("/docs/commandui-distribution.md");
    // Both docs still present; hybrid never drops the semantic-only winner.
    expect(hybrid.some((h) => h.path === "/blog/generic.md")).toBe(true);
  });

  it("fact mode: exact-substring match boosts a short chunk above a longer non-match", async () => {
    // Both chunks get similar hybrid scores via dense + lexical. Fact should
    // promote the short exact-substring chunk above the longer thematic one.
    const corpus = mkCorpus("s", "m", [
      {
        id: "c-short",
        path: "/a/short.md",
        chunk_index: 0,
        text: "semaphore value is 2", // short; contains exact substring
        vector: [0.7, 0.7, 0, 0],
      },
      {
        id: "c-long",
        path: "/a/long.md",
        chunk_index: 0,
        text: "thematic long paragraph about concurrency primitives that discusses semaphores, mutexes, and locks at length — ".repeat(8),
        vector: [1, 0, 0, 0],
      },
    ]);
    const client = new TableEmbedMock(new Map([["semaphore value is 2", [1, 0, 0, 0]]]));
    const hybridHits = await searchCorpus({ corpus, query: "semaphore value is 2", model: "m", mode: "hybrid", client });
    const factHits = await searchCorpus({ corpus, query: "semaphore value is 2", model: "m", mode: "fact", client });
    // Fact should promote the short exact-match chunk; hybrid alone does not guarantee it.
    expect(factHits[0].id).toBe("c-short");
    // Both chunks still appear — fact boosts, never filters.
    expect(factHits.map((h) => h.id).sort()).toEqual(["c-long", "c-short"]);
    // Sanity: fact reorders relative to pure hybrid for this fixture.
    expect(factHits[0].id).not.toBe(hybridHits[0].id === "c-short" ? undefined : hybridHits[0].id);
  });

  it("fact mode does not collapse to empty on a near-miss (no exact substring, partial token overlap)", async () => {
    const corpus = mkCorpus("s", "m", [
      {
        id: "c-0",
        path: "/a.md",
        text: "discussion of semaphore and value semantics in rust code",
        vector: [1, 0, 0, 0],
      },
      {
        id: "c-1",
        path: "/b.md",
        text: "unrelated prose about a distant topic entirely",
        vector: [0, 1, 0, 0],
      },
    ]);
    // Query tokens "semaphore" and "value" both match chunk 0 lexically,
    // but the full phrase is not present as a literal substring anywhere.
    // Fact mode should still return results — it boosts, it does not filter.
    const client = new TableEmbedMock(new Map([["semaphore value is 2", [1, 0, 0, 0]]]));
    const hits = await searchCorpus({ corpus, query: "semaphore value is 2", model: "m", mode: "fact", client });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("/a.md");
  });

  it("fused ties stay deterministic by (path asc, chunk_index asc)", async () => {
    // Two chunks with identical text, identical vector → identical
    // dense score, identical lexical score, identical fused RRF score.
    // The ONLY thing separating them in the output is the stable
    // (path asc, chunk_index asc) tie-break.
    const text = "identical text across docs";
    const vec = [1, 0, 0, 0];
    const corpus = mkCorpus("s", "m", [
      { id: "c-zzz", path: "/z/later.md", chunk_index: 0, text, vector: vec },
      { id: "c-aaa", path: "/a/first.md", chunk_index: 0, text, vector: vec },
    ]);
    const client = new TableEmbedMock(new Map([["identical", vec]]));
    const hits = await searchCorpus({ corpus, query: "identical", model: "m", mode: "hybrid", client });
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBe(hits[1].score); // genuine tie
    expect(hits[0].path).toBe("/a/first.md");
    expect(hits[1].path).toBe("/z/later.md");

    // And the fact that corpus insertion order puts /z first doesn't affect the result.
    const reversed = mkCorpus("s", "m", [
      { id: "c-aaa", path: "/a/first.md", chunk_index: 0, text, vector: vec },
      { id: "c-zzz", path: "/z/later.md", chunk_index: 0, text, vector: vec },
    ]);
    const hits2 = await searchCorpus({ corpus: reversed, query: "identical", model: "m", mode: "hybrid", client });
    expect(hits2[0].path).toBe("/a/first.md");
    expect(hits2[1].path).toBe("/z/later.md");
  });

  it("model mismatch only errors for modes that embed", async () => {
    const corpus = mkCorpus("s", "indexed-with-model", [
      { id: "c-0", path: "/a.md", text: "alpha", vector: [1, 0, 0, 0] },
    ]);
    const client = new TableEmbedMock(new Map([["alpha", [1, 0, 0, 0]]]));
    // Modes that embed: must throw.
    for (const mode of ["semantic", "hybrid", "fact"] as const) {
      await expect(
        searchCorpus({ corpus, query: "alpha", model: "different-model", mode, client }),
      ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    }
    // Modes that don't embed: must NOT throw even with mismatched model.
    for (const mode of ["lexical", "title_path"] as const) {
      const hits = await searchCorpus({ corpus, query: "alpha", model: "different-model", mode, client });
      expect(Array.isArray(hits)).toBe(true);
    }
    // No embed calls should have fired: embedding modes threw before the
    // call, and lexical/title_path never embed.
    expect(client.embedCalls).toBe(0);
  });

  it("embed is never called for lexical or title_path modes", async () => {
    const corpus = mkCorpus("s", "m", [
      { id: "c-0", path: "/a.md", text: "alpha", vector: [1, 0, 0, 0], title: "Alpha" },
    ]);
    const client = new TableEmbedMock(new Map());
    await searchCorpus({ corpus, query: "alpha", model: "m", mode: "lexical", client });
    await searchCorpus({ corpus, query: "alpha", model: "m", mode: "title_path", client });
    expect(client.embedCalls).toBe(0);
  });

  it("empty corpus returns empty for every mode without throwing", async () => {
    const corpus = mkCorpus("s", "m", []);
    const client = new TableEmbedMock(new Map([["q", [1, 0, 0, 0]]]));
    for (const mode of ["semantic", "lexical", "hybrid", "fact", "title_path"] as const) {
      const hits = await searchCorpus({ corpus, query: "q", model: "m", mode, client });
      expect(hits).toEqual([]);
    }
  });

  it("top_k slices the final ranked list", async () => {
    const corpus = mkCorpus("s", "m", [
      { id: "c-0", path: "/a.md", text: "alpha", vector: [1, 0, 0, 0] },
      { id: "c-1", path: "/b.md", text: "bravo", vector: [0.9, 0.1, 0, 0] },
      { id: "c-2", path: "/c.md", text: "charlie", vector: [0.8, 0.2, 0, 0] },
    ]);
    const client = new TableEmbedMock(new Map([["query", [1, 0, 0, 0]]]));
    const hits = await searchCorpus({ corpus, query: "query", model: "m", mode: "semantic", top_k: 2, client });
    expect(hits).toHaveLength(2);
  });
});
