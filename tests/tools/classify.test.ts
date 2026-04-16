import { describe, it, expect } from "vitest";
import { handleClassify } from "../../src/tools/classify.js";
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

class MockClient implements OllamaClient {
  public lastGenerate?: GenerateRequest;
  constructor(private raw: string, private tokens = { in: 50, out: 10 }) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.lastGenerate = req;
    return {
      model: req.model,
      response: this.raw,
      done: true,
      prompt_eval_count: this.tokens.in,
      eval_count: this.tokens.out,
    };
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    throw new Error("not used");
  }
  async embed(_req: EmbedRequest): Promise<EmbedResponse> {
    throw new Error("not used");
  }
  async residency(_model: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 100, size_vram_bytes: 100, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient, logger = new NullLogger()): RunContext & { logger: NullLogger } {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    hardwareProfile: "dev-rtx5080",
    logger,
  };
}

describe("handleClassify", () => {
  it("returns label/confidence on instant tier with dev-rtx5080 model and stamps hardware_profile", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
    const ctx = makeCtx(client);
    const env = await handleClassify(
      { text: "patch null pointer in auth", labels: ["feat", "fix", "chore"] },
      ctx,
    );
    expect(env.result.label).toBe("fix");
    expect(env.result.confidence).toBe(0.9);
    expect(env.result.below_threshold).toBe(false);
    expect(env.tier_used).toBe("instant");
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.hardware_profile).toBe("dev-rtx5080");
    expect(env.tokens_in).toBe(50);
    expect(env.tokens_out).toBe(10);
    expect(env.residency?.in_vram).toBe(true);
    expect(ctx.logger.events).toHaveLength(1);
    expect(ctx.logger.events[0].kind).toBe("call");
  });

  it("nulls the label when below threshold and allow_none=true", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.4 }));
    const ctx = makeCtx(client);
    const env = await handleClassify(
      { text: "ambiguous", labels: ["feat", "fix"], allow_none: true },
      ctx,
    );
    expect(env.result.label).toBeNull();
    expect(env.result.below_threshold).toBe(true);
  });

  it("gracefully handles non-JSON output with zero confidence", async () => {
    const client = new MockClient("garbage not json");
    const env = await handleClassify(
      { text: "x", labels: ["a", "b"] },
      makeCtx(client),
    );
    expect(env.result.label).toBeNull();
    expect(env.result.confidence).toBe(0);
  });

  it("sends format=json to Ollama (triggers structured output mode)", async () => {
    const client = new MockClient(JSON.stringify({ label: "a", confidence: 1 }));
    await handleClassify(
      { text: "x", labels: ["a", "b"] },
      makeCtx(client),
    );
    expect(client.lastGenerate?.format).toBe("json");
  });
});
