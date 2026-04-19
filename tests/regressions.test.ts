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
import { handleClassify } from "../src/tools/classify.js";
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
    for (const hit of env.result.ranked) {
      expect(Object.keys(hit).sort()).toEqual(expect.not.arrayContaining(["embedding", "vector"]));
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
