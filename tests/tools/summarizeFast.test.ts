import { describe, it, expect } from "vitest";
import { handleSummarizeFast, summarizeFastSchema } from "../../src/tools/summarizeFast.js";
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
  public lastPrompt?: string;
  public lastFormat?: string;
  public lastModel?: string;
  constructor(private response: string = "short summary") {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.lastPrompt = req.prompt;
    this.lastFormat = req.format;
    this.lastModel = req.model;
    return { model: req.model, response: this.response, done: true, prompt_eval_count: 50, eval_count: 10 };
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(_req: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
  async residency(_m: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient): RunContext & { logger: NullLogger } {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

describe("handleSummarizeFast — baseline (no frame)", () => {
  it("digests text and returns summary + source_preview + source_chars", async () => {
    const text = "A short blob of text that the fast summarizer should digest into a one-liner.";
    const client = new MockClient("the gist");
    const env = await handleSummarizeFast(
      { text, max_words: 30 },
      makeCtx(client),
    );
    expect(env.result.summary).toBe("the gist");
    expect(env.result.source_preview).toBe(text.slice(0, 200));
    expect(env.result.source_chars).toBe(text.length);
    expect(env.tier_used).toBe("instant");
    expect(env.hardware_profile).toBe("dev-rtx5080");
  });

  it("does NOT request json format when frame is absent", async () => {
    const client = new MockClient("plain prose");
    await handleSummarizeFast({ text: "body" }, makeCtx(client));
    expect(client.lastFormat).toBeUndefined();
    expect(client.lastPrompt ?? "").not.toContain("Frame:");
  });

  it("no on_topic key in result when frame is absent (back-compat)", async () => {
    const client = new MockClient("digest");
    const env = await handleSummarizeFast({ text: "body" }, makeCtx(client));
    expect((env.result as { on_topic?: boolean | null }).on_topic).toBeUndefined();
  });
});

describe("handleSummarizeFast — frame contract", () => {
  it("frame supplied + model says on_topic:true → result lifts on_topic", async () => {
    const modelOut = JSON.stringify({ on_topic: true, summary: "summary about the frame topic" });
    const client = new MockClient(modelOut);
    const env = await handleSummarizeFast(
      { text: "in-frame body", frame: "what is the deadline?" },
      makeCtx(client),
    );
    expect(env.result.on_topic).toBe(true);
    expect(env.result.summary).toBe("summary about the frame topic");
    expect(client.lastFormat).toBe("json");
    expect(client.lastPrompt ?? "").toContain("Frame: what is the deadline?");
  });

  it("frame supplied + model says on_topic:false → result lifts on_topic false", async () => {
    const modelOut = JSON.stringify({
      on_topic: false,
      summary: "(off-topic for frame: source is about an unrelated subject)",
    });
    const client = new MockClient(modelOut);
    const env = await handleSummarizeFast(
      { text: "off-topic body", frame: "what is the deadline?" },
      makeCtx(client),
    );
    expect(env.result.on_topic).toBe(false);
    expect(env.result.summary).toContain("off-topic for frame");
  });

  it("frame supplied + non-JSON sentinel-form fallback → still detects on_topic:false", async () => {
    const client = new MockClient("(off-topic for frame: cosmology, not deadlines)");
    const env = await handleSummarizeFast(
      { text: "x", frame: "what is the deadline?" },
      makeCtx(client),
    );
    expect(env.result.on_topic).toBe(false);
    expect(env.result.summary).toContain("off-topic for frame");
  });

  it("frame supplied + completely malformed output → on_topic is null", async () => {
    const client = new MockClient("garbage that does not parse and is not the sentinel");
    const env = await handleSummarizeFast(
      { text: "x", frame: "any frame" },
      makeCtx(client),
    );
    expect(env.result.on_topic).toBeNull();
    expect(env.result.summary).toBe("garbage that does not parse and is not the sentinel");
  });
});

describe("handleSummarizeFast — per-call model override (v2.3.0)", () => {
  it("input.model is passed to the underlying Ollama generate call", async () => {
    const client = new MockClient("a summary");
    const env = await handleSummarizeFast(
      { text: "body", model: "qwen3:14b" },
      makeCtx(client),
    );
    expect(client.lastModel).toBe("qwen3:14b");
    expect(env.model).toBe("qwen3:14b");
    expect(env.model_requested).toBe("qwen3:14b");
  });

  it("input.model omitted falls through to tier-resolved instant model", async () => {
    const client = new MockClient("a summary");
    const env = await handleSummarizeFast({ text: "body" }, makeCtx(client));
    expect(client.lastModel).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.model_requested).toBeUndefined();
  });

  it('input.model "" throws ZodError at schema parse', () => {
    expect(() => summarizeFastSchema.parse({ text: "x", model: "" })).toThrow();
  });

  it('input.model "   " (whitespace) throws ZodError at schema parse', () => {
    expect(() => summarizeFastSchema.parse({ text: "x", model: "   " })).toThrow();
  });
});
