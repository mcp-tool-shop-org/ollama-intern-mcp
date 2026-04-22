/**
 * Tests for ollama_corpus_rerank — no-LLM post-retrieval re-sort.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleCorpusRerank, globToRegex } from "../../src/tools/corpusRerank.js";
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

// Silence unused warnings for the glob helper — imported so its
// presence in corpusSearch doesn't lose test coverage by accident.
void globToRegex;

class DummyClient implements OllamaClient {
  async generate(_: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used by rerank");
  }
  async chat(_: ChatRequest): Promise<ChatResponse> {
    throw new Error("not used by rerank");
  }
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    throw new Error("not used by rerank");
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(): RunContext & { logger: NullLogger } {
  return {
    client: new DummyClient(),
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-rerank-"));
});
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function writeAt(name: string, content: string, mtimeMs: number): Promise<string> {
  const p = join(tempDir, name);
  await writeFile(p, content, "utf8");
  const sec = mtimeMs / 1000;
  await utimes(p, sec, sec);
  return p;
}

describe("handleCorpusRerank — recency", () => {
  it("sorts by file mtime descending (newer wins)", async () => {
    const oldFile = await writeAt("old.md", "old", Date.now() - 10 * 24 * 60 * 60 * 1000);
    const newFile = await writeAt("new.md", "new", Date.now());
    const env = await handleCorpusRerank(
      {
        rerank_by: "recency",
        hits: [
          { id: "1", path: oldFile, score: 0.9, chunk_index: 0 },
          { id: "2", path: newFile, score: 0.5, chunk_index: 0 },
        ],
      },
      makeCtx(),
    );
    expect(env.result.hits[0].path).toBe(newFile);
    expect(env.result.hits[1].path).toBe(oldFile);
    expect(env.result.hits[0].rank).toBe(1);
    expect(env.result.hits[0].original_rank).toBe(2);
  });

  it("treats missing files as oldest (mtime=0) without throwing", async () => {
    const real = await writeAt("real.md", "body", Date.now());
    const env = await handleCorpusRerank(
      {
        rerank_by: "recency",
        hits: [
          { id: "1", path: join(tempDir, "ghost.md"), score: 0.9, chunk_index: 0 },
          { id: "2", path: real, score: 0.1, chunk_index: 0 },
        ],
      },
      makeCtx(),
    );
    expect(env.result.hits[0].path).toBe(real);
  });

  it("preserves input-order tiebreak when mtimes are identical", async () => {
    const t = Date.now();
    const a = await writeAt("a.md", "a", t);
    const b = await writeAt("b.md", "b", t);
    const env = await handleCorpusRerank(
      {
        rerank_by: "recency",
        hits: [
          { id: "1", path: a, score: 0.1, chunk_index: 0 },
          { id: "2", path: b, score: 0.9, chunk_index: 0 },
        ],
      },
      makeCtx(),
    );
    // Equal mtimes → input-order preserved.
    expect(env.result.hits[0].id).toBe("1");
    expect(env.result.hits[1].id).toBe("2");
  });
});

describe("handleCorpusRerank — path_specificity", () => {
  it("ranks deeper paths above shallower ones", async () => {
    const env = await handleCorpusRerank(
      {
        rerank_by: "path_specificity",
        hits: [
          { id: "1", path: "/a/file.md", score: 0.9, chunk_index: 0 },
          { id: "2", path: "/a/b/c/file.md", score: 0.1, chunk_index: 0 },
          { id: "3", path: "/a/b/file.md", score: 0.5, chunk_index: 0 },
        ],
      },
      makeCtx(),
    );
    expect(env.result.hits[0].path).toBe("/a/b/c/file.md");
    expect(env.result.hits[1].path).toBe("/a/b/file.md");
    expect(env.result.hits[2].path).toBe("/a/file.md");
  });

  it("treats Windows and POSIX separators equivalently", async () => {
    const env = await handleCorpusRerank(
      {
        rerank_by: "path_specificity",
        hits: [
          { id: "1", path: "C:\\a\\b\\file.md", score: 0, chunk_index: 0 },
          { id: "2", path: "/x/file.md", score: 0, chunk_index: 0 },
        ],
      },
      makeCtx(),
    );
    expect(env.result.hits[0].id).toBe("1");
  });

  it("handles single-segment paths without crashing", async () => {
    const env = await handleCorpusRerank(
      {
        rerank_by: "path_specificity",
        hits: [
          { id: "1", path: "solo.md", score: 0, chunk_index: 0 },
          { id: "2", path: "/a/b/file.md", score: 0, chunk_index: 0 },
        ],
      },
      makeCtx(),
    );
    expect(env.result.hits[0].id).toBe("2");
  });
});

describe("handleCorpusRerank — lexical_boost", () => {
  it("boosts hits whose preview contains a term", async () => {
    const env = await handleCorpusRerank(
      {
        rerank_by: "lexical_boost",
        lexical_terms: ["prologue"],
        hits: [
          {
            id: "1",
            path: "/x.md",
            score: 0.5,
            chunk_index: 0,
            preview: "this describes the prologue opening scene",
          },
          {
            id: "2",
            path: "/y.md",
            score: 0.6,
            chunk_index: 0,
            preview: "something unrelated about ships",
          },
        ],
      },
      makeCtx(),
    );
    // Hit 1 (0.5 + 1 = 1.5) now outranks hit 2 (0.6).
    expect(env.result.hits[0].id).toBe("1");
    expect(env.result.hits[0].rerank_score).toBeGreaterThan(1);
  });

  it("matches terms against heading_path and title too", async () => {
    const env = await handleCorpusRerank(
      {
        rerank_by: "lexical_boost",
        lexical_terms: ["Combat"],
        hits: [
          {
            id: "1",
            path: "/doc.md",
            score: 0.1,
            chunk_index: 0,
            heading_path: ["Doctrine", "Combat Rules"],
          },
          {
            id: "2",
            path: "/doc2.md",
            score: 0.5,
            chunk_index: 0,
            title: "Economy Overview",
          },
        ],
      },
      makeCtx(),
    );
    // Case-insensitive match on heading_path → hit 1 boosted.
    expect(env.result.hits[0].id).toBe("1");
  });

  it("rejects lexical_boost without lexical_terms", async () => {
    await expect(
      handleCorpusRerank(
        {
          rerank_by: "lexical_boost",
          hits: [{ id: "1", path: "/x.md", score: 0.5, chunk_index: 0 }],
        } as Parameters<typeof handleCorpusRerank>[0],
        makeCtx(),
      ),
    ).rejects.toBeTruthy();
  });
});
