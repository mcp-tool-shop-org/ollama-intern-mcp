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

class MockClient implements OllamaClient {
  public generates: GenerateRequest[] = [];
  public residencyCalls: string[] = [];
  constructor(private behavior: "ok" | "throw" = "ok") {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.generates.push(req);
    if (this.behavior === "throw") throw new Error("ollama unreachable");
    return {
      model: req.model,
      response: "ok",
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    };
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(_req: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
  async residency(model: string): Promise<Residency | null> {
    this.residencyCalls.push(model);
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

describe("runPrewarm", () => {
  it("issues a generate per requested tier and logs success events", async () => {
    const client = new MockClient("ok");
    const ctx = makeCtx(client);
    const successes = await runPrewarm(ctx, ["instant"]);
    expect(successes).toBe(1);
    expect(client.generates).toHaveLength(1);
    expect(client.generates[0].model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(client.generates[0].keep_alive).toBe(-1);
    const events = ctx.logger.events.filter((e) => e.kind === "prewarm");
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<typeof events[number], { kind: "prewarm" }>;
    expect(e.success).toBe(true);
    expect(e.tier).toBe("instant");
    expect(e.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(e.hardware_profile).toBe("dev-rtx5080");
    expect(e.residency?.in_vram).toBe(true);
    expect(e.error).toBeUndefined();
  });

  it("logs failure event but does not throw when Ollama is unreachable", async () => {
    const client = new MockClient("throw");
    const ctx = makeCtx(client);
    const successes = await runPrewarm(ctx, ["instant"]);
    expect(successes).toBe(0);
    const events = ctx.logger.events.filter((e) => e.kind === "prewarm");
    expect(events).toHaveLength(1);
    const e = events[0] as Extract<typeof events[number], { kind: "prewarm" }>;
    expect(e.success).toBe(false);
    expect(e.error).toContain("ollama unreachable");
    expect(e.residency).toBeNull();
  });

  it("respects an empty tier list (m5-max profile case) — no generate, no event", async () => {
    const client = new MockClient("ok");
    const ctx = makeCtx(client);
    const successes = await runPrewarm(ctx, []);
    expect(successes).toBe(0);
    expect(client.generates).toHaveLength(0);
    expect(ctx.logger.events.filter((e) => e.kind === "prewarm")).toHaveLength(0);
  });

  it("uses minimal generate (num_predict=1, temperature=0)", async () => {
    const client = new MockClient("ok");
    await runPrewarm(makeCtx(client), ["instant"]);
    expect(client.generates[0].options?.num_predict).toBe(1);
    expect(client.generates[0].options?.temperature).toBe(0);
  });
});
