/**
 * Batch surface tests — Workflow Spine commit A.
 *
 * Covers the laws we locked for batch mode:
 *   - ONE envelope per batch; no per-item full envelopes
 *   - batch_count / ok_count / error_count at the envelope level
 *   - per-item entries stay tight: {id, ok, result|error}
 *   - stable, caller-provided, unique ids required — duplicates rejected
 *   - partial failure is first-class — one bad item doesn't explode the batch
 *   - tokens accumulate; residency probed once at the end
 *   - single-mode (text) calls are untouched — backwards-compatible
 *
 * The shared runBatch helper is tested directly via a synthetic tool, then
 * each of the three real batchified tools (classify, extract, triage_logs)
 * is tested end-to-end to confirm wiring.
 */

import { describe, it, expect } from "vitest";
import { runBatch, type BatchResult } from "../../src/tools/batch.js";
import { handleClassify } from "../../src/tools/classify.js";
import { handleExtract } from "../../src/tools/extract.js";
import { handleTriageLogs } from "../../src/tools/triageLogs.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
import { InternError } from "../../src/errors.js";
import type { Envelope, Residency } from "../../src/envelope.js";
import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "../../src/ollama.js";
import type { RunContext } from "../../src/runContext.js";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Mock that returns a prescribed response per prompt — lets tests stage
 * per-item model output (including malformed JSON) deterministically.
 */
class TableMock implements OllamaClient {
  public generateCalls = 0;
  public lastPrompts: string[] = [];
  constructor(
    /** Picks the response for a given prompt. Default = empty JSON object. */
    private readonly respond: (prompt: string, idx: number) => string,
    private readonly tokens = { in: 40, out: 10 },
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const idx = this.generateCalls;
    this.generateCalls += 1;
    this.lastPrompts.push(req.prompt);
    return {
      model: req.model,
      response: this.respond(req.prompt, idx),
      done: true,
      prompt_eval_count: this.tokens.in,
      eval_count: this.tokens.out,
    };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
  async residency(_m: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient, logger = new NullLogger()): RunContext & { logger: NullLogger } {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger,
  };
}

// Narrowing helper: given a return that might be single-or-batch, assert batch shape.
function asBatch<R>(env: Envelope<unknown>): Envelope<BatchResult<R>> {
  const r = env.result as { items?: unknown };
  if (!Array.isArray(r.items)) throw new Error("not a batch envelope");
  return env as Envelope<BatchResult<R>>;
}

// ── Shared runBatch helper ─────────────────────────────────

describe("runBatch — shared helper", () => {
  it("returns a single envelope with per-item {id, ok, result} entries", async () => {
    const client = new TableMock(() => "alpha");
    const env = await runBatch<{ id: string; word: string }, { echoed: string }>({
      tool: "toy",
      tier: "instant",
      ctx: makeCtx(client),
      items: [
        { id: "a", word: "one" },
        { id: "b", word: "two" },
        { id: "c", word: "three" },
      ],
      build: (item, _tier, model) => ({
        model,
        prompt: `say: ${item.word}`,
      }),
      parse: (raw) => ({ echoed: raw }),
    });

    expect(env.result.items).toHaveLength(3);
    expect(env.batch_count).toBe(3);
    expect(env.ok_count).toBe(3);
    expect(env.error_count).toBe(0);
    const ids = env.result.items.map((i) => i.id);
    expect(ids).toEqual(["a", "b", "c"]);
    for (const entry of env.result.items) {
      expect(entry.ok).toBe(true);
      if (entry.ok) expect(entry.result.echoed).toBe("alpha");
    }
    // Token accounting: summed across items.
    expect(env.tokens_in).toBe(40 * 3);
    expect(env.tokens_out).toBe(10 * 3);
  });

  it("captures per-item parse failures as {ok: false, error} — batch completes", async () => {
    const client = new TableMock((_p, i) => (i === 1 ? "BOOM" : "ok"));
    const env = await runBatch<{ id: string }, { value: string }>({
      tool: "toy",
      tier: "instant",
      ctx: makeCtx(client),
      items: [
        { id: "one" },
        { id: "two" },
        { id: "three" },
      ],
      build: (_item, _tier, model) => ({ model, prompt: "x" }),
      parse: (raw) => {
        if (raw === "BOOM") throw new Error("parse blew up");
        return { value: raw };
      },
    });
    expect(env.batch_count).toBe(3);
    expect(env.ok_count).toBe(2);
    expect(env.error_count).toBe(1);
    const bad = env.result.items[1];
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.message).toContain("parse blew up");
      expect(bad.error.code).toBe("INTERNAL");
    }
    // Subsequent items still ran — batch never exploded.
    const last = env.result.items[2];
    expect(last.ok).toBe(true);
  });

  it("surfaces InternError code/hint on per-item failures", async () => {
    const client = new TableMock(() => "irrelevant");
    const env = await runBatch<{ id: string }, string>({
      tool: "toy",
      tier: "instant",
      ctx: makeCtx(client),
      items: [{ id: "x" }, { id: "y" }],
      build: (_i, _t, model) => ({ model, prompt: "z" }),
      parse: (_raw, item) => {
        if (item.id === "y") {
          throw new InternError("EXTRACT_UNPARSEABLE", "can't parse", "Try again.", false);
        }
        return "fine";
      },
    });
    const bad = env.result.items[1];
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe("EXTRACT_UNPARSEABLE");
      expect(bad.error.hint).toBe("Try again.");
    }
  });

  it("rejects duplicate item ids up front (no model calls)", async () => {
    const client = new TableMock(() => "x");
    await expect(
      runBatch<{ id: string }, string>({
        tool: "toy",
        tier: "instant",
        ctx: makeCtx(client),
        items: [{ id: "dup" }, { id: "unique" }, { id: "dup" }],
        build: (_i, _t, model) => ({ model, prompt: "p" }),
        parse: (raw) => raw,
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID", message: expect.stringContaining("dup") });
    expect(client.generateCalls).toBe(0);
  });

  it("duplicate-id error message lists every colliding id (not just 'some duplicates')", async () => {
    const client = new TableMock(() => "x");
    let caught: unknown;
    try {
      await runBatch<{ id: string }, string>({
        tool: "toy",
        tier: "instant",
        ctx: makeCtx(client),
        items: [
          { id: "alpha" },
          { id: "beta" },
          { id: "alpha" },
          { id: "gamma" },
          { id: "beta" },
        ],
        build: (_i, _t, model) => ({ model, prompt: "p" }),
        parse: (raw) => raw,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const msg = (caught as { message: string }).message;
    const hint = (caught as { hint: string }).hint;
    // Every distinct duplicated id appears in both message and hint, quoted
    // for clarity so 'alpha'/'beta' aren't ambiguous with words inside the
    // surrounding prose.
    expect(msg).toContain("'alpha'");
    expect(msg).toContain("'beta'");
    expect(msg).not.toContain("'gamma'"); // gamma was unique
    expect(hint).toContain("'alpha'");
    expect(hint).toContain("'beta'");
  });

  it("pre-validation throwing fails that item only, not the batch", async () => {
    const client = new TableMock(() => "ok");
    const env = await runBatch<{ id: string; text: string }, string>({
      tool: "toy",
      tier: "instant",
      ctx: makeCtx(client),
      items: [
        { id: "a", text: "good" },
        { id: "b", text: "" },
        { id: "c", text: "also good" },
      ],
      build: (_i, _t, model) => ({ model, prompt: "p" }),
      parse: (raw) => raw,
      preValidate: (item) => {
        if (item.text.length === 0) {
          throw new InternError("SCHEMA_INVALID", "empty text", "non-empty required", false);
        }
      },
    });
    expect(env.ok_count).toBe(2);
    expect(env.error_count).toBe(1);
    // Model was NOT called for the pre-validation failure.
    expect(client.generateCalls).toBe(2);
    const bad = env.result.items[1];
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("SCHEMA_INVALID");
  });

  it("empty items array returns an empty batch envelope, no model calls", async () => {
    // Schema should forbid this at the tool layer, but runBatch itself
    // shouldn't crash if a caller hands it []. Behavior: 0-count envelope.
    const client = new TableMock(() => "x");
    const env = await runBatch<{ id: string }, string>({
      tool: "toy",
      tier: "instant",
      ctx: makeCtx(client),
      items: [],
      build: (_i, _t, model) => ({ model, prompt: "p" }),
      parse: (raw) => raw,
    });
    expect(env.batch_count).toBe(0);
    expect(env.ok_count).toBe(0);
    expect(env.error_count).toBe(0);
    expect(client.generateCalls).toBe(0);
  });

  it("emits exactly one NDJSON log line for the whole batch", async () => {
    const client = new TableMock(() => "ok");
    const logger = new NullLogger();
    await runBatch<{ id: string }, string>({
      tool: "toy",
      tier: "instant",
      ctx: makeCtx(client, logger),
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
      build: (_i, _t, model) => ({ model, prompt: "p" }),
      parse: (raw) => raw,
    });
    expect(logger.events).toHaveLength(1);
    expect(logger.events[0].kind).toBe("call");
    expect(logger.events[0].tool).toBe("toy");
  });
});

// ── Per-tool batch integration ─────────────────────────────

describe("handleClassify — batch mode", () => {
  it("classifies every item, returns one envelope, joins by id", async () => {
    const responses: Record<string, string> = {
      "feat one": JSON.stringify({ label: "feat", confidence: 0.9 }),
      "fix two": JSON.stringify({ label: "fix", confidence: 0.88 }),
      "docs three": JSON.stringify({ label: "docs", confidence: 0.7 }),
    };
    const client = new TableMock((prompt) => {
      for (const [k, v] of Object.entries(responses)) {
        if (prompt.includes(k)) return v;
      }
      return JSON.stringify({ label: "chore", confidence: 0.3 });
    });
    const env = asBatch<{ label: string | null; confidence: number; below_threshold: boolean }>(
      await handleClassify(
        {
          items: [
            { id: "pr-1", text: "feat one" },
            { id: "pr-2", text: "fix two" },
            { id: "pr-3", text: "docs three" },
          ],
          labels: ["feat", "fix", "chore", "docs"],
        },
        makeCtx(client),
      ),
    );
    expect(env.batch_count).toBe(3);
    expect(env.ok_count).toBe(3);
    const byId = Object.fromEntries(env.result.items.map((i) => [i.id, i]));
    expect(byId["pr-1"].ok && byId["pr-1"].result.label).toBe("feat");
    expect(byId["pr-2"].ok && byId["pr-2"].result.label).toBe("fix");
    expect(byId["pr-3"].ok && byId["pr-3"].result.label).toBe("docs");
  });

  it("rejects calls that pass BOTH text and items", async () => {
    const client = new TableMock(() => "");
    await expect(
      handleClassify(
        { text: "x", items: [{ id: "a", text: "y" }], labels: ["a", "b"] },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects calls that pass NEITHER text nor items", async () => {
    const client = new TableMock(() => "");
    await expect(
      handleClassify({ labels: ["a", "b"] }, makeCtx(client)),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("single-mode (text) still works unchanged", async () => {
    const client = new TableMock(() => JSON.stringify({ label: "fix", confidence: 0.9 }));
    const env = await handleClassify(
      { text: "patch", labels: ["feat", "fix"] },
      makeCtx(client),
    );
    // Single-mode returns ClassifyGuarded directly on .result — no .items.
    const result = env.result as { label: string | null; confidence: number };
    expect(result.label).toBe("fix");
    expect("items" in env.result).toBe(false);
  });
});

describe("handleExtract — batch mode", () => {
  it("runs N extractions with one shared schema, returns per-item ok/error", async () => {
    // Two items parse cleanly; the third returns non-JSON and surfaces as unparseable.
    const client = new TableMock((_prompt, i) => {
      if (i === 2) return "not JSON at all";
      return JSON.stringify({ name: `n${i}`, count: i });
    });
    const env = asBatch<{ ok: boolean } & Record<string, unknown>>(
      await handleExtract(
        {
          items: [
            { id: "f-1", text: "input one" },
            { id: "f-2", text: "input two" },
            { id: "f-3", text: "input three" },
          ],
          schema: { type: "object", properties: { name: { type: "string" }, count: { type: "integer" } } },
        },
        makeCtx(client),
      ),
    );
    expect(env.batch_count).toBe(3);
    expect(env.ok_count).toBe(3); // parse always returns a result — ok or unparseable are BOTH ok: true at the batch level
    // But the per-item result carries its own ok:false on unparseable.
    const third = env.result.items[2];
    expect(third.ok).toBe(true);
    if (third.ok) {
      const inner = third.result as { ok: boolean };
      expect(inner.ok).toBe(false);
    }
  });
});

describe("handleTriageLogs — batch mode", () => {
  it("triages multiple log blobs in one call with stable ids", async () => {
    const client = new TableMock((_prompt, i) =>
      JSON.stringify({
        errors: [`err${i}`],
        warnings: [],
        suspected_root_cause: `cause-${i}`,
      }),
    );
    const env = asBatch<{ errors: string[]; warnings: string[]; suspected_root_cause?: string }>(
      await handleTriageLogs(
        {
          items: [
            { id: "ci-run-1", log_text: "FAILED: test A" },
            { id: "ci-run-2", log_text: "FAILED: test B" },
          ],
        },
        makeCtx(client),
      ),
    );
    expect(env.batch_count).toBe(2);
    expect(env.ok_count).toBe(2);
    const one = env.result.items[0];
    const two = env.result.items[1];
    expect(one.ok && one.result.errors).toEqual(["err0"]);
    expect(two.ok && two.result.errors).toEqual(["err1"]);
    // IDs preserved.
    expect(one.id).toBe("ci-run-1");
    expect(two.id).toBe("ci-run-2");
  });

  it("batch envelope carries summed tokens, one residency, one log line", async () => {
    const client = new TableMock(
      () => JSON.stringify({ errors: [], warnings: [], suspected_root_cause: null }),
      { in: 100, out: 30 },
    );
    const logger = new NullLogger();
    const env = await handleTriageLogs(
      {
        items: [
          { id: "a", log_text: "log a" },
          { id: "b", log_text: "log b" },
          { id: "c", log_text: "log c" },
        ],
      },
      makeCtx(client, logger),
    );
    expect(env.tokens_in).toBe(100 * 3);
    expect(env.tokens_out).toBe(30 * 3);
    expect(env.residency).not.toBeNull();
    expect(logger.events).toHaveLength(1);
  });
});
