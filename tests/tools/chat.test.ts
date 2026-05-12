/**
 * ollama_chat tests — minimum coverage for the last-resort tool.
 *
 * Pre-v2.3.0 chat had no dedicated test file; the per-call model override
 * feature is what drove these. Tests focus on the model-resolution contract
 * (override threading, tier fallback when omitted, schema strictness on
 * empty/whitespace overrides). The chat handler does not engage the timeout
 * fallback cascade, so semantics for "override + fallback" don't apply
 * here — that's exercised in the runner-backed atoms.
 */

import { describe, it, expect } from "vitest";
import { handleChat, chatSchema } from "../../src/tools/chat.js";
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
  public lastChat?: ChatRequest;
  constructor(private reply: string = "ok") {}
  async generate(_req: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used");
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.lastChat = req;
    return {
      model: req.model,
      message: { role: "assistant", content: this.reply },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    };
  }
  async embed(_r: EmbedRequest): Promise<EmbedResponse> {
    throw new Error("not used");
  }
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

describe("handleChat — baseline", () => {
  it("returns reply + last_resort marker", async () => {
    const client = new MockClient("hello back");
    const env = await handleChat(
      { messages: [{ role: "user", content: "hello" }] },
      makeCtx(client),
    );
    expect(env.result.reply).toBe("hello back");
    expect(env.result.last_resort).toBe(true);
    expect(env.tier_used).toBe("workhorse");
  });
});

describe("handleChat — per-call model override (v2.3.0)", () => {
  it("input.model is passed to the underlying Ollama chat call", async () => {
    const client = new MockClient("ok");
    const env = await handleChat(
      {
        messages: [{ role: "user", content: "hi" }],
        model: "hermes3:8b-q5_K_M",
      },
      makeCtx(client),
    );
    expect(client.lastChat?.model).toBe("hermes3:8b-q5_K_M");
    expect(env.model).toBe("hermes3:8b-q5_K_M");
    expect(env.model_requested).toBe("hermes3:8b-q5_K_M");
  });

  it("input.model omitted falls through to tier-resolved workhorse model", async () => {
    const client = new MockClient("ok");
    const env = await handleChat(
      { messages: [{ role: "user", content: "hi" }] },
      makeCtx(client),
    );
    expect(client.lastChat?.model).toBe(PROFILES["dev-rtx5080"].tiers.workhorse);
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.workhorse);
    expect(env.model_requested).toBeUndefined();
  });

  it('input.model "" throws ZodError at schema parse', () => {
    expect(() =>
      chatSchema.parse({
        messages: [{ role: "user", content: "x" }],
        model: "",
      }),
    ).toThrow();
  });

  it('input.model "   " (whitespace) throws ZodError at schema parse', () => {
    expect(() =>
      chatSchema.parse({
        messages: [{ role: "user", content: "x" }],
        model: "   ",
      }),
    ).toThrow();
  });
});
