/**
 * Direct coverage for src/tools/runner.ts (Stage C / tests F-005).
 *
 * runner is the shared wiring every atom tool uses — tier resolution,
 * per-call model override (v2.3.0), per-tier num_ctx (v2.4.0), fallback
 * retry, envelope construction, residency probe, NDJSON event emission.
 * Before this file landed, runner was tested INDIRECTLY through each
 * caller (classify.test.ts etc.). When the runner contract drifted
 * (e.g. model_requested shape), the failure surfaced in N caller tests
 * instead of one pinned contract.
 *
 * This file is the direct, single-source pin.
 *
 * What this file locks (test names describe user-facing behavior, not
 * implementation choices, so a failure message reads as a contract
 * violation — not a refactor regression).
 *
 *   1. Tier resolution — runner picks the model from RunContext.tiers
 *      for the requested tier.
 *   2. modelOverride — applies on the initial tier; fallback retry
 *      resolves from the fallback tier (NOT the override).
 *   3. num_ctx per-tier — present on initial tier when profile sets it;
 *      fallback inherits the fallback tier's setting (or omits when
 *      unset).
 *   4. Envelope construction — model_requested vs model distinction;
 *      num_ctx_used; warnings passthrough.
 *   5. NDJSON emission — kind:'call' fires on every success;
 *      kind:'timeout' + kind:'fallback' fire on a timeout-then-fallback
 *      path with snake_case field names.
 *
 * Mocking posture: directly construct RunContext with a tiny
 * OllamaClient mock that records every generate() call. No build
 * artifacts needed. The runner pulls residency from the client so we
 * stub residency() to return a deterministic Residency shape.
 */

import { describe, it, expect } from "vitest";
import { runTool } from "../../src/tools/runner.js";
import { NullLogger } from "../../src/observability.js";
import { PROFILES } from "../../src/profiles.js";
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
import type { Tier } from "../../src/tiers.js";

// ── Mock client — records every generate() and lets each test seed
//    per-attempt behavior via a queue of generators. ─────────────

interface CallRecord {
  req: GenerateRequest;
  signal: AbortSignal | undefined;
  tier: Tier | undefined;
}

class RecordingClient implements OllamaClient {
  public calls: CallRecord[] = [];
  /** Per-call behavior. If empty, falls back to defaultBehavior. */
  private queue: Array<(req: GenerateRequest) => Promise<GenerateResponse>> = [];
  private defaultBehavior: (req: GenerateRequest) => Promise<GenerateResponse>;

  constructor(defaultRaw: string = "ok") {
    this.defaultBehavior = async (req) => ({
      model: req.model,
      response: defaultRaw,
      done: true,
      prompt_eval_count: 7,
      eval_count: 4,
    });
  }

  enqueue(behavior: (req: GenerateRequest) => Promise<GenerateResponse>): this {
    this.queue.push(behavior);
    return this;
  }

  async generate(req: GenerateRequest, signal?: AbortSignal, tier?: Tier): Promise<GenerateResponse> {
    this.calls.push({ req, signal, tier });
    const next = this.queue.shift() ?? this.defaultBehavior;
    return next(req);
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("runner does not call chat");
  }
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    throw new Error("runner does not call embed");
  }
  async residency(_model: string): Promise<Residency | null> {
    return {
      in_vram: true,
      size_bytes: 100,
      size_vram_bytes: 100,
      evicted: false,
      expires_at: null,
    };
  }
  async probe(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
}

function makeCtx(client: OllamaClient, profile: keyof typeof PROFILES = "dev-rtx5080"): RunContext & { logger: NullLogger } {
  const logger = new NullLogger();
  return {
    client,
    tiers: PROFILES[profile].tiers,
    timeouts: PROFILES[profile].timeouts,
    hardwareProfile: profile,
    logger,
  };
}

/**
 * Build a generate-mock function that hangs until the runner's
 * AbortController fires (i.e. the tier timeout). When the abort fires,
 * the mock rejects with an AbortError — runWithTimeoutAndFallback
 * sees `timedOut === true` and triggers the timeout/fallback path.
 *
 * Throwing AbortError synchronously instead would short-circuit the
 * timer entirely and be re-raised as-is (not as TIER_TIMEOUT).
 */
function hangUntilAbort(client: RecordingClient): (req: GenerateRequest) => Promise<GenerateResponse> {
  return () =>
    new Promise<GenerateResponse>((_resolve, reject) => {
      const lastSignal = client.calls[client.calls.length - 1].signal;
      if (lastSignal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      lastSignal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

// ── 1. Tier resolution ─────────────────────────────────────

describe("runTool — tier resolution from RunContext.tiers", () => {
  it("picks the model for the requested tier (dev-rtx5080 instant)", async () => {
    const client = new RecordingClient("body");
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].req.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.tier_used).toBe("instant");
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.hardware_profile).toBe("dev-rtx5080");
  });

  it("workhorse tier resolves to workhorse model on m5-max", async () => {
    const client = new RecordingClient("body");
    const env = await runTool({
      tool: "ollama_x",
      tier: "workhorse",
      ctx: makeCtx(client, "m5-max"),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(env.model).toBe(PROFILES["m5-max"].tiers.workhorse);
  });

  it("deep tier on dev-rtx5080-qwen3 picks the deep model declared in the profile", async () => {
    const client = new RecordingClient("body");
    const env = await runTool({
      tool: "ollama_x",
      tier: "deep",
      ctx: makeCtx(client, "dev-rtx5080-qwen3"),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(env.model).toBe(PROFILES["dev-rtx5080-qwen3"].tiers.deep);
  });
});

// ── 2. modelOverride ───────────────────────────────────────

describe("runTool — when modelOverride is set, only the initial tier uses it", () => {
  it("initial attempt uses the override model verbatim", async () => {
    const client = new RecordingClient("ok");
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      modelOverride: "hermes3:8b-custom",
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(client.calls[0].req.model).toBe("hermes3:8b-custom");
    expect(env.model).toBe("hermes3:8b-custom");
    expect(env.model_requested).toBe("hermes3:8b-custom");
  });

  it("envelope.model_requested is OMITTED when no override was supplied", async () => {
    const client = new RecordingClient("ok");
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(env.model_requested).toBeUndefined();
  });

  it("on fallback retry, the override is NOT applied — fallback uses the tier-resolved model", async () => {
    // First attempt waits for the abort signal — the runner's timeout
    // timer fires and aborts, then runWithTimeoutAndFallback retries
    // on the fallback tier. Important: the rejection must happen
    // AFTER the timer fires so the `timedOut` flag is set; throwing
    // synchronously is treated as a normal error and re-thrown.
    const client = new RecordingClient("ok");
    client.enqueue(hangUntilAbort(client));
    // Fallback attempt: enqueue the normal success path (default behavior).

    const ctx = makeCtx(client);
    // Short-circuit the deep timeout: override per-tier timeout to a
    // tiny value so the abort fires fast.
    ctx.timeouts = { ...ctx.timeouts, deep: 50 };

    const env = await runTool({
      tool: "ollama_x",
      tier: "deep",
      ctx,
      modelOverride: "custom-deep-model",
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });

    expect(client.calls.length).toBeGreaterThanOrEqual(2);
    // Initial deep attempt should have used the override.
    expect(client.calls[0].req.model).toBe("custom-deep-model");
    // Fallback attempt (workhorse) MUST use the tier-resolved workhorse
    // model, NOT the override.
    expect(client.calls[1].req.model).toBe(PROFILES["dev-rtx5080"].tiers.workhorse);
    // The final envelope's `model` reflects the fallback model that
    // actually ran. model_requested still echoes the override (so a
    // calibration-aware caller can detect substitution).
    expect(env.tier_used).toBe("workhorse");
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.workhorse);
    expect(env.model_requested).toBe("custom-deep-model");
    expect(env.fallback_from).toBe("deep");
  });
});

// ── 3. num_ctx per-tier ────────────────────────────────────

describe("runTool — num_ctx is resolved against the ACTIVE tier (v2.4.0)", () => {
  it("dev-rtx5080 instant tier → options.num_ctx=4096 on the wire + envelope.num_ctx_used=4096", async () => {
    const client = new RecordingClient("ok");
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(client.calls[0].req.options).toMatchObject({ num_ctx: 4096 });
    expect(env.num_ctx_used).toBe(4096);
  });

  it("dev-rtx5080 deep tier → num_ctx is UNSET in the profile, so the request omits it and the envelope omits num_ctx_used", async () => {
    const client = new RecordingClient("ok");
    const env = await runTool({
      tool: "ollama_x",
      tier: "deep",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    const opts = client.calls[0].req.options ?? {};
    expect(opts).not.toHaveProperty("num_ctx");
    expect(env.num_ctx_used).toBeUndefined();
  });

  it("m5-max profile leaves num_ctx unset on every tier — workhorse request omits the field", async () => {
    const client = new RecordingClient("ok");
    const env = await runTool({
      tool: "ollama_x",
      tier: "workhorse",
      ctx: makeCtx(client, "m5-max"),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    const opts = client.calls[0].req.options ?? {};
    expect(opts).not.toHaveProperty("num_ctx");
    expect(env.num_ctx_used).toBeUndefined();
  });

  it("fallback from deep→workhorse picks up workhorse num_ctx (dev-rtx5080 has workhorse=8192)", async () => {
    const client = new RecordingClient("ok");
    // Initial deep attempt times out; fallback retries on workhorse.
    client.enqueue(hangUntilAbort(client));

    const ctx = makeCtx(client);
    ctx.timeouts = { ...ctx.timeouts, deep: 50 };

    const env = await runTool({
      tool: "ollama_x",
      tier: "deep",
      ctx,
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });

    // Initial deep attempt: num_ctx omitted (deep is unset on this
    // profile).
    const initialOpts = client.calls[0].req.options ?? {};
    expect(initialOpts).not.toHaveProperty("num_ctx");
    // Fallback (workhorse) attempt: num_ctx=8192 because workhorse is
    // set on this profile.
    expect(client.calls[1].req.options).toMatchObject({ num_ctx: 8192 });
    // Final envelope reflects the workhorse num_ctx (last attempt won).
    expect(env.num_ctx_used).toBe(8192);
  });
});

// ── 4. Envelope construction ───────────────────────────────

describe("runTool — envelope construction", () => {
  it("populates tokens_in/out from the generate response counts", async () => {
    const client = new RecordingClient();
    // Default behavior returns prompt_eval_count=7, eval_count=4.
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(env.tokens_in).toBe(7);
    expect(env.tokens_out).toBe(4);
  });

  it("attaches residency from client.residency() — null residency surfaces as null", async () => {
    class NoResidencyClient extends RecordingClient {
      async residency(): Promise<Residency | null> {
        return null;
      }
    }
    const client = new NoResidencyClient();
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(env.residency).toBeNull();
  });

  it("passes warnings array through to the envelope when non-empty", async () => {
    const client = new RecordingClient();
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
      warnings: ["3 citations stripped (paths not in source_paths)"],
    });
    expect(env.warnings).toEqual([
      "3 citations stripped (paths not in source_paths)",
    ]);
  });

  it("omits warnings field when undefined", async () => {
    const client = new RecordingClient();
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(env.warnings).toBeUndefined();
  });

  it("parse() result is what lands on envelope.result (passthrough contract)", async () => {
    const client = new RecordingClient(JSON.stringify({ label: "fix" }));
    const env = await runTool<{ label: string }>({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => JSON.parse(r) as { label: string },
    });
    expect(env.result).toEqual({ label: "fix" });
  });

  it("elapsed_ms is non-negative and reasonably small for a synchronous mock", async () => {
    const client = new RecordingClient();
    const env = await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(env.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(env.elapsed_ms).toBeLessThan(5000);
  });
});

// ── 5. NDJSON event emission ───────────────────────────────

describe("runTool — NDJSON event emission", () => {
  it("emits exactly one kind:'call' event on the happy path", async () => {
    const client = new RecordingClient();
    const ctx = makeCtx(client);
    await runTool({
      tool: "ollama_classify",
      tier: "instant",
      ctx,
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(ctx.logger.events).toHaveLength(1);
    expect(ctx.logger.events[0]).toMatchObject({
      kind: "call",
      tool: "ollama_classify",
    });
    // The envelope on the call event MUST carry snake_case fields, per
    // the canonical schema.
    const callEv = ctx.logger.events[0] as Extract<
      (typeof ctx.logger.events)[number],
      { kind: "call" }
    >;
    expect(callEv.envelope).toMatchObject({
      tier_used: "instant",
      hardware_profile: "dev-rtx5080",
    });
  });

  it("on a timeout-then-fallback path, emits kind:'timeout' AND kind:'fallback' AND a final kind:'call' (order: timeout, fallback, call)", async () => {
    const client = new RecordingClient("ok");
    client.enqueue(hangUntilAbort(client));
    const ctx = makeCtx(client);
    ctx.timeouts = { ...ctx.timeouts, deep: 50 };

    await runTool({
      tool: "ollama_corpus_answer",
      tier: "deep",
      ctx,
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });

    const kinds = ctx.logger.events.map((e) => e.kind);
    expect(kinds, `expected timeout→fallback→call ordering, got [${kinds.join(", ")}]`).toEqual([
      "timeout",
      "fallback",
      "call",
    ]);
    // Timeout event must carry tier + timeout_ms.
    const timeoutEv = ctx.logger.events[0];
    expect(timeoutEv).toMatchObject({
      kind: "timeout",
      tool: "ollama_corpus_answer",
      tier: "deep",
      timeout_ms: 50,
    });
    // Fallback event must carry from→to.
    expect(ctx.logger.events[1]).toMatchObject({
      kind: "fallback",
      tool: "ollama_corpus_answer",
      from: "deep",
      to: "workhorse",
    });
  });

  it("when allowFallback:false and the tier times out, emits kind:'timeout' and propagates the error (no kind:'fallback')", async () => {
    const client = new RecordingClient("ok");
    client.enqueue(hangUntilAbort(client));
    const ctx = makeCtx(client);
    ctx.timeouts = { ...ctx.timeouts, instant: 50 };

    await expect(
      runTool({
        tool: "ollama_x",
        tier: "instant",
        ctx,
        allowFallback: false,
        build: (_t, model) => ({ model, prompt: "p" }),
        parse: (r) => r,
      }),
    ).rejects.toThrow(/TIER_TIMEOUT|timed out/);

    const kinds = ctx.logger.events.map((e) => e.kind);
    // Timeout fires; fallback does NOT.
    expect(kinds).toContain("timeout");
    expect(kinds).not.toContain("fallback");
    expect(kinds).not.toContain("call");
  });
});

// ── 6. think field plumbing ────────────────────────────────

describe("runTool — think field plumbing (Qwen 3 thinking-mode toggle)", () => {
  it("when input.think is undefined, the built request's think field is unchanged", async () => {
    const client = new RecordingClient();
    await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      build: (_t, model) => ({ model, prompt: "p" }), // no think set
      parse: (r) => r,
    });
    expect(client.calls[0].req.think).toBeUndefined();
  });

  it("when input.think=true, the built request gets think=true on the wire", async () => {
    const client = new RecordingClient();
    await runTool({
      tool: "ollama_x",
      tier: "deep",
      ctx: makeCtx(client),
      think: true,
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(client.calls[0].req.think).toBe(true);
  });

  it("when input.think=false, the built request gets think=false on the wire (Qwen 3 no-think toggle)", async () => {
    const client = new RecordingClient();
    await runTool({
      tool: "ollama_x",
      tier: "instant",
      ctx: makeCtx(client),
      think: false,
      build: (_t, model) => ({ model, prompt: "p" }),
      parse: (r) => r,
    });
    expect(client.calls[0].req.think).toBe(false);
  });
});
