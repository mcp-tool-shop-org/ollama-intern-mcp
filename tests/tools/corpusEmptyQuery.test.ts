/**
 * Empty-query handling at the tool layer — Fix 1 of Stage B+C.
 *
 * The zod schema accepts " " as a valid query (min(1) is string length,
 * not trimmed length). Without an explicit short-circuit, both
 * corpus_search and corpus_answer would fall through to the embed tier
 * on whitespace-only input — a wasted round-trip that returns noise
 * ranked by index order.
 *
 * Both tools must return a weak-flagged envelope with `warnings`
 * explaining why retrieval was zero. Cheaper to surface "you asked
 * nothing" than to pretend we searched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleCorpusSearch } from "../../src/tools/corpusSearch.js";
import { handleCorpusAnswer } from "../../src/tools/corpusAnswer.js";
import { saveCorpus, CORPUS_SCHEMA_VERSION, type CorpusFile } from "../../src/corpus/storage.js";
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

// ── Helpers ─────────────────────────────────────────────────

class RefuseClient implements OllamaClient {
  public embedCalls = 0;
  public generateCalls = 0;
  async generate(_: GenerateRequest): Promise<GenerateResponse> {
    this.generateCalls += 1;
    throw new Error("generate must not be called on empty query");
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    throw new Error("embed must not be called on empty query");
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient): RunContext {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

const EMBED_MODEL = PROFILES["dev-rtx5080"].tiers.embed;

async function writeToyCorpus(name: string): Promise<void> {
  const corpus: CorpusFile = {
    schema_version: CORPUS_SCHEMA_VERSION,
    name,
    model_version: EMBED_MODEL,
    model_digest: null,
    indexed_at: "2026-04-21T00:00:00.000Z",
    chunk_chars: 800,
    chunk_overlap: 100,
    stats: { documents: 1, chunks: 1, total_chars: 10 },
    titles: { "/docs/a.md": null },
    chunks: [
      {
        id: "c-0",
        path: "/docs/a.md",
        file_hash: "sha256:test",
        file_mtime: "2026-04-21T00:00:00.000Z",
        chunk_index: 0,
        char_start: 0,
        char_end: 10,
        text: "alpha body",
        vector: [1, 0, 0, 0],
        heading_path: [],
        chunk_type: "paragraph",
      },
    ],
  };
  await saveCorpus(corpus);
}

// ── Fixture lifecycle ───────────────────────────────────────

let tempDir: string;
let origCorpusDir: string | undefined;
const MODULE_ORIG = process.env.INTERN_CORPUS_DIR;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-empty-query-"));
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  process.env.INTERN_CORPUS_DIR = tempDir;
});

afterEach(async () => {
  const toRestore = origCorpusDir ?? MODULE_ORIG;
  try {
    if (toRestore === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = toRestore;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────

describe("empty query: corpus_search", () => {
  it("whitespace-only query returns weak:true with no embed call", async () => {
    await writeToyCorpus("t");
    const client = new RefuseClient();
    const env = await handleCorpusSearch(
      { corpus: "t", query: "   " },
      makeCtx(client),
    );
    expect(env.result.hits).toEqual([]);
    expect(env.result.weak).toBe(true);
    expect(env.result.reason).toBe("empty query");
    expect(env.warnings).toBeDefined();
    expect(env.warnings!.some((w) => w.includes("empty query"))).toBe(true);
    expect(client.embedCalls).toBe(0);
  });

  it("newline-only query is treated as empty", async () => {
    await writeToyCorpus("t");
    const client = new RefuseClient();
    const env = await handleCorpusSearch(
      { corpus: "t", query: "\n\t  \n" },
      makeCtx(client),
    );
    expect(env.result.weak).toBe(true);
    expect(client.embedCalls).toBe(0);
  });
});

describe("empty query: corpus_answer", () => {
  it("whitespace-only question returns weak retrieval, no model call", async () => {
    await writeToyCorpus("t");
    const client = new RefuseClient();
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "   " },
      makeCtx(client),
    );
    expect(env.result.retrieval.retrieved).toBe(0);
    expect(env.result.retrieval.weak).toBe(true);
    expect(env.result.coverage_notes.some((n) => n.toLowerCase().includes("empty question"))).toBe(
      true,
    );
    expect(env.warnings).toBeDefined();
    expect(env.warnings!.some((w) => w.toLowerCase().includes("empty question"))).toBe(true);
    // Neither embed nor generate may run for an empty question.
    expect(client.embedCalls).toBe(0);
    expect(client.generateCalls).toBe(0);
  });
});
