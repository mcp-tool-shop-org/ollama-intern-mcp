/**
 * Prewarm invariants — hardening around the one-shot startup behavior.
 *
 * Covers:
 * - prewarm ONLY touches declared tiers (Workhorse + Deep stay untouched)
 * - prewarm uses keep_alive=-1 (model stays resident, not evicted after call)
 * - prewarm uses minimal generate (num_predict=1), doesn't burn tokens
 * - residency snapshot after successful prewarm reflects in_vram=true
 * - multiple prewarm tiers fire in the declared order
 */

import { describe, it, expect } from "vitest";
import { runPrewarm } from "../src/prewarm.js";
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
import type { Residency } from "../src/envelope.js";
import type { RunContext } from "../src/runContext.js";

class OrderedMock implements OllamaClient {
  public generateModels: string[] = [];
  public generateKeepAlive: Array<string | number | undefined> = [];
  public generateNumPredict: Array<number | undefined> = [];
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.generateModels.push(req.model);
    this.generateKeepAlive.push(req.keep_alive);
    this.generateNumPredict.push(req.options?.num_predict);
    return { model: req.model, response: "ok", done: true, prompt_eval_count: 1, eval_count: 1 };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("unused"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> { throw new Error("unused"); }
  async residency(model: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function ctxFor(profileName: keyof typeof PROFILES, client: OllamaClient): RunContext & { logger: NullLogger } {
  const p = PROFILES[profileName];
  return {
    client,
    tiers: p.tiers,
    timeouts: p.timeouts,
    hardwareProfile: p.name,
    logger: new NullLogger(),
  };
}

describe("prewarm policy matrix", () => {
  it("dev-rtx5080 prewarms ONLY Instant (exactly one generate call)", async () => {
    // dev-rtx5080 now uses hermes3:8b across Instant/Workhorse/Deep (v2.0.0),
    // so "Workhorse/Deep models not in the call list" is ill-defined —
    // they share a model name with Instant. The invariant that matters is
    // the CALL COUNT: prewarm runs once per tier in Profile.prewarm, so
    // exactly one generate call means only Instant was touched.
    const client = new OrderedMock();
    const ctx = ctxFor("dev-rtx5080", client);
    await runPrewarm(ctx, PROFILES["dev-rtx5080"].prewarm);
    expect(client.generateModels).toEqual([PROFILES["dev-rtx5080"].tiers.instant]);
    expect(client.generateModels).toHaveLength(1);
  });

  it("dev-rtx5080-qwen3 prewarms Instant with its own Qwen 3 Instant model", async () => {
    // Renamed from dev-rtx5080-llama at v2.0.0. Instant is qwen3:8b (distinct
    // from default dev-rtx5080's hermes3:8b), so this profile prewarms its own model.
    const client = new OrderedMock();
    const ctx = ctxFor("dev-rtx5080-qwen3", client);
    await runPrewarm(ctx, PROFILES["dev-rtx5080-qwen3"].prewarm);
    expect(client.generateModels).toEqual([PROFILES["dev-rtx5080-qwen3"].tiers.instant]);
  });

  it("m5-max prewarm list is empty — generate is never called", async () => {
    const client = new OrderedMock();
    const ctx = ctxFor("m5-max", client);
    await runPrewarm(ctx, PROFILES["m5-max"].prewarm);
    expect(client.generateModels).toEqual([]);
  });
});

describe("prewarm request shape", () => {
  it("every prewarm call sends keep_alive=-1 (model stays resident)", async () => {
    const client = new OrderedMock();
    const ctx = ctxFor("dev-rtx5080", client);
    await runPrewarm(ctx, ["instant"]);
    expect(client.generateKeepAlive).toEqual([-1]);
  });

  it("every prewarm call sends num_predict=1 (minimal token burn)", async () => {
    const client = new OrderedMock();
    const ctx = ctxFor("dev-rtx5080", client);
    await runPrewarm(ctx, ["instant"]);
    expect(client.generateNumPredict).toEqual([1]);
  });
});

describe("prewarm event shape", () => {
  it("successful prewarm event carries residency with in_vram=true", async () => {
    const client = new OrderedMock();
    const ctx = ctxFor("dev-rtx5080", client);
    await runPrewarm(ctx, ["instant"]);
    const events = ctx.logger.events.filter((e) => e.kind === "prewarm");
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<typeof events[number], { kind: "prewarm" }>;
    expect(e.success).toBe(true);
    expect(e.residency?.in_vram).toBe(true);
    expect(e.residency?.evicted).toBe(false);
    expect(e.hardware_profile).toBe("dev-rtx5080");
  });
});

describe("prewarm multiple tiers", () => {
  it("fires in declared order when list has multiple tiers", async () => {
    const client = new OrderedMock();
    const ctx = ctxFor("dev-rtx5080", client);
    // Hypothetical future profile that prewarms Instant + Workhorse — test the mechanism.
    await runPrewarm(ctx, ["instant", "workhorse"]);
    expect(client.generateModels).toEqual([
      PROFILES["dev-rtx5080"].tiers.instant,
      PROFILES["dev-rtx5080"].tiers.workhorse,
    ]);
    const prewarmEvents = ctx.logger.events.filter((e) => e.kind === "prewarm");
    expect(prewarmEvents).toHaveLength(2);
    const tiers = (prewarmEvents as Array<Extract<typeof prewarmEvents[number], { kind: "prewarm" }>>)
      .map((e) => e.tier);
    expect(tiers).toEqual(["instant", "workhorse"]);
  });
});
