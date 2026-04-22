/**
 * Tests for ollama_corpus_search enhancements — filter.{path_glob, since}
 * and explain:true.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexCorpus } from "../../src/corpus/indexer.js";
import { handleCorpusSearch, globToRegex, applyFilter } from "../../src/tools/corpusSearch.js";
import { loadCorpus } from "../../src/corpus/storage.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
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
import type { RunContext } from "../../src/runContext.js";

function toVec(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const ch of text.toLowerCase()) {
    const code = ch.charCodeAt(0);
    if (code >= 97 && code <= 122) v[(code - 97) % 8] += 1;
  }
  const sum = v.reduce((s, x) => s + x, 0) || 1;
  return v.map((x) => x / sum);
}

class HashEmbedMock implements OllamaClient {
  public explainCalls = 0;
  public explainShouldFail = false;
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.explainCalls += 1;
    if (this.explainShouldFail) throw new Error("llm unavailable");
    // Deterministic response so assertions can look for marker text.
    return {
      model: req.model,
      response: `matches because the chunk mentions query terms`,
      done: true,
      prompt_eval_count: 30,
      eval_count: 10,
    };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> {
    throw new Error("not used");
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: req.model, embeddings: inputs.map((t) => toVec(t)) };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient): RunContext & { logger: NullLogger } {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

let tempCorpusDir: string;
let tempSourceDir: string;
let origCorpusDir: string | undefined;
let origAllowed: string | undefined;
const MODEL = PROFILES["dev-rtx5080"].tiers.embed;

const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;
const MODULE_ORIG_ALLOWED = process.env.INTERN_CORPUS_ALLOWED_ROOTS;

beforeEach(async () => {
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  origAllowed = process.env.INTERN_CORPUS_ALLOWED_ROOTS;
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-search-fx-corpus-"));
  tempSourceDir = await mkdtemp(join(tmpdir(), "intern-search-fx-src-"));
  process.env.INTERN_CORPUS_DIR = tempCorpusDir;
  process.env.INTERN_CORPUS_ALLOWED_ROOTS = tmpdir();
});

afterEach(async () => {
  try {
    const toRestoreCorpus = origCorpusDir ?? MODULE_ORIG_CORPUS_DIR;
    const toRestoreAllowed = origAllowed ?? MODULE_ORIG_ALLOWED;
    if (toRestoreCorpus === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = toRestoreCorpus;
    if (toRestoreAllowed === undefined) delete process.env.INTERN_CORPUS_ALLOWED_ROOTS;
    else process.env.INTERN_CORPUS_ALLOWED_ROOTS = toRestoreAllowed;
  } finally {
    if (tempCorpusDir) await rm(tempCorpusDir, { recursive: true, force: true });
    if (tempSourceDir) await rm(tempSourceDir, { recursive: true, force: true });
  }
});

async function writeSource(name: string, content: string): Promise<string> {
  const p = join(tempSourceDir, name);
  await writeFile(p, content, "utf8");
  return p;
}

describe("globToRegex (path filter primitive)", () => {
  it("matches simple wildcards", () => {
    expect(globToRegex("*.md").test("file.md")).toBe(true);
    expect(globToRegex("*.md").test("file.txt")).toBe(false);
  });

  it("handles ** across multiple segments", () => {
    expect(globToRegex("/a/**/file.md").test("/a/b/c/file.md")).toBe(true);
    expect(globToRegex("/a/**/file.md").test("/a/file.md")).toBe(true);
  });

  it("treats slashes and backslashes as equivalent separators", () => {
    const rx = globToRegex("/a/b/*.md");
    expect(rx.test("\\a\\b\\x.md")).toBe(true);
    expect(rx.test("/a/b/x.md")).toBe(true);
  });
});

describe("applyFilter (in-process)", () => {
  it("filters by path_glob", async () => {
    const aPath = await writeSource("a.md", "alpha body");
    const bPath = await writeSource("b.md", "bravo body");
    await indexCorpus({ name: "f1", paths: [aPath, bPath], model: MODEL, client: new HashEmbedMock() });
    const corpus = (await loadCorpus("f1"))!;
    const glob = `${tempSourceDir.replace(/\\/g, "/")}/a*.md`;
    const result = applyFilter(corpus, { path_glob: glob });
    expect(result.kept).toBeGreaterThan(0);
    expect(result.corpus.chunks.every((c) => c.path === aPath)).toBe(true);
  });

  it("filters by since (ISO timestamp)", async () => {
    const aPath = await writeSource("a.md", "alpha body");
    await indexCorpus({ name: "f2", paths: [aPath], model: MODEL, client: new HashEmbedMock() });
    const corpus = (await loadCorpus("f2"))!;
    // since in the far future → nothing survives.
    const r = applyFilter(corpus, { since: "2099-01-01T00:00:00Z" });
    expect(r.kept).toBe(0);
    // since in the far past → everything survives.
    const r2 = applyFilter(corpus, { since: "1970-01-01T00:00:00Z" });
    expect(r2.kept).toBe(corpus.chunks.length);
  });

  it("rejects invalid since timestamps with FILTER_INVALID", () => {
    // Minimal corpus — the filter check short-circuits before any chunk iteration.
    const fakeCorpus = {
      schema_version: 2,
      name: "x",
      model_version: MODEL,
      model_digest: null,
      indexed_at: "2026-01-01T00:00:00Z",
      chunk_chars: 800,
      chunk_overlap: 100,
      stats: { documents: 0, chunks: 0, total_chars: 0 },
      titles: {},
      chunks: [],
    };
    expect(() => applyFilter(fakeCorpus, { since: "not-a-date" })).toThrow(/not a parseable/i);
  });
});

describe("handleCorpusSearch — filter integration", () => {
  it("filter.path_glob keeps only matching chunks in results", async () => {
    const aPath = await writeSource("a.md", "alpha content body");
    const bPath = await writeSource("b.md", "bravo content body");
    await indexCorpus({ name: "s1", paths: [aPath, bPath], model: MODEL, client: new HashEmbedMock() });

    const glob = `${tempSourceDir.replace(/\\/g, "/")}/a*.md`;
    const env = await handleCorpusSearch(
      {
        corpus: "s1",
        query: "content",
        mode: "lexical",
        filter: { path_glob: glob },
        top_k: 10,
      },
      makeCtx(new HashEmbedMock()),
    );
    expect(env.result.hits.length).toBeGreaterThan(0);
    expect(env.result.hits.every((h) => h.path === aPath)).toBe(true);
    expect(env.result.filter_applied).toBeDefined();
    expect(env.result.filter_applied!.path_glob).toBe(glob);
  });

  it("filter.since drops stale chunks before ranking", async () => {
    const aPath = await writeSource("a.md", "alpha body");
    await indexCorpus({ name: "s2", paths: [aPath], model: MODEL, client: new HashEmbedMock() });
    const env = await handleCorpusSearch(
      {
        corpus: "s2",
        query: "alpha",
        mode: "lexical",
        filter: { since: "2099-01-01T00:00:00Z" },
      },
      makeCtx(new HashEmbedMock()),
    );
    expect(env.result.hits).toEqual([]);
    expect(env.result.filter_applied!.kept).toBe(0);
  });

  it("combines path_glob and since filters", async () => {
    const aPath = await writeSource("a.md", "alpha body");
    const bPath = await writeSource("b.md", "bravo body");
    await indexCorpus({ name: "s3", paths: [aPath, bPath], model: MODEL, client: new HashEmbedMock() });
    const glob = `${tempSourceDir.replace(/\\/g, "/")}/b*.md`;
    const env = await handleCorpusSearch(
      {
        corpus: "s3",
        query: "body",
        mode: "lexical",
        filter: { path_glob: glob, since: "1970-01-01T00:00:00Z" },
      },
      makeCtx(new HashEmbedMock()),
    );
    expect(env.result.hits.every((h) => h.path === bPath)).toBe(true);
    expect(env.result.filter_applied!.path_glob).toBeDefined();
    expect(env.result.filter_applied!.since).toBeDefined();
  });
});

describe("handleCorpusSearch — explain integration", () => {
  it("populates why_matched on top hits when explain=true", async () => {
    const p = await writeSource("a.md", "alpha content body here with some detail to rank");
    await indexCorpus({ name: "ex1", paths: [p], model: MODEL, client: new HashEmbedMock() });

    const client = new HashEmbedMock();
    const env = await handleCorpusSearch(
      { corpus: "ex1", query: "alpha", mode: "lexical", explain: true, top_k: 3 },
      makeCtx(client),
    );
    expect(env.result.hits.length).toBeGreaterThan(0);
    // Each of the (up to 5) top hits should have why_matched set to the mock's response.
    for (const h of env.result.hits) {
      expect(h.why_matched).toBe("matches because the chunk mentions query terms");
    }
    expect(client.explainCalls).toBeGreaterThan(0);
  });

  it("degrades gracefully when LLM is unavailable — no why_matched, adds a warning", async () => {
    const p = await writeSource("a.md", "alpha content body");
    await indexCorpus({ name: "ex2", paths: [p], model: MODEL, client: new HashEmbedMock() });

    const client = new HashEmbedMock();
    client.explainShouldFail = true;
    const env = await handleCorpusSearch(
      { corpus: "ex2", query: "alpha", mode: "lexical", explain: true, top_k: 2 },
      makeCtx(client),
    );
    for (const h of env.result.hits) {
      expect(h.why_matched).toBeUndefined();
    }
    expect(env.warnings?.some((w) => /explain/i.test(w))).toBe(true);
  });

  it("does NOT call the LLM when explain is not set", async () => {
    const p = await writeSource("a.md", "body");
    await indexCorpus({ name: "ex3", paths: [p], model: MODEL, client: new HashEmbedMock() });

    const client = new HashEmbedMock();
    const env = await handleCorpusSearch(
      { corpus: "ex3", query: "body", mode: "lexical" },
      makeCtx(client),
    );
    expect(client.explainCalls).toBe(0);
    for (const h of env.result.hits) {
      expect(h.why_matched).toBeUndefined();
    }
  });
});
