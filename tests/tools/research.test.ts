/**
 * ollama_research tests — abstention + weak + line_range bounds.
 *
 * This is the first dedicated test file for the research flagship. It
 * covers behavior the regressions file touches only obliquely:
 *
 *   - existing baseline: valid citations come through, no weak/abstained
 *   - empty citations + non-empty answer → weak=true, sources_address_question=false
 *   - abstention regex match → abstained=true, citations cleared
 *   - line_range past EOF → range stripped, warning appended, path kept
 *
 * Citation parsing uses `:` as the path/line-range separator, which means
 * Windows drive-letter paths (`C:\...`) trip the regex. To keep these
 * tests rig-portable we work under a project-relative temp subdirectory
 * — loadSources resolves the relative path to absolute on disk, but the
 * normalized comparison key stays `:`-free.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";

import { handleResearch } from "../../src/tools/research.js";
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
  constructor(private readonly response: string) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.lastPrompt = req.prompt;
    return { model: req.model, response: this.response, done: true, prompt_eval_count: 50, eval_count: 20 };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: req.model, embeddings: inputs.map(() => [1, 0, 0, 0]) };
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

let tempDir: string;

beforeEach(async () => {
  // Project-relative tmp dir so the path key the citation parser sees has
  // no Windows drive-letter `:` separator. The path is still real on disk
  // — loadSources resolve()s it to absolute internally.
  const base = await mkdtemp("intern-research-test-");
  tempDir = base.replace(/\\/g, "/");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeRelFile(name: string, content: string): Promise<string> {
  const rel = `${tempDir}/${name}`;
  await writeFile(rel, content, "utf8");
  return rel;
}

// ── Tests ───────────────────────────────────────────────────

describe("handleResearch — baseline grounded answer", () => {
  it("valid citations come through; no weak/abstained signal", async () => {
    const f = await writeRelFile("doc.md", "alpha bravo\ngamma delta\nepsilon\n");
    const client = new ProgrammableClient(
      `The doc covers four greek letters.\n\nSources:\n${f}:1-2\n`,
    );
    const env = await handleResearch(
      { question: "what does it cover", source_paths: [f] },
      makeCtx(client),
    );
    expect(env.result.citations).toHaveLength(1);
    expect(env.result.citations[0].path).toBe(f);
    expect(env.result.citations[0].line_range).toBe("1-2");
    // Tri-state honesty: with a valid citation we don't know if the
    // sources truly address the question, so sources_address_question
    // stays null and abstained=false.
    expect(env.result.weak).toBeUndefined();
    expect(env.result.abstained).toBe(false);
    expect(env.result.sources_address_question).toBeNull();
  });
});

describe("handleResearch — weak: empty citations + non-empty answer", () => {
  it("flags weak=true and sources_address_question=false", async () => {
    const f = await writeRelFile("doc.md", "real content here");
    // Model produces an answer and cites ONLY a path not in source_paths.
    // After stripping, valid citations is empty but answer is non-empty.
    const client = new ProgrammableClient(
      `I think the answer is roughly X.\n\nSources:\nfabricated.md\n`,
    );
    const env = await handleResearch(
      { question: "q", source_paths: [f] },
      makeCtx(client),
    );
    expect(env.result.citations).toHaveLength(0);
    expect(env.result.weak).toBe(true);
    expect(env.result.abstained).toBe(false);
    expect(env.result.sources_address_question).toBe(false);
    const note = env.result.coverage_notes?.find((n) => n.includes("no validated citations"));
    expect(note).toBeDefined();
  });
});

describe("handleResearch — abstention", () => {
  it("the sources do not contain X → abstained=true and citations cleared", async () => {
    const f = await writeRelFile("doc.md", "real content");
    const client = new ProgrammableClient(
      `The sources do not contain the answer to this question.\n\nSources:\n${f}\n`,
    );
    const env = await handleResearch(
      { question: "q", source_paths: [f] },
      makeCtx(client),
    );
    expect(env.result.abstained).toBe(true);
    expect(env.result.sources_address_question).toBe(false);
    // Citations are cleared on abstention — even valid ones are spurious
    // when the model said it can't answer.
    expect(env.result.citations).toEqual([]);
    const note = env.result.coverage_notes?.find((n) => n.includes("abstained"));
    expect(note).toBeDefined();
  });

  it("'cannot answer' phrasing also trips the abstention regex", async () => {
    const f = await writeRelFile("doc.md", "real");
    const client = new ProgrammableClient(
      `I cannot answer this from the provided material.\n\nSources:\n${f}\n`,
    );
    const env = await handleResearch(
      { question: "q", source_paths: [f] },
      makeCtx(client),
    );
    expect(env.result.abstained).toBe(true);
    expect(env.result.citations).toEqual([]);
  });

  it("'insufficient information' phrasing trips abstention", async () => {
    const f = await writeRelFile("doc.md", "real");
    const client = new ProgrammableClient(
      `Insufficient information is available to answer.\n\nSources:\n${f}\n`,
    );
    const env = await handleResearch(
      { question: "q", source_paths: [f] },
      makeCtx(client),
    );
    expect(env.result.abstained).toBe(true);
  });
});

describe("handleResearch — line_range bounds check", () => {
  it("range past EOF has line_range dropped, path kept, warning emitted", async () => {
    // Three lines exactly. Any range with end > 3 is out of bounds.
    const f = await writeRelFile("small.md", "line one\nline two\nline three");
    const client = new ProgrammableClient(
      `Brief answer.\n\nSources:\n${f}:1-99\n`,
    );
    const env = await handleResearch(
      { question: "q", source_paths: [f] },
      makeCtx(client),
    );
    // Path-only citation survives.
    expect(env.result.citations).toHaveLength(1);
    expect(env.result.citations[0].path).toBe(f);
    expect(env.result.citations[0].line_range).toBeUndefined();
    // Warning describes the bounds drop.
    const w = env.warnings?.find((x) => x.includes("past EOF"));
    expect(w).toBeDefined();
    expect(w).toContain("file has 3 lines");
  });

  it("in-bounds range is preserved unchanged", async () => {
    const f = await writeRelFile("small.md", "1\n2\n3\n4\n5\n");
    const client = new ProgrammableClient(
      `Answer.\n\nSources:\n${f}:2-4\n`,
    );
    const env = await handleResearch(
      { question: "q", source_paths: [f] },
      makeCtx(client),
    );
    expect(env.result.citations[0].line_range).toBe("2-4");
    expect(env.warnings?.some((w) => w.includes("past EOF"))).toBeFalsy();
  });
});
