/**
 * v2.4.0 per-tier num_ctx threading — covers the 8 atom tools, composite
 * brief synthesis, the runner/batch helpers, and the regression smoke
 * test from the spec.
 *
 * Invariants every test enforces:
 *   1. When the active profile sets num_ctx for the calling tier, the
 *      MCP server places `options.num_ctx = <value>` on the Ollama
 *      generate request AND surfaces `num_ctx_used: <value>` on the
 *      response envelope.
 *   2. When the active profile leaves num_ctx UNSET for the calling
 *      tier, the request's options block has NO `num_ctx` key (Ollama
 *      uses the model-loaded default) AND the envelope has NO
 *      `num_ctx_used` key. This is the v2.3.0 backward-compat guarantee.
 *
 * Coverage matrix (each atom tool gets a "set + present" and an
 * "unset + absent" pair):
 *   - extract       (workhorse) — both single and batch (items[]) modes
 *   - classify      (instant)
 *   - summarize_fast (instant)
 *   - summarize_deep (deep)
 *   - research      (deep)
 *   - corpus_answer (deep, synthesis path)
 *   - chat          (workhorse, non-runner path)
 *   - code_citation (deep)
 *
 * Plus:
 *   - composite (change_brief) — confirms profile num_ctx flows through
 *     the deep-tier brief synthesis path same as atom tools.
 *   - regression smoke (extract on dev-rtx5080) — explicit "diagnostic
 *     finding → release fixes it" check that ollama_extract carries
 *     `num_ctx: 8192` end-to-end on the workhorse tier.
 *
 * Mock posture is identical to the v2.3.0 model-override tests: each
 * MockClient records `lastGenerate` / `lastChat` so assertions can read
 * the exact request body sent to Ollama. No live network.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleExtract } from "../src/tools/extract.js";
import { handleClassify } from "../src/tools/classify.js";
import { handleSummarizeFast } from "../src/tools/summarizeFast.js";
import { handleSummarizeDeep } from "../src/tools/summarizeDeep.js";
import { handleResearch } from "../src/tools/research.js";
import { handleChat } from "../src/tools/chat.js";
import { handleCodeCitation } from "../src/tools/codeCitation.js";
import { handleChangeBrief } from "../src/tools/changeBrief.js";
import { PROFILES } from "../src/profiles.js";
import { NullLogger } from "../src/observability.js";
import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "../src/ollama.js";
import type { Envelope, Residency } from "../src/envelope.js";
import type { RunContext } from "../src/runContext.js";

// ── Shared test doubles ─────────────────────────────────────

class MockClient implements OllamaClient {
  public lastGenerate?: GenerateRequest;
  public allGenerate: GenerateRequest[] = [];
  public lastChat?: ChatRequest;
  constructor(private raw: string = "ok") {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.lastGenerate = req;
    this.allGenerate.push(req);
    return {
      model: req.model,
      response: this.raw,
      done: true,
      prompt_eval_count: 5,
      eval_count: 3,
    };
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.lastChat = req;
    return {
      model: req.model,
      message: { role: "assistant", content: this.raw },
      done: true,
      prompt_eval_count: 5,
      eval_count: 3,
    };
  }
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    throw new Error("embed not used in num_ctx tests");
  }
  async residency(_model: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtxFor(profile: keyof typeof PROFILES, client: OllamaClient): RunContext {
  return {
    client,
    tiers: PROFILES[profile].tiers,
    timeouts: PROFILES[profile].timeouts,
    hardwareProfile: profile,
    logger: new NullLogger(),
  };
}

/**
 * Helper — assert the request body sent to Ollama carries the expected
 * num_ctx value. Pulls the options block; null-safe on shape.
 */
function expectRequestNumCtx(req: GenerateRequest | ChatRequest | undefined, expected: number): void {
  expect(req).toBeDefined();
  expect(req!.options).toBeDefined();
  expect(req!.options).toHaveProperty("num_ctx", expected);
}

/**
 * Helper — assert the request body sent to Ollama OMITS num_ctx entirely,
 * so Ollama falls back to its model-loaded default. The options block
 * may exist (for temperature/num_predict) but must not include num_ctx
 * as a key. This is the v2.3.0 back-compat guarantee.
 */
function expectRequestNoNumCtx(req: GenerateRequest | ChatRequest | undefined): void {
  expect(req).toBeDefined();
  // options may be undefined or present without num_ctx key.
  if (req!.options !== undefined) {
    expect(req!.options).not.toHaveProperty("num_ctx");
  }
}

// ═══════════════════════════════════════════════════════════════
// Atom tool coverage — 8 tools × {set, unset}
// ═══════════════════════════════════════════════════════════════

const SIMPLE_SCHEMA = { type: "object", properties: { name: { type: "string" } } };

describe("v2.4.0 num_ctx — ollama_extract (workhorse)", () => {
  it("dev-rtx5080: profile workhorse=8192 → request.options.num_ctx=8192 + envelope.num_ctx_used=8192", async () => {
    const client = new MockClient(JSON.stringify({ name: "x" }));
    const env = await handleExtract(
      { text: "anything", schema: SIMPLE_SCHEMA },
      makeCtxFor("dev-rtx5080", client),
    );
    expectRequestNumCtx(client.lastGenerate, 8192);
    expect(env.num_ctx_used).toBe(8192);
  });

  it("m5-max: profile workhorse unset → request omits num_ctx + envelope omits num_ctx_used", async () => {
    const client = new MockClient(JSON.stringify({ name: "x" }));
    const env = await handleExtract(
      { text: "anything", schema: SIMPLE_SCHEMA },
      makeCtxFor("m5-max", client),
    );
    expectRequestNoNumCtx(client.lastGenerate);
    expect(env.num_ctx_used).toBeUndefined();
  });

  it("dev-rtx5080 batch mode: every per-item request carries workhorse num_ctx + batch envelope surfaces it", async () => {
    // Batch path is its own threading point — verify items go out
    // carrying the same workhorse num_ctx and the batch envelope
    // reports it once.
    const client = new MockClient(JSON.stringify({ name: "x" }));
    const env = await handleExtract(
      {
        items: [{ id: "a", text: "one" }, { id: "b", text: "two" }],
        schema: SIMPLE_SCHEMA,
      },
      makeCtxFor("dev-rtx5080", client),
    );
    expect(client.allGenerate.length).toBe(2);
    for (const req of client.allGenerate) {
      expect(req.options).toHaveProperty("num_ctx", 8192);
    }
    expect(env.num_ctx_used).toBe(8192);
  });

  it("m5-max batch mode: per-item requests omit num_ctx + envelope omits num_ctx_used", async () => {
    const client = new MockClient(JSON.stringify({ name: "x" }));
    const env = await handleExtract(
      {
        items: [{ id: "a", text: "one" }, { id: "b", text: "two" }],
        schema: SIMPLE_SCHEMA,
      },
      makeCtxFor("m5-max", client),
    );
    expect(client.allGenerate.length).toBe(2);
    for (const req of client.allGenerate) {
      if (req.options !== undefined) {
        expect(req.options).not.toHaveProperty("num_ctx");
      }
    }
    expect(env.num_ctx_used).toBeUndefined();
  });
});

describe("v2.4.0 num_ctx — ollama_classify (instant)", () => {
  it("dev-rtx5080: profile instant=4096 → request.options.num_ctx=4096 + envelope.num_ctx_used=4096", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
    const env = await handleClassify(
      { text: "patch something", labels: ["feat", "fix"] },
      makeCtxFor("dev-rtx5080", client),
    );
    expectRequestNumCtx(client.lastGenerate, 4096);
    expect((env as Envelope<unknown>).num_ctx_used).toBe(4096);
  });

  it("m5-max: profile instant unset → request omits num_ctx + envelope omits num_ctx_used", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
    const env = await handleClassify(
      { text: "patch something", labels: ["feat", "fix"] },
      makeCtxFor("m5-max", client),
    );
    expectRequestNoNumCtx(client.lastGenerate);
    expect((env as Envelope<unknown>).num_ctx_used).toBeUndefined();
  });
});

describe("v2.4.0 num_ctx — ollama_summarize_fast (instant)", () => {
  it("dev-rtx5080: instant tier picks up 4096", async () => {
    const client = new MockClient("a short summary");
    const env = await handleSummarizeFast(
      { text: "a paragraph to summarize" },
      makeCtxFor("dev-rtx5080", client),
    );
    expectRequestNumCtx(client.lastGenerate, 4096);
    expect(env.num_ctx_used).toBe(4096);
  });

  it("m5-max: instant unset → request omits num_ctx, envelope omits num_ctx_used", async () => {
    const client = new MockClient("a short summary");
    const env = await handleSummarizeFast(
      { text: "a paragraph to summarize" },
      makeCtxFor("m5-max", client),
    );
    expectRequestNoNumCtx(client.lastGenerate);
    expect(env.num_ctx_used).toBeUndefined();
  });
});

describe("v2.4.0 num_ctx — ollama_summarize_deep (deep)", () => {
  // dev-rtx5080 deliberately leaves deep UNSET (long-context briefs).
  // Both profiles should therefore omit num_ctx for this tool. The
  // m5-max test is the "all-tier-unset" variant; the dev-rtx5080 test
  // proves we don't accidentally inherit workhorse=8192 onto deep.

  it("dev-rtx5080: deep UNSET → request omits num_ctx (long-context preserved)", async () => {
    const client = new MockClient("a digest");
    const env = await handleSummarizeDeep(
      { text: "long content to digest" },
      makeCtxFor("dev-rtx5080", client),
    );
    expectRequestNoNumCtx(client.lastGenerate);
    expect(env.num_ctx_used).toBeUndefined();
  });

  it("m5-max: deep UNSET → request omits num_ctx, envelope omits num_ctx_used", async () => {
    const client = new MockClient("a digest");
    const env = await handleSummarizeDeep(
      { text: "long content to digest" },
      makeCtxFor("m5-max", client),
    );
    expectRequestNoNumCtx(client.lastGenerate);
    expect(env.num_ctx_used).toBeUndefined();
  });

  it("simulated profile with deep=16384 → request carries num_ctx and envelope reports it", async () => {
    // Direct injection — no shipped profile sets deep, so this verifies
    // the threading would work if a future profile decides to.
    const client = new MockClient("a digest");
    const ctx: RunContext = {
      client,
      tiers: { ...PROFILES["dev-rtx5080"].tiers, num_ctx: { deep: 16384 } },
      timeouts: PROFILES["dev-rtx5080"].timeouts,
      hardwareProfile: "dev-rtx5080",
      logger: new NullLogger(),
    };
    const env = await handleSummarizeDeep({ text: "long content to digest" }, ctx);
    expectRequestNumCtx(client.lastGenerate, 16384);
    expect(env.num_ctx_used).toBe(16384);
  });
});

describe("v2.4.0 num_ctx — ollama_research (deep)", () => {
  it("dev-rtx5080: deep UNSET → request omits num_ctx", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-numctx-research-"));
    const path = join(dir, "source.md");
    await writeFile(path, "## Topic\n\nSome content.", "utf8");
    try {
      const client = new MockClient("Short answer.\nSources:\n" + path);
      const env = await handleResearch(
        { question: "what is the topic?", source_paths: [path] },
        makeCtxFor("dev-rtx5080", client),
      );
      expectRequestNoNumCtx(client.lastGenerate);
      expect(env.num_ctx_used).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("m5-max: deep UNSET → request omits num_ctx + envelope omits num_ctx_used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-numctx-research-m5-"));
    const path = join(dir, "source.md");
    await writeFile(path, "## Topic\n\nSome content.", "utf8");
    try {
      const client = new MockClient("Short answer.\nSources:\n" + path);
      const env = await handleResearch(
        { question: "what is the topic?", source_paths: [path] },
        makeCtxFor("m5-max", client),
      );
      expectRequestNoNumCtx(client.lastGenerate);
      expect(env.num_ctx_used).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("v2.4.0 num_ctx — ollama_corpus_answer (deep synthesis)", () => {
  // corpus_answer synthesis is on the deep tier; same UNSET shape as the
  // other deep tools.
  it("dev-rtx5080: synthesis path emits no num_ctx on the request", async () => {
    const { handleCorpusAnswer } = await import("../src/tools/corpusAnswer.js");
    const { saveCorpus, CORPUS_SCHEMA_VERSION } = await import("../src/corpus/storage.js");
    const tempDir = await mkdtemp(join(tmpdir(), "intern-numctx-corpus-"));
    const orig = process.env.INTERN_CORPUS_DIR;
    process.env.INTERN_CORPUS_DIR = tempDir;
    try {
      await saveCorpus({
        schema_version: CORPUS_SCHEMA_VERSION,
        name: "smoke",
        model_version: PROFILES["dev-rtx5080"].tiers.embed,
        model_digest: null,
        indexed_at: "2026-05-12T00:00:00.000Z",
        chunk_chars: 800,
        chunk_overlap: 100,
        stats: { documents: 1, chunks: 1, total_chars: 50 },
        titles: { "/a.md": "A" },
        chunks: [
          {
            id: "c-0",
            path: "/a.md",
            file_hash: "sha256:test",
            file_mtime: "2026-05-12T00:00:00.000Z",
            chunk_index: 0,
            char_start: 0,
            char_end: 50,
            text: "topic content matches search keywords",
            vector: [1, 0, 0, 0],
            heading_path: [],
            chunk_type: "paragraph",
          },
        ],
      });
      const client = new MockClient(
        JSON.stringify({ answer: "synth answer", citations: [1] }),
      );
      const env = await handleCorpusAnswer(
        { corpus: "smoke", question: "matches keywords", mode: "lexical" },
        makeCtxFor("dev-rtx5080", client),
      );
      // Synthesis request was made — verify it does NOT carry num_ctx
      // (dev-rtx5080 leaves deep unset).
      expectRequestNoNumCtx(client.lastGenerate);
      expect(env.num_ctx_used).toBeUndefined();
    } finally {
      if (orig === undefined) delete process.env.INTERN_CORPUS_DIR;
      else process.env.INTERN_CORPUS_DIR = orig;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("v2.4.0 num_ctx — ollama_chat (workhorse, non-runner path)", () => {
  it("dev-rtx5080: chat carries workhorse=8192 on the chat request + envelope", async () => {
    const client = new MockClient("ok");
    const env = await handleChat(
      { messages: [{ role: "user", content: "hi" }] },
      makeCtxFor("dev-rtx5080", client),
    );
    // chat uses ctx.client.chat, not generate. Same options-block contract.
    expect(client.lastChat).toBeDefined();
    expect(client.lastChat!.options).toHaveProperty("num_ctx", 8192);
    expect(env.num_ctx_used).toBe(8192);
  });

  it("m5-max: workhorse UNSET → chat request omits num_ctx + envelope omits num_ctx_used", async () => {
    const client = new MockClient("ok");
    const env = await handleChat(
      { messages: [{ role: "user", content: "hi" }] },
      makeCtxFor("m5-max", client),
    );
    expect(client.lastChat).toBeDefined();
    if (client.lastChat!.options !== undefined) {
      expect(client.lastChat!.options).not.toHaveProperty("num_ctx");
    }
    expect(env.num_ctx_used).toBeUndefined();
  });
});

describe("v2.4.0 num_ctx — ollama_code_citation (deep)", () => {
  it("dev-rtx5080: deep UNSET → request omits num_ctx", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-numctx-code-"));
    const path = join(dir, "src.ts");
    await writeFile(path, "export const x = 1;\nexport const y = 2;\n", "utf8");
    try {
      const client = new MockClient(
        JSON.stringify({
          answer: "the file declares two constants",
          citations: [
            { claim_fragment: "two constants", file: path, start_line: 1, end_line: 2 },
          ],
          uncited_fragments: [],
        }),
      );
      const env = await handleCodeCitation(
        { question: "what does this declare?", source_paths: [path] },
        makeCtxFor("dev-rtx5080", client),
      );
      expectRequestNoNumCtx(client.lastGenerate);
      expect(env.num_ctx_used).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Composite tool coverage — change_brief is the representative.
// Same threading shape (delegates to runTool with tier=deep) so the
// "set + present" and "absent" semantics inherit from the runner.
// ═══════════════════════════════════════════════════════════════

describe("v2.4.0 num_ctx — ollama_change_brief (composite, deep)", () => {
  const BRIEF_OUTPUT = JSON.stringify({
    change_summary: "small fix",
    affected_surfaces: [{ surface: "auth", evidence_refs: [] }],
    why_it_matters: "prevents crash",
    likely_breakpoints: [],
    validation_checks: [],
    release_note_draft: "patches a crash",
  });

  it("dev-rtx5080: change_brief is on the deep tier → request omits num_ctx (deep is unset)", async () => {
    // Composite that flows through runTool — proves runner threading
    // propagates to composites without per-handler wiring.
    const client = new MockClient(BRIEF_OUTPUT);
    const env = await handleChangeBrief(
      { diff_text: "diff --git a/x b/x\n+ const x = 1;\n" },
      makeCtxFor("dev-rtx5080", client),
    );
    expectRequestNoNumCtx(client.lastGenerate);
    expect(env.num_ctx_used).toBeUndefined();
  });

  it("composite picks up an injected deep num_ctx (proves threading is the same)", async () => {
    const client = new MockClient(BRIEF_OUTPUT);
    const ctx: RunContext = {
      client,
      tiers: { ...PROFILES["dev-rtx5080"].tiers, num_ctx: { deep: 16384 } },
      timeouts: PROFILES["dev-rtx5080"].timeouts,
      hardwareProfile: "dev-rtx5080",
      logger: new NullLogger(),
    };
    const env = await handleChangeBrief(
      { diff_text: "diff --git a/x b/x\n+ const x = 1;\n" },
      ctx,
    );
    expectRequestNumCtx(client.lastGenerate, 16384);
    expect(env.num_ctx_used).toBe(16384);
  });
});

// ═══════════════════════════════════════════════════════════════
// Diagnostic regression — the headline "v2.4.0 fixes this" smoke
// test. dev-rtx5080 + extract on workhorse MUST carry num_ctx=8192
// end-to-end. This is the dogfood finding that drove the release.
// ═══════════════════════════════════════════════════════════════

describe("v2.4.0 num_ctx — diagnostic regression smoke (workhorse hermes3:8b → 8192)", () => {
  it("ollama_extract on dev-rtx5080 sends workhorse num_ctx=8192 end-to-end", async () => {
    // The Phase 1 diagnostic that motivated v2.4.0: hermes3:8b at 32K
    // context on RTX 5080 16GB VRAM spilled to CPU and killed workhorse
    // extract latency. The fix is profile-level: dev-rtx5080 now ships
    // workhorse=8192 so the model stays resident. This test pins that
    // contract: the value reaches the Ollama wire AND the envelope.
    const client = new MockClient(JSON.stringify({ field: "value" }));
    const env = await handleExtract(
      {
        text: "extract a field from this text",
        schema: { type: "object", properties: { field: { type: "string" } } },
      },
      makeCtxFor("dev-rtx5080", client),
    );
    expect(client.lastGenerate?.model).toBe("hermes3:8b");
    expect(client.lastGenerate?.options?.num_ctx).toBe(8192);
    expect(env.num_ctx_used).toBe(8192);
    // And confirms the original v2.3.0 invariants still hold —
    // num_ctx threading didn't break model resolution.
    expect(env.model).toBe("hermes3:8b");
    expect(env.tier_used).toBe("workhorse");
    expect(env.hardware_profile).toBe("dev-rtx5080");
  });
});
