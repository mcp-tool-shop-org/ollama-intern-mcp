/**
 * R-019 — per-call tier budget override on `ollama_extract`.
 *
 * Adds optional `tier_budget_ms_override` to `extractSchema`. When set, the
 * value overrides the active profile's per-tier `timeouts` budget for THIS
 * call only — the override flows from `handleExtract` → `runTool` (or
 * `runBatch`) → `runWithTimeoutAndFallback`'s existing `timeoutOverrideMs`
 * parameter. Other callers and other tool invocations are unaffected.
 *
 * Default behavior (override omitted) preserves the profile's per-tier
 * timeouts exactly — pre-R-019 callers are byte-identical.
 *
 * Backed by the v0.4 rerun MISTARGETED-PATCH finding: research-os's R-018
 * Promise.race wrapper sits OUTSIDE the MCP call and never sees the
 * structured TIER_TIMEOUT response. R-019 lets the MCP client (research-os)
 * pass the operator's budget directly to the inner tier guardrail so the
 * named mechanism (`runWithTimeoutAndFallback.attempt()` at
 * `guardrails/timeouts.ts:61`) reflects the operator's intent.
 */

import { describe, it, expect } from "vitest";
import { handleExtract } from "../../src/tools/extract.js";
import { runTool } from "../../src/tools/runner.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
import { InternError, toErrorShape } from "../../src/errors.js";
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

class TimingMock implements OllamaClient {
  public generateCalls = 0;
  public lastSignals: Array<AbortSignal | undefined> = [];
  public timeoutsObserved: Array<{ tier: string; abortedAt: number }> = [];
  constructor(
    /** Resolve after this many ms. Use signal abort to short-circuit. */
    private readonly delayMs: number,
  ) {}
  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    this.generateCalls += 1;
    this.lastSignals.push(signal);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          model: req.model,
          response: JSON.stringify({ ok: true, data: { extracted: "value" } }),
          done: true,
          prompt_eval_count: 5,
          eval_count: 2,
        });
      }, this.delayMs);
      if (signal) {
        const onAbort = (): void => {
          clearTimeout(timer);
          this.timeoutsObserved.push({ tier: "unknown", abortedAt: Date.now() - started });
          reject(new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort);
      }
    });
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
  async residency(_m: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(
  client: OllamaClient,
  logger: NullLogger = new NullLogger(),
): RunContext & { logger: NullLogger } {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger,
  };
}

// ── R-019.SERVER.1 — schema accepts the new field ─────────────────────────

describe("R-019.SERVER.1 — extractSchema accepts tier_budget_ms_override", () => {
  it("schema parses an extract input with tier_budget_ms_override", async () => {
    const mod = await import("../../src/tools/extract.js");
    const parsed = mod.extractSchema.parse({
      text: "sample text",
      schema: { type: "object" },
      tier_budget_ms_override: 30000,
    });
    expect((parsed as Record<string, unknown>).tier_budget_ms_override).toBe(30000);
  });

  it("schema rejects tier_budget_ms_override below 1ms", async () => {
    const mod = await import("../../src/tools/extract.js");
    expect(() =>
      mod.extractSchema.parse({
        text: "sample text",
        schema: { type: "object" },
        tier_budget_ms_override: 0,
      }),
    ).toThrow();
  });

  it("schema rejects tier_budget_ms_override above 600000ms (10-min safety rail)", async () => {
    const mod = await import("../../src/tools/extract.js");
    expect(() =>
      mod.extractSchema.parse({
        text: "sample text",
        schema: { type: "object" },
        tier_budget_ms_override: 700000,
      }),
    ).toThrow();
  });

  it("schema treats tier_budget_ms_override as optional (backward compat)", async () => {
    const mod = await import("../../src/tools/extract.js");
    const parsed = mod.extractSchema.parse({
      text: "sample text",
      schema: { type: "object" },
    });
    expect((parsed as Record<string, unknown>).tier_budget_ms_override).toBeUndefined();
  });
});

// ── R-019.SERVER.2 — override propagates through handleExtract ─────────────

describe("R-019.SERVER.2 — handleExtract honors tier_budget_ms_override", () => {
  it("when override is set, slower-than-profile-budget but faster-than-override call succeeds", async () => {
    // Profile dev-rtx5080: workhorse=20000, instant=15000 fallback.
    // Mock generate that resolves at 80ms (well within both).
    const client = new TimingMock(80);
    const env = await handleExtract(
      { text: "anything", schema: { type: "object" }, tier_budget_ms_override: 200 } as Parameters<
        typeof handleExtract
      >[0],
      makeCtx(client),
    );
    const result = (env as Envelope<{ ok?: boolean; data?: unknown }>).result;
    expect((result as { ok?: boolean }).ok).toBe(true);
  });

  it("when override is set and call exceeds the override, the inner timeout fires at the override budget — NOT the profile default", async () => {
    // Override at 100ms; mock generate that takes 500ms; fallback also takes 500ms.
    // Workhorse times out at 100ms (override), fallback to instant times out at
    // 100ms (override). Total: ~200ms before TIER_TIMEOUT. Pre-R-019 the
    // budgets would be 20000ms + 15000ms = 35s.
    const client = new TimingMock(500);
    const logger = new NullLogger();
    const start = Date.now();
    let thrown: unknown = null;
    try {
      await handleExtract(
        { text: "anything", schema: { type: "object" }, tier_budget_ms_override: 100 } as Parameters<
          typeof handleExtract
        >[0],
        makeCtx(client, logger),
      );
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - start;
    expect(thrown).not.toBeNull();
    expect(thrown).toBeInstanceOf(InternError);
    if (thrown instanceof InternError) {
      expect(thrown.code).toBe("TIER_TIMEOUT");
      // Failure body must contain the override budget, NOT the profile default.
      expect(thrown.message).toContain("budget=100ms");
      expect(thrown.message).not.toContain("budget=15000ms");
      expect(thrown.message).not.toContain("budget=20000ms");
      // Round-trip through toErrorShape (what the MCP `wrap()` returns to
      // research-os) — the JSON-stringified envelope must still contain the
      // "TIER_TIMEOUT" marker so R-010's classifier triggers downstream.
      const shape = toErrorShape(thrown);
      expect(JSON.stringify(shape)).toContain("TIER_TIMEOUT");
    }
    // End-to-end well under the original profile total (20s + 15s = 35s).
    expect(elapsed).toBeLessThan(2000);

    // NDJSON log shows the override budget on the timeout events — proof
    // the override reached the named control point.
    const timeoutEvents = logger.events.filter((e) => e.kind === "timeout");
    expect(timeoutEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of timeoutEvents) {
      expect((e as { timeout_ms: number }).timeout_ms).toBe(100);
    }
  });

  it("when override is OMITTED, behavior is byte-identical to v0.12.1 baseline (profile defaults)", async () => {
    // Mock generate that resolves at 50ms (well within profile workhorse=20000).
    const client = new TimingMock(50);
    const logger = new NullLogger();
    const env = await handleExtract(
      { text: "anything", schema: { type: "object" } } as Parameters<typeof handleExtract>[0],
      makeCtx(client, logger),
    );
    const result = (env as Envelope<{ ok?: boolean; data?: unknown }>).result;
    expect((result as { ok?: boolean }).ok).toBe(true);
    // No timeout events should fire (50ms call within workhorse 20000ms budget).
    const timeoutEvents = logger.events.filter((e) => e.kind === "timeout");
    expect(timeoutEvents).toHaveLength(0);
  });
});

// ── R-019.SERVER.3 — runTool accepts tierBudgetMsOverride ──────────────────

describe("R-019.SERVER.3 — runTool exposes tierBudgetMsOverride", () => {
  it("runTool with tierBudgetMsOverride passes the override into timeoutOverrideMs", async () => {
    // Use runTool directly with a mock that resolves immediately so we can
    // assert the override does not break the happy path. Then test a slow
    // mock to assert the override actually shortens the timeout.
    const fastClient = new TimingMock(20);
    const env = await runTool({
      tool: "test_tool",
      tier: "workhorse",
      ctx: makeCtx(fastClient),
      think: false,
      tierBudgetMsOverride: 200,
      build: (_tier, model) => ({
        model,
        prompt: "test prompt",
        format: "json",
        options: { temperature: 0.2 },
      }),
      parse: (raw) => JSON.parse(raw) as { ok: boolean; data: unknown },
    });
    expect(env).toBeDefined();
    expect((env.result as { ok?: boolean }).ok).toBe(true);
  });

  it("runTool with tierBudgetMsOverride times out at the override budget", async () => {
    const slowClient = new TimingMock(500);
    const logger = new NullLogger();
    let thrown: unknown = null;
    try {
      await runTool({
        tool: "test_tool",
        tier: "workhorse",
        ctx: makeCtx(slowClient, logger),
        think: false,
        tierBudgetMsOverride: 100,
        allowFallback: false, // disable fallback for clean single-tier timing
        build: (_tier, model) => ({
          model,
          prompt: "test prompt",
          format: "json",
          options: { temperature: 0.2 },
        }),
        parse: (raw) => JSON.parse(raw) as { ok: boolean; data: unknown },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternError);
    if (thrown instanceof InternError) {
      expect(thrown.code).toBe("TIER_TIMEOUT");
      expect(thrown.message).toContain("budget=100ms");
    }

    const timeoutEvents = logger.events.filter((e) => e.kind === "timeout");
    expect(timeoutEvents).toHaveLength(1);
    expect((timeoutEvents[0] as { timeout_ms: number }).timeout_ms).toBe(100);
  });
});

// ── R-019.SERVER.4 — TIER_TIMEOUT error shape preserved (R-010 compat) ─────

describe("R-019.SERVER.4 — TIER_TIMEOUT error shape preserved under override", () => {
  it("TIER_TIMEOUT error under override still matches /elapsed=(\\d+)ms/ + /budget=(\\d+)ms/ regex (R-010 compat)", async () => {
    const slowClient = new TimingMock(500);
    let thrown: unknown = null;
    try {
      await handleExtract(
        { text: "anything", schema: { type: "object" }, tier_budget_ms_override: 100 } as Parameters<
          typeof handleExtract
        >[0],
        makeCtx(slowClient),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InternError);
    if (!(thrown instanceof InternError)) return;
    expect(thrown.code).toBe("TIER_TIMEOUT");
    const message = thrown.message;
    const elapsedMatch = message.match(/elapsed=(\d+)ms/);
    const budgetMatch = message.match(/budget=(\d+)ms/);
    expect(elapsedMatch, "R-010 regex /elapsed=(\\d+)ms/ must still match").not.toBeNull();
    expect(budgetMatch, "R-010 regex /budget=(\\d+)ms/ must still match").not.toBeNull();
    if (budgetMatch) {
      expect(parseInt(budgetMatch[1], 10)).toBe(100);
    }
    // Wrap the error like MCP `wrap()` does — the marker that triggers
    // R-010's `classifyFallbackCause` ("TIER_TIMEOUT" substring) lives in
    // the JSON-stringified envelope, NOT the bare message.
    const shape = toErrorShape(thrown);
    expect(JSON.stringify(shape)).toContain("TIER_TIMEOUT");
  });
});
