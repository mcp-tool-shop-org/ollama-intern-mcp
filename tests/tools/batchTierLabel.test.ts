/**
 * M1 — a degraded batch envelope must report tier_used = the tier actually
 * used, not the original requested tier.
 *
 * runBatchInner built its envelope with `tier: input.tier` while sawFallback
 * was set to the ORIGINAL tier too — so a batch that degraded workhorse→instant
 * emitted tier_used="workhorse", fallback_from="workhorse", model=<instant
 * model>: a self-referential fallback record that lies to calibration-aware
 * consumers. The single-call runner already uses `tier: actualTier`.
 */
import { describe, it, expect } from "vitest";
import { runBatch } from "../../src/tools/batch.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
import { resolveTier, type Tier } from "../../src/tiers.js";
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

// The workhorse (initial) attempt hangs until the tier timeout aborts it →
// forces a fallback to instant, which resolves immediately.
class TierFallbackMock implements OllamaClient {
  async generate(req: GenerateRequest, signal?: AbortSignal, tier?: Tier): Promise<GenerateResponse> {
    if (tier === "workhorse") {
      return new Promise<GenerateResponse>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }
    return {
      model: req.model,
      response: JSON.stringify({ ok: true }),
      done: true,
      prompt_eval_count: 5,
      eval_count: 5,
    };
  }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    throw new Error("n/a");
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: req.model, embeddings: inputs.map(() => [1, 0, 0, 0]) };
  }
  async residency(_m: string): Promise<Residency | null> {
    return null;
  }
}

// M1-res: dev-rtx5080 maps EVERY tier to the same model (hermes3:8b), so
// `model === resolveTier("instant")` was vacuously true whether the envelope
// reported the fallback (instant) or the original (workhorse) tier's model.
// Distinct per-tier models make the model dimension actually change on a
// degrade, so the assertion below genuinely gates the M1 fix.
const DISTINCT_TIERS = {
  ...PROFILES["dev-rtx5080"].tiers,
  instant: "instant-only-model",
  workhorse: "workhorse-only-model",
  deep: "deep-only-model",
};

function makeCtx(client: OllamaClient): RunContext & { logger: NullLogger } {
  return {
    client,
    tiers: DISTINCT_TIERS,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

describe("runBatch — degraded envelope tier labeling (M1)", () => {
  it("reports tier_used = the tier actually used (not the original), with model to match", async () => {
    const ctx = makeCtx(new TierFallbackMock());
    const env = await runBatch<{ id: string }, { ok: boolean }>({
      tool: "test_batch",
      tier: "workhorse",
      ctx,
      allowFallback: true,
      tierBudgetMsOverride: 20, // force the workhorse hang to time out fast
      items: [{ id: "a" }],
      build: (_item, _tier, model) => ({ model, prompt: "x" }),
      parse: (raw) => JSON.parse(raw) as { ok: boolean },
    });

    // The item was served by the instant fallback, not workhorse.
    expect(env.tier_used).toBe("instant");
    expect(env.fallback_from).toBe("workhorse");
    expect(env.tier_used).not.toBe(env.fallback_from);
    // model must resolve from tier_used (the instant model), not the original.
    expect(env.model).toBe(resolveTier("instant", ctx.tiers)); // "instant-only-model"
    // Non-vacuous now: instant and workhorse map to DISTINCT models, so this
    // fails if the envelope reported the original (workhorse) tier's model.
    expect(env.model).not.toBe(resolveTier("workhorse", ctx.tiers));
    // Sanity: the item succeeded on the fallback.
    expect(env.result.items[0]).toMatchObject({ id: "a", ok: true });
  });
});
