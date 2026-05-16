/**
 * Regression tests — one test per closed bug or hard-earned invariant.
 *
 * Every test here names the commit or dogfood pass that surfaced the issue.
 * Failure of any test means a known-bad behavior has returned. Do not silence
 * these by relaxing assertions; fix the regression in the handler instead.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROFILES } from "../src/profiles.js";
import { NullLogger } from "../src/observability.js";
import { compileCheck } from "../src/guardrails/compileCheck.js";
import { handleDraft } from "../src/tools/draft.js";
import { handleResearch } from "../src/tools/research.js";
import { handleEmbedSearch } from "../src/tools/embedSearch.js";
import { handleSummarizeDeep } from "../src/tools/summarizeDeep.js";
import { handleSummarizeFast } from "../src/tools/summarizeFast.js";
import { handleClassify } from "../src/tools/classify.js";
import { handleExtract } from "../src/tools/extract.js";
import { normalizeOllamaHost } from "../src/ollama.js";
import { buildEnvelope } from "../src/envelope.js";
import { InternError } from "../src/errors.js";

import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "../src/ollama.js";
import type { Residency } from "../src/envelope.js";
import type { RunContext } from "../src/runContext.js";

// ── Shared test doubles ─────────────────────────────────────

class Mock implements OllamaClient {
  public lastGenerate?: GenerateRequest;
  public lastEmbed?: EmbedRequest;
  constructor(
    private genResp: string | ((req: GenerateRequest) => string) = "ok",
    private embedTable: Record<string, number[]> = {},
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.lastGenerate = req;
    const response = typeof this.genResp === "function" ? this.genResp(req) : this.genResp;
    return { model: req.model, response, done: true, prompt_eval_count: 10, eval_count: 5 };
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.lastEmbed = req;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      embeddings: inputs.map((t) => this.embedTable[t] ?? [0, 0]),
    };
  }
  async residency(_m: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient): RunContext & { logger: NullLogger } {
  const logger = new NullLogger();
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger,
  };
}

// ═══════════════════════════════════════════════════════════════
// Regression: Windows MCP registration (commit 259a949)
// Bug: `isMain` string-compared import.meta.url against process.argv[1]
// on Windows where slash direction differed, so main() never ran.
// Guard: OLLAMA_HOST normalization is the sibling fix — if these break,
// MCP server fails to connect.
// ═══════════════════════════════════════════════════════════════

describe("regression: Windows MCP registration (commit 259a949)", () => {
  it("normalizeOllamaHost adds http:// to scheme-less host:port", () => {
    expect(normalizeOllamaHost("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  });
  it("normalizeOllamaHost preserves http:// and https:// schemes", () => {
    expect(normalizeOllamaHost("http://foo:1234")).toBe("http://foo:1234");
    expect(normalizeOllamaHost("https://foo:1234")).toBe("https://foo:1234");
  });
  it("normalizeOllamaHost strips trailing slashes (prevents double-slash paths)", () => {
    expect(normalizeOllamaHost("127.0.0.1:11434/")).toBe("http://127.0.0.1:11434");
  });
  it("normalizeOllamaHost falls back to default when empty/undefined", () => {
    expect(normalizeOllamaHost(undefined)).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaHost("")).toBe("http://127.0.0.1:11434");
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: Profile-aware Instant timeouts (commit fed244c)
// Bug: global TIER_TIMEOUT_MS.instant = 5s was sized for M5-Max. On
// RTX 5080, cold load on 7B exceeds 5s, every Instant call timed out.
// Fix: Profile.timeouts first-class, dev=15s, m5-max=5s.
// ═══════════════════════════════════════════════════════════════

describe("regression: Profile-aware Instant timeouts (commit fed244c)", () => {
  it("dev-rtx5080 Instant timeout is 15s (margin for cold load on 16GB VRAM)", () => {
    expect(PROFILES["dev-rtx5080"].timeouts.instant).toBe(15_000);
  });
  it("dev-rtx5080-qwen3 inherits the dev timeouts", () => {
    // Renamed from dev-rtx5080-llama at v2.0.0 — same hardware timeout floor applies.
    expect(PROFILES["dev-rtx5080-qwen3"].timeouts.instant).toBe(15_000);
  });
  it("m5-max Instant stays at 5s (unified memory has no cold-load penalty)", () => {
    expect(PROFILES["m5-max"].timeouts.instant).toBe(5_000);
  });
  it("Workhorse / Deep / Embed timeouts match across all profiles (hardware-invariant)", () => {
    const ref = PROFILES["m5-max"].timeouts;
    for (const p of Object.values(PROFILES)) {
      expect(p.timeouts.workhorse).toBe(ref.workhorse);
      expect(p.timeouts.deep).toBe(ref.deep);
      expect(p.timeouts.embed).toBe(ref.embed);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: compileCheck merges stdout + stderr (commit fed244c)
// Bug: tsc writes diagnostics to STDOUT; we only captured stderr, so
// compiles:false returned with empty stderr_tail — useless to reviewers.
// Fix: diagnostics = [stderr, stdout].filter(Boolean).join("\n")
// ═══════════════════════════════════════════════════════════════

describe("regression: compileCheck captures stdout diagnostics (commit fed244c)", () => {
  it("returns skipped for unsupported language (no checker crash)", async () => {
    const r = await compileCheck("print('hi')", "cobol");
    expect(r.skipped).toBe(true);
    expect(r.compiles).toBe(false);
  });
  it("returns skipped when no language is provided", async () => {
    const r = await compileCheck("anything", undefined);
    expect(r.skipped).toBe(true);
  });
  // Note: an end-to-end "tsc produces stderr_tail content" check requires npx
  // typescript which can take >15s on a cold cache. Not run in unit tests to
  // keep vitest fast. The live smoke in smoke/targeted.mjs proves it.
});

// ═══════════════════════════════════════════════════════════════
// Regression: embed_search strips raw vectors (commit 4ab1776)
// Bug: ollama_embed returned raw 768-dim vectors, blowing Claude's
// tool-output limit (115KB / 5406 lines for 7 candidates).
// Fix: new ollama_embed_search tool returns ranked {id, score, preview?}
// — vectors never cross the boundary.
// ═══════════════════════════════════════════════════════════════

describe("regression: embed_search never leaks raw vectors (commit 4ab1776)", () => {
  it("result shape has ranked/model_version/candidates_embedded — NOT embeddings", async () => {
    const client = new Mock("", {
      q: [1, 0],
      a: [1, 0],
      b: [0, 1],
    });
    const env = await handleEmbedSearch(
      { query: "q", candidates: [{ id: "c1", text: "a" }, { id: "c2", text: "b" }] },
      makeCtx(client),
    );
    expect(Object.keys(env.result).sort()).toEqual(["candidates_embedded", "model_version", "ranked"]);
    // Every ranked hit must be tiny — id/score/optional preview only.
    // Per-key not-toContain (the BOTH-absent invariant). The previous
    // expect.not.arrayContaining([...]) form is asymmetric — it passes
    // when *either* key is absent, so a regression that leaks one of
    // the two slipped through silently.
    for (const hit of env.result.ranked) {
      expect(Object.keys(hit)).not.toContain("embedding");
      expect(Object.keys(hit)).not.toContain("vector");
    }
  });

  it("under a realistic payload (20 candidates), response stays under 10KB", async () => {
    const table: Record<string, number[]> = { q: [1, 0] };
    const candidates = Array.from({ length: 20 }, (_, i) => {
      const text = `candidate-${i} lorem ipsum dolor sit amet consectetur adipiscing elit`;
      table[text] = [Math.random(), Math.random()];
      return { id: `c${i}`, text };
    });
    const client = new Mock("", table);
    const env = await handleEmbedSearch(
      { query: "q", candidates, preview_chars: 60 },
      makeCtx(client),
    );
    const size = JSON.stringify(env.result).length;
    expect(size).toBeLessThan(10_000); // ~550B observed in live smoke for 10-candidate case
    expect(env.result.ranked).toHaveLength(20);
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: Protected-path blocking + confirm_write override
// (Initial scaffold, reinforced by dogfood pass)
// ═══════════════════════════════════════════════════════════════

describe("regression: Protected-path gate (scaffold + dogfood)", () => {
  it("draft targeting memory/ without confirm_write throws PROTECTED_PATH_WRITE", async () => {
    const client = new Mock("const x = 1;");
    await expect(
      handleDraft(
        { prompt: "anything", target_path: "memory/bad.md" },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "PROTECTED_PATH_WRITE" });
  });

  it("draft targeting memory/ WITH confirm_write=true succeeds", async () => {
    const client = new Mock("anything");
    const env = await handleDraft(
      { prompt: "anything", target_path: "memory/ok.md", confirm_write: true },
      makeCtx(client),
    );
    expect(env.result.is_draft).toBe(true);
  });

  it("draft targeting non-protected src/ succeeds without confirm_write", async () => {
    const client = new Mock("anything");
    const env = await handleDraft(
      { prompt: "anything", target_path: "src/util.ts" },
      makeCtx(client),
    );
    expect(env.result.is_draft).toBe(true);
  });

  it("guardrail event fires with rule=writeConfirm when blocking", async () => {
    const client = new Mock("ignored");
    const ctx = makeCtx(client);
    await expect(
      handleDraft({ prompt: "x", target_path: ".claude/rules.md" }, ctx),
    ).rejects.toMatchObject({ code: "PROTECTED_PATH_WRITE" });
    const gevents = ctx.logger.events.filter((e) => e.kind === "guardrail");
    expect(gevents).toHaveLength(1);
    const g = gevents[0] as Extract<typeof gevents[number], { kind: "guardrail" }>;
    expect(g.rule).toBe("writeConfirm");
    expect(g.action).toBe("blocked");
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: source_paths validation (commit 5b6f657, reinforced 4ab1776)
// ═══════════════════════════════════════════════════════════════

describe("regression: source_paths validation (research + summarize_deep)", () => {
  it("research rejects nonexistent path with SOURCE_PATH_NOT_FOUND", async () => {
    const client = new Mock();
    await expect(
      handleResearch(
        { question: "anything", source_paths: ["F:/utterly/absent/file.md"] },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });

  it("summarize_deep rejects nonexistent path with SOURCE_PATH_NOT_FOUND", async () => {
    const client = new Mock();
    await expect(
      handleSummarizeDeep(
        { source_paths: ["F:/utterly/absent/file.md"] },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });

  it("summarize_deep rejects both text AND source_paths", async () => {
    const client = new Mock();
    await expect(
      handleSummarizeDeep({ text: "x", source_paths: ["y.md"] }, makeCtx(client)),
    ).rejects.toThrow(/exactly one/i);
  });

  it("summarize_deep rejects neither text NOR source_paths", async () => {
    const client = new Mock();
    await expect(
      handleSummarizeDeep({} as { text?: string }, makeCtx(client)),
    ).rejects.toThrow(/exactly one/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: Citation stripping for unknown paths (scaffold)
// Bug class: Model invents a file path; we must strip, not trust.
// Handled at the research handler layer via validateCitations().
// ═══════════════════════════════════════════════════════════════

describe("regression: Citation stripping for unknown paths", () => {
  it("stripped citations appear in envelope.warnings, not in result.citations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-cite-"));
    const real = join(dir, "real.md");
    await writeFile(real, "real content", "utf8");
    try {
      // Model fabricates a path in the Sources block.
      const client = new Mock(
        "Short answer based on real.\nSources:\nreal.md\nfake/invented.md:10-20\n",
      );
      const env = await handleResearch(
        { question: "q", source_paths: [real] },
        makeCtx(client),
      );
      // Only real paths come back; invented path stripped server-side.
      const citedPaths = env.result.citations.map((c) => c.path);
      expect(citedPaths.some((p) => p.includes("invented"))).toBe(false);
      // And the warnings array notes the stripping.
      expect(env.warnings?.some((w) => w.includes("Stripped"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: Envelope shape invariants
// ═══════════════════════════════════════════════════════════════

describe("regression: Envelope shape invariants", () => {
  it("every envelope carries hardware_profile (benchmarks need it to filter dev numbers)", () => {
    const env = buildEnvelope({
      result: null, tier: "instant", model: "x", hardwareProfile: "dev-rtx5080",
      tokensIn: 0, tokensOut: 0, startedAt: Date.now(), residency: null,
    });
    expect(env.hardware_profile).toBe("dev-rtx5080");
  });

  it("classify envelope goes through full result shape (label/confidence/below_threshold/threshold)", async () => {
    const client = new Mock('{"label":"fix","confidence":0.9}');
    const env = await handleClassify(
      { text: "patch something", labels: ["feat", "fix"] },
      makeCtx(client),
    );
    expect(env.result).toHaveProperty("label");
    expect(env.result).toHaveProperty("confidence");
    expect(env.result).toHaveProperty("below_threshold");
    expect(env.result).toHaveProperty("threshold");
    expect(env.hardware_profile).toBe("dev-rtx5080");
  });
});

// ═══════════════════════════════════════════════════════════════
// Regression: InternError structured shape
// (shipcheck hard gate B: no raw stacks)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Seed regression — fresh-pack cosmology / evidence-custody
//
// Closed by the frame-contract slice (Agent A, swarm 2026-05-11).
// Original failure: research-os section 01 (evidence-custody frame)
// extracted 15 cosmology claims from arxiv 2112.10422 with no signal
// the source was off-topic. The four extract/classify/summarize tools
// now accept a `frame` input and surface frame_alignment / off_topic /
// frame_addressed / on_topic respectively. These tests are CONTRACT
// tests — the LLM is mocked, the assertion is on schema-and-prompt
// wiring, not on actual model behavior.
// ═══════════════════════════════════════════════════════════════

const FRESH_PACK_FRAME = `What does evidence custody mean in local-first vs cloud LLM deep-research workflows, and which produces a more inspectable evidence chain?`;

const FRESH_PACK_COSMOLOGY_TEXT = `[2112.10422] Cosmological Standard Timers from Unstable Primordial Relics

Astrophysics > Cosmology and Nongalactic Astrophysics

Abstract: In this article, we propose a hypothetical possibility of using unstable primordial relics as standard timers to track the evolution of our Universe. We discuss observing time-varying properties of these relics at different redshifts to establish a redshift-time relation of cosmic history. We consider primordial black hole bubbles as an example and analyze their mass function through the inverse problem of Hawking radiation.

Subjects: Cosmology and Nongalactic Astrophysics (astro-ph.CO); General Relativity and Quantum Cosmology (gr-qc)`;

const SIMPLE_SCHEMA = {
  type: "object",
  properties: { claim: { type: "string" }, count: { type: "number" } },
};

describe("seed regression — fresh-pack cosmology / evidence-custody (frame contract)", () => {
  // ── extract ──────────────────────────────────────────────

  it("extract surfaces frame_alignment.on_topic=false on off-topic source", async () => {
    const modelOut = JSON.stringify({
      _frame_alignment: {
        on_topic: false,
        reason: "source is about cosmology; frame asks about evidence custody in research workflows",
      },
    });
    const client = new Mock(modelOut);
    const env = await handleExtract(
      { text: FRESH_PACK_COSMOLOGY_TEXT, schema: SIMPLE_SCHEMA, frame: FRESH_PACK_FRAME },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect(env.result.frame_alignment?.on_topic).toBe(false);
    expect(env.result.frame_alignment?.reason).toMatch(/cosmology|evidence custody/i);
    // Frame must have been threaded into the prompt.
    expect(client.lastGenerate?.prompt ?? "").toContain("Frame:");
  });

  it("extract back-compat: same call without `frame` returns legacy shape (no frame_alignment)", async () => {
    const client = new Mock(JSON.stringify({ claim: "anything", count: 0 }));
    const env = await handleExtract(
      { text: FRESH_PACK_COSMOLOGY_TEXT, schema: SIMPLE_SCHEMA },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect((env.result as { frame_alignment?: unknown }).frame_alignment).toBeUndefined();
    expect(client.lastGenerate?.prompt ?? "").not.toContain("Frame:");
  });

  // ── classify ─────────────────────────────────────────────

  it("classify surfaces off_topic=true on off-topic source", async () => {
    const client = new Mock(
      JSON.stringify({
        label: "evidence-chain",
        confidence: 0.85,
        off_topic: true,
        off_topic_reason: "source is a cosmology preprint, not an evidence-custody discussion",
      }),
    );
    const env = await handleClassify(
      {
        text: FRESH_PACK_COSMOLOGY_TEXT,
        labels: ["evidence-chain", "audit-trail", "inspectability"],
        frame: FRESH_PACK_FRAME,
      },
      makeCtx(client),
    );
    expect(env.result.off_topic).toBe(true);
    expect(env.result.label).toBeNull();
    expect(env.result.off_topic_reason).toMatch(/cosmology|evidence/i);
  });

  it("classify back-compat: no frame → no off_topic field", async () => {
    const client = new Mock(JSON.stringify({ label: "evidence-chain", confidence: 0.85 }));
    const env = await handleClassify(
      {
        text: FRESH_PACK_COSMOLOGY_TEXT,
        labels: ["evidence-chain", "audit-trail", "inspectability"],
      },
      makeCtx(client),
    );
    expect((env.result as { off_topic?: boolean }).off_topic).toBeUndefined();
  });

  // ── summarize_fast ───────────────────────────────────────

  it("summarize_fast surfaces on_topic=false on off-topic source", async () => {
    const client = new Mock(
      JSON.stringify({
        on_topic: false,
        summary: "(off-topic for frame: cosmology preprint, not about evidence custody)",
      }),
    );
    const env = await handleSummarizeFast(
      { text: FRESH_PACK_COSMOLOGY_TEXT, frame: FRESH_PACK_FRAME },
      makeCtx(client),
    );
    expect(env.result.on_topic).toBe(false);
    expect(env.result.summary).toContain("off-topic");
  });

  it("summarize_fast back-compat: no frame → no on_topic field", async () => {
    const client = new Mock("a short factual digest");
    const env = await handleSummarizeFast(
      { text: FRESH_PACK_COSMOLOGY_TEXT },
      makeCtx(client),
    );
    expect((env.result as { on_topic?: boolean | null }).on_topic).toBeUndefined();
    expect(env.result.summary).toBe("a short factual digest");
  });

  // ── summarize_deep ───────────────────────────────────────

  it("summarize_deep surfaces frame_addressed=false + unaddressed_sources on off-topic source", async () => {
    const modelOut = JSON.stringify({
      frame_addressed: false,
      summary: "",
      unaddressed_sources: ["2112.10422: a cosmology preprint about primordial relics as standard timers"],
    });
    const client = new Mock(modelOut);
    const env = await handleSummarizeDeep(
      { text: FRESH_PACK_COSMOLOGY_TEXT, frame: FRESH_PACK_FRAME },
      makeCtx(client),
    );
    expect(env.result.frame_addressed).toBe(false);
    expect(env.result.summary).toBe("");
    expect(env.result.unaddressed_sources?.[0]).toMatch(/cosmology|primordial/i);
  });

  it("summarize_deep back-compat: no frame → no frame_addressed / unaddressed_sources fields", async () => {
    const client = new Mock("a faithful digest of cosmology preprint content");
    const env = await handleSummarizeDeep(
      { text: FRESH_PACK_COSMOLOGY_TEXT },
      makeCtx(client),
    );
    expect((env.result as { frame_addressed?: boolean | null }).frame_addressed).toBeUndefined();
    expect((env.result as { unaddressed_sources?: string[] }).unaddressed_sources).toBeUndefined();
    expect(env.result.summary).toContain("digest");
  });
});

// ═══════════════════════════════════════════════════════════════
// Seed regression — corpus relevance threshold (B)
//
// Closed by the abstention slice (Agent B, swarm 2026-05-11).
// Companion to Agent A's frame-contract block above: the same
// evidence-custody frame, but the failure mode is on the CORPUS
// retrieval side rather than the extract/classify/summarize side.
//
// Original failure: corpus_answer would happily synthesize from 5
// hits @ top_score 0.21 (cosmology / off-topic chunks). The new
// `min_top_score` floor short-circuits that path with
// `abstained: true` instead of driving ungrounded synthesis.
// ═══════════════════════════════════════════════════════════════

describe("seed regression — corpus relevance threshold (B)", () => {
  it("min_top_score above top retrieval score → abstain, no synthesis", async () => {
    // We import lazily so the storage env trick doesn't bleed into the
    // top-level Mock-only tests above.
    const { handleCorpusAnswer } = await import("../src/tools/corpusAnswer.js");
    const { saveCorpus, CORPUS_SCHEMA_VERSION } = await import("../src/corpus/storage.js");
    const tempDir = await mkdtemp(join(tmpdir(), "intern-seed-b-"));
    const orig = process.env.INTERN_CORPUS_DIR;
    process.env.INTERN_CORPUS_DIR = tempDir;
    try {
      // Off-topic cosmology corpus — same evidence-custody frame as A's
      // block: the question is about evidence custody, but the corpus
      // contains a cosmology preprint. The retrieval scores will be
      // non-zero (some token overlap) but well below a 0.5 threshold.
      await saveCorpus({
        schema_version: CORPUS_SCHEMA_VERSION,
        name: "cosmology",
        model_version: PROFILES["dev-rtx5080"].tiers.embed,
        model_digest: null,
        indexed_at: "2026-05-11T00:00:00.000Z",
        chunk_chars: 800,
        chunk_overlap: 100,
        stats: { documents: 1, chunks: 1, total_chars: 100 },
        titles: { "/papers/2112.10422.md": "Cosmological Standard Timers" },
        chunks: [
          {
            id: "c-0",
            path: "/papers/2112.10422.md",
            file_hash: "sha256:test",
            file_mtime: "2026-05-11T00:00:00.000Z",
            chunk_index: 0,
            char_start: 0,
            char_end: 100,
            text: "primordial black hole bubbles as standard timers for cosmic history",
            vector: [1, 0, 0, 0],
            heading_path: [],
            chunk_type: "paragraph",
          },
        ],
      });

      const client = new Mock(
        JSON.stringify({ answer: "should never be invoked", citations: [1] }),
      );
      // Question shares one keyword ("history") with the chunk so lexical
      // retrieval returns a hit with a non-zero but small BM25 score —
      // this is the regression shape: 5-ish hits with a low top_score
      // driving synthesis. A 999 floor reliably trips the threshold path
      // (not the 0-hit short-circuit) on any BM25 implementation.
      const env = await handleCorpusAnswer(
        {
          corpus: "cosmology",
          question: "evidence custody history of inspectable chains",
          mode: "lexical",
          min_top_score: 999,
        },
        makeCtx(client),
      );

      expect(env.result.abstained).toBe(true);
      expect(env.result.citations).toEqual([]);
      expect(env.result.retrieval.weak).toBe(true);
      // Threshold branch (not 0-hit branch) — top_score > 0 because the
      // single token "history" matched in the chunk.
      expect(env.result.retrieval.retrieved).toBeGreaterThan(0);
      expect(env.result.retrieval.top_score).toBeGreaterThan(0);
      expect(env.result.retrieval.top_score).toBeLessThan(999);
      // Model was NOT invoked — the whole point.
      expect(client.lastGenerate).toBeUndefined();
      expect(env.warnings?.some((w) => w.includes("min_top_score"))).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.INTERN_CORPUS_DIR;
      else process.env.INTERN_CORPUS_DIR = orig;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("regression: InternError carries code/message/hint/retryable", () => {
  it("every error kind has all four fields (shipcheck gate B)", () => {
    const kinds = [
      new InternError("OLLAMA_UNREACHABLE", "m", "h", true),
      new InternError("PROTECTED_PATH_WRITE", "m", "h", false),
      new InternError("TIER_TIMEOUT", "m", "h", true),
      new InternError("SOURCE_PATH_NOT_FOUND", "m", "h", false),
    ];
    for (const e of kinds) {
      expect(e).toHaveProperty("code");
      expect(e).toHaveProperty("message");
      expect(e).toHaveProperty("hint");
      expect(e).toHaveProperty("retryable");
      expect(typeof e.retryable).toBe("boolean");
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// v2.3.0 per-call model override — research-os calibration pattern
//
// The receipts-backed orchestration use case is the load-bearing one:
// a caller asks for a specific model AND a frame, and needs the envelope
// to reflect both. The override propagates to model_requested; the actual
// inference model (resp.model post-fallback) lives in env.model. Fallback
// must NOT carry the caller's override into the cheaper tier — that's
// the corruption case calibration receipts care about.
// ═══════════════════════════════════════════════════════════════

describe("v2.3.0 per-call model override — research-os calibration pattern", () => {
  it("classify with frame + model together honors both", async () => {
    const client = new Mock(
      JSON.stringify({ label: "fix", confidence: 0.9, off_topic: false, off_topic_reason: null }),
    );
    const env = await handleClassify(
      {
        text: "patch null pointer in auth",
        labels: ["feat", "fix", "chore"],
        frame: "what is the change kind?",
        model: "hermes3:8b",
      },
      makeCtx(client),
    );
    // Frame contract still works.
    expect(client.lastGenerate?.prompt ?? "").toContain(
      "within the frame: what is the change kind?",
    );
    // Model override is honored on the wire.
    expect(client.lastGenerate?.model).toBe("hermes3:8b");
    // Envelope reflects both the requested and the resolved model.
    expect(env.model).toBe("hermes3:8b");
    expect(env.model_requested).toBe("hermes3:8b");
    // No fallback fired.
    expect(env.fallback_from).toBeUndefined();
  });

  it("fallback under input.model timeout uses tier-resolved model, surfaces both in envelope", async () => {
    // Mock that times out (waits for abort) on workhorse, returns ok on instant.
    // The first attempt with the override (`deepseek-coder:33b`) on workhorse
    // is forced to time out by setting the workhorse timeout to a tiny value
    // and never resolving the generate promise until abort. Fallback to
    // instant must NOT carry the override.
    class FallbackMock implements OllamaClient {
      public attempts: { tier: "workhorse" | "instant"; model: string }[] = [];
      async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
        if (req.model === "deepseek-coder:33b") {
          // First attempt: caller's override. Hang until abort to force timeout.
          this.attempts.push({ tier: "workhorse", model: req.model });
          return new Promise<GenerateResponse>((_resolve, reject) => {
            if (signal?.aborted) return reject(new Error("aborted"));
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        // Fallback attempt — must be the tier-resolved instant model.
        this.attempts.push({ tier: "instant", model: req.model });
        return {
          model: req.model,
          response: JSON.stringify({ name: "x" }),
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        };
      }
      async chat(_r: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
      async embed(_r: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
      async residency(_m: string): Promise<Residency | null> {
        return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
      }
    }
    const client = new FallbackMock();
    // Tier override: workhorse times out at 20ms; instant has plenty of budget.
    const ctx: RunContext = {
      client,
      tiers: PROFILES["dev-rtx5080"].tiers,
      timeouts: { ...PROFILES["dev-rtx5080"].timeouts, workhorse: 20 },
      hardwareProfile: "dev-rtx5080",
      logger: new NullLogger(),
    };
    const env = await handleExtract(
      {
        text: "anything",
        schema: { type: "object", properties: { name: { type: "string" } } },
        model: "deepseek-coder:33b",
      },
      ctx,
    );
    // Two attempts: override on workhorse, tier-resolved on instant fallback.
    expect(client.attempts.length).toBeGreaterThanOrEqual(2);
    expect(client.attempts[0].model).toBe("deepseek-coder:33b");
    const fallbackAttempt = client.attempts[client.attempts.length - 1];
    expect(fallbackAttempt.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    // Envelope: requested vs actual must differ — the calibration signal.
    expect(env.model_requested).toBe("deepseek-coder:33b");
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.model).not.toBe(env.model_requested);
    expect(env.fallback_from).toBe("workhorse");
    expect(env.tier_used).toBe("instant");
  });
});
