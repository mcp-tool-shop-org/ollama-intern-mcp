import { describe, it, expect } from "vitest";
import { handleClassify } from "../../src/tools/classify.js";
import { DEFAULT_TIER_CONFIG } from "../../src/tiers.js";
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

describe("handleClassify", () => {
  it("returns label/confidence with instant tier and populates envelope", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
    const logger = new NullLogger();
    const env = await handleClassify(
      { text: "patch null pointer in auth", labels: ["feat", "fix", "chore"] },
      { client, tierConfig: DEFAULT_TIER_CONFIG, logger },
    );
    expect(env.result.label).toBe("fix");
    expect(env.result.confidence).toBe(0.9);
    expect(env.result.below_threshold).toBe(false);
    expect(env.tier_used).toBe("instant");
    expect(env.model).toBe(DEFAULT_TIER_CONFIG.instant);
    expect(env.tokens_in).toBe(50);
    expect(env.tokens_out).toBe(10);
    expect(env.residency?.in_vram).toBe(true);
    expect(logger.events).toHaveLength(1);
    expect(logger.events[0].kind).toBe("call");
  });

  it("nulls the label when below threshold and allow_none=true", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.4 }));
    const logger = new NullLogger();
    const env = await handleClassify(
      { text: "ambiguous", labels: ["feat", "fix"], allow_none: true },
      { client, tierConfig: DEFAULT_TIER_CONFIG, logger },
    );
    expect(env.result.label).toBeNull();
    expect(env.result.below_threshold).toBe(true);
  });

  it("gracefully handles non-JSON output with zero confidence", async () => {
    const client = new MockClient("garbage not json");
    const logger = new NullLogger();
    const env = await handleClassify(
      { text: "x", labels: ["a", "b"] },
      { client, tierConfig: DEFAULT_TIER_CONFIG, logger },
    );
    expect(env.result.label).toBeNull();
    expect(env.result.confidence).toBe(0);
  });

  it("sends format=json to Ollama (triggers structured output mode)", async () => {
    const client = new MockClient(JSON.stringify({ label: "a", confidence: 1 }));
    await handleClassify(
      { text: "x", labels: ["a", "b"] },
      { client, tierConfig: DEFAULT_TIER_CONFIG, logger: new NullLogger() },
    );
    expect(client.lastGenerate?.format).toBe("json");
  });
});
