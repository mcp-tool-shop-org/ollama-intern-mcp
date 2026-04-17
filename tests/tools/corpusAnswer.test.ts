/**
 * ollama_corpus_answer tests — slice 5 of the Retrieval Truth Spine.
 *
 * Covers the laws the handler promises:
 *   - chunk-grounded citations: model citation numbers map back to
 *     (path, chunk_index, heading_path, title) from the retrieval step
 *   - citation stripping: out-of-range numbers are dropped with a warning
 *   - coverage: multi-source retrieval surfaces omitted paths
 *   - weak retrieval degrades honestly: 0 hits short-circuits the model,
 *     1 hit flags weak
 *   - mode passthrough: mode argument reaches searchCorpus
 *   - no raw chunk text leaks: the result shape is only {answer,
 *     citations, coverage fields, retrieval stats}
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

class ProgrammableClient implements OllamaClient {
  public lastPrompt?: string;
  public generateCalls = 0;
  public embedCalls = 0;
  constructor(
    private readonly generateResponse: string,
    private readonly embedTable: Map<string, number[]> = new Map(),
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.generateCalls += 1;
    this.lastPrompt = req.prompt;
    return { model: req.model, response: this.generateResponse, done: true, prompt_eval_count: 50, eval_count: 20 };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      embeddings: inputs.map((t) => this.embedTable.get(t) ?? [1, 0, 0, 0]),
    };
  }
  async residency(_m: string): Promise<Residency | null> {
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

interface ChunkSpec {
  id: string;
  path: string;
  chunk_index?: number;
  text: string;
  heading_path?: string[];
}

/** Build a v2 corpus on disk so handleCorpusAnswer's loadCorpus() finds it. */
async function writeCorpus(
  name: string,
  modelVersion: string,
  specs: ChunkSpec[],
  titles: Record<string, string | null> = {},
): Promise<void> {
  // Ensure every path has a title entry (null if unspecified).
  const fullTitles: Record<string, string | null> = { ...titles };
  for (const s of specs) {
    if (!(s.path in fullTitles)) fullTitles[s.path] = null;
  }
  const corpus: CorpusFile = {
    schema_version: CORPUS_SCHEMA_VERSION,
    name,
    model_version: modelVersion,
    model_digest: null,
    indexed_at: "2026-04-17T00:00:00.000Z",
    chunk_chars: 800,
    chunk_overlap: 100,
    stats: {
      documents: new Set(specs.map((s) => s.path)).size,
      chunks: specs.length,
      total_chars: specs.reduce((n, s) => n + s.text.length, 0),
    },
    titles: fullTitles,
    chunks: specs.map((s) => ({
      id: s.id,
      path: s.path,
      file_hash: "sha256:test",
      file_mtime: "2026-04-17T00:00:00.000Z",
      chunk_index: s.chunk_index ?? 0,
      char_start: 0,
      char_end: s.text.length,
      text: s.text,
      vector: [1, 0, 0, 0],
      heading_path: s.heading_path ?? [],
      chunk_type: "paragraph",
    })),
  };
  await saveCorpus(corpus);
}

// ── Fixture lifecycle ───────────────────────────────────────

let tempDir: string;
let origCorpusDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-answer-"));
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  process.env.INTERN_CORPUS_DIR = tempDir;
});

afterEach(async () => {
  if (origCorpusDir === undefined) delete process.env.INTERN_CORPUS_DIR;
  else process.env.INTERN_CORPUS_DIR = origCorpusDir;
  await rm(tempDir, { recursive: true, force: true });
});

// The embed model for dev-rtx5080 — must match what writeCorpus persists
// so searchCorpus's model-mismatch guard doesn't trip in modes that embed.
const EMBED_MODEL = PROFILES["dev-rtx5080"].tiers.embed;

// ── Tests ───────────────────────────────────────────────────

describe("handleCorpusAnswer", () => {
  it("happy path: citations map back to (path, chunk_index, heading_path, title)", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", chunk_index: 0, text: "alpha body about topic", heading_path: ["Alpha", "Intro"] },
      { id: "c-1", path: "/docs/bravo.md", chunk_index: 2, text: "bravo body about topic", heading_path: ["Bravo"] },
    ], { "/docs/alpha.md": "Alpha Doc", "/docs/bravo.md": null });

    const modelOut = JSON.stringify({
      answer: "The topic is discussed in both sources.",
      citations: [1, 2],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "what is the topic", mode: "lexical" },
      makeCtx(client),
    );

    expect(env.result.answer).toContain("The topic");
    expect(env.result.citations).toHaveLength(2);
    const c1 = env.result.citations.find((c) => c.path === "/docs/alpha.md")!;
    expect(c1.chunk_index).toBe(0);
    expect(c1.heading_path).toEqual(["Alpha", "Intro"]);
    expect(c1.title).toBe("Alpha Doc");
    const c2 = env.result.citations.find((c) => c.path === "/docs/bravo.md")!;
    expect(c2.chunk_index).toBe(2);
    expect(c2.title).toBeNull();
  });

  it("strips out-of-range citation numbers and warns", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", text: "alpha body about topic" },
    ]);
    const modelOut = JSON.stringify({
      answer: "The answer.",
      citations: [1, 9, -3, 42], // only 1 is valid
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic", mode: "lexical" },
      makeCtx(client),
    );
    expect(env.result.citations).toHaveLength(1);
    expect(env.result.citations[0].path).toBe("/docs/alpha.md");
    const strippedNote = env.result.coverage_notes.find((n) => n.includes("Stripped"));
    expect(strippedNote).toBeDefined();
    expect(env.warnings?.some((w) => w.includes("Stripped"))).toBe(true);
  });

  it("coverage: flags omitted retrieved paths when answer cites only a subset", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", chunk_index: 0, text: "alpha topic body" },
      { id: "c-1", path: "/docs/bravo.md", chunk_index: 0, text: "bravo topic body" },
      { id: "c-2", path: "/docs/gamma.md", chunk_index: 0, text: "gamma topic body" },
    ]);
    const modelOut = JSON.stringify({
      answer: "Only alpha.",
      citations: [1], // cite only alpha
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic", mode: "lexical", top_k: 3 },
      makeCtx(client),
    );
    expect(env.result.covered_sources).toEqual(["/docs/alpha.md"]);
    expect(env.result.omitted_sources.sort()).toEqual(["/docs/bravo.md", "/docs/gamma.md"]);
    const omissionNote = env.result.coverage_notes.find((n) => n.includes("Uncited"));
    expect(omissionNote).toBeDefined();
  });

  it("zero retrieval hits short-circuits without invoking the model", async () => {
    // Write an empty corpus — search must return 0 hits.
    await writeCorpus("empty", EMBED_MODEL, []);
    const client = new ProgrammableClient('{"answer":"should not see this","citations":[]}');
    const env = await handleCorpusAnswer(
      { corpus: "empty", question: "anything", mode: "lexical" },
      makeCtx(client),
    );
    expect(client.generateCalls).toBe(0);
    expect(env.result.retrieval.retrieved).toBe(0);
    expect(env.result.retrieval.weak).toBe(true);
    expect(env.result.citations).toEqual([]);
    expect(env.result.answer).toMatch(/No matching chunks/);
    expect(env.warnings?.some((w) => w.includes("zero retrieval"))).toBe(true);
  });

  it("single-hit retrieval flags weak and adds a coverage note", async () => {
    await writeCorpus("thin", EMBED_MODEL, [
      { id: "c-0", path: "/docs/only.md", text: "the only chunk about topic" },
    ]);
    const client = new ProgrammableClient(
      JSON.stringify({ answer: "Narrow answer.", citations: [1] }),
    );
    const env = await handleCorpusAnswer(
      { corpus: "thin", question: "topic", mode: "lexical" },
      makeCtx(client),
    );
    expect(env.result.retrieval.retrieved).toBe(1);
    expect(env.result.retrieval.weak).toBe(true);
    const weakNote = env.result.coverage_notes.find((n) => n.toLowerCase().includes("weak"));
    expect(weakNote).toBeDefined();
  });

  it("mode=title_path is passed through and skips the embed call", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", text: "body", heading_path: ["Topic", "Sub"] },
    ], { "/docs/alpha.md": "Topic Handbook" });
    const client = new ProgrammableClient(
      JSON.stringify({ answer: "found it.", citations: [1] }),
    );
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic handbook", mode: "title_path" },
      makeCtx(client),
    );
    expect(client.embedCalls).toBe(0);
    expect(env.result.mode).toBe("title_path");
    expect(env.result.citations).toHaveLength(1);
  });

  it("default mode is hybrid (exercises the embed rail)", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", text: "alpha body about topic" },
    ]);
    const client = new ProgrammableClient(
      JSON.stringify({ answer: "A.", citations: [1] }),
    );
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic" },
      makeCtx(client),
    );
    expect(env.result.mode).toBe("hybrid");
    expect(client.embedCalls).toBeGreaterThan(0);
  });

  it("no raw chunk text leaks into the result envelope", async () => {
    const secretText = "UNIQUE_CHUNK_CANARY_STRING_9873";
    // Include the query token so lexical retrieval actually hits this chunk.
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", text: `${secretText} topic discussion` },
    ]);
    const client = new ProgrammableClient(
      JSON.stringify({ answer: "done.", citations: [1] }),
    );
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic", mode: "lexical" },
      makeCtx(client),
    );
    // Serialize the whole envelope — the chunk body must never appear.
    const serialized = JSON.stringify(env.result);
    expect(serialized).not.toContain(secretText);
    // The prompt sent to the model obviously contains it — that's expected.
    expect(client.lastPrompt).toContain(secretText);
  });

  it("non-JSON model output is captured as answer with empty citations and a warning", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", text: "alpha body about topic" },
    ]);
    const client = new ProgrammableClient("this is not JSON — just prose.");
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic", mode: "lexical" },
      makeCtx(client),
    );
    expect(env.result.answer).toBe("this is not JSON — just prose.");
    expect(env.result.citations).toEqual([]);
    expect(env.warnings?.some((w) => w.includes("no structured citations"))).toBe(true);
  });

  it("duplicate citation numbers are deduped against the retrieval list", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/alpha.md", chunk_index: 0, text: "alpha body about topic" },
    ]);
    const modelOut = JSON.stringify({ answer: "A.", citations: [1, 1, 1] });
    const client = new ProgrammableClient(modelOut);
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic", mode: "lexical" },
      makeCtx(client),
    );
    expect(env.result.citations).toHaveLength(1);
  });

  it("unknown corpus throws SCHEMA_INVALID", async () => {
    const client = new ProgrammableClient("{}");
    await expect(
      handleCorpusAnswer(
        { corpus: "does-not-exist", question: "q", mode: "lexical" },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(client.generateCalls).toBe(0);
  });

  it("retrieval block carries retrieved / total_in_corpus / top_score / weak", async () => {
    await writeCorpus("t", EMBED_MODEL, [
      { id: "c-0", path: "/docs/a.md", text: "alpha body topic one" },
      { id: "c-1", path: "/docs/b.md", text: "bravo body topic two" },
      { id: "c-2", path: "/docs/c.md", text: "gamma body topic three" },
      { id: "c-3", path: "/docs/d.md", text: "delta body topic four" },
    ]);
    const client = new ProgrammableClient(
      JSON.stringify({ answer: "A.", citations: [1] }),
    );
    const env = await handleCorpusAnswer(
      { corpus: "t", question: "topic", mode: "lexical", top_k: 3 },
      makeCtx(client),
    );
    expect(env.result.retrieval.retrieved).toBe(3);
    expect(env.result.retrieval.total_in_corpus).toBe(4);
    expect(env.result.retrieval.top_score).toBeGreaterThan(0);
    expect(env.result.retrieval.weak).toBe(false);
  });
});
