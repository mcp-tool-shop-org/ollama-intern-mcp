/**
 * Tests for the ollama_embed payload-size warning — large raw-vector
 * batches should surface a warnings[] entry pointing at the preferred
 * concept-search path, but must never refuse.
 */

import { describe, it, expect } from "vitest";
import { handleEmbed, estimateEmbeddingsBytes, EMBED_PAYLOAD_WARN_BYTES } from "../../src/tools/embed.js";
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

class ConfigurableEmbedMock implements OllamaClient {
  public dim: number;
  public perInput: number;
  constructor(dim: number) {
    this.dim = dim;
    this.perInput = dim;
  }
  async generate(_: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used");
  }
  async chat(_: ChatRequest): Promise<ChatResponse> {
    throw new Error("not used");
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const vec = new Array(this.dim).fill(0.123456);
    return { model: req.model, embeddings: inputs.map(() => vec) };
  }
  async residency(_: string): Promise<Residency | null> {
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

describe("estimateEmbeddingsBytes", () => {
  it("returns 2 for an empty batch", () => {
    expect(estimateEmbeddingsBytes([])).toBe(2);
  });

  it("scales approximately linearly with dim * count", () => {
    const small = estimateEmbeddingsBytes([new Array(10).fill(0.1)]);
    const big = estimateEmbeddingsBytes([new Array(100).fill(0.1)]);
    // 100 dims → roughly 10x larger than 10 dims (with small constant overhead).
    expect(big).toBeGreaterThan(small * 9);
  });
});

describe("handleEmbed payload-size warning", () => {
  it("does NOT emit a warning for a small single-input call", async () => {
    const client = new ConfigurableEmbedMock(16);
    const env = await handleEmbed({ input: "hello" }, makeCtx(client));
    expect(env.warnings).toBeUndefined();
  });

  it("emits a warning when the batch payload exceeds the threshold", async () => {
    // 768-dim * 256 items ≈ 768*9*256 ≈ 1.77MB — well past the 500KB threshold.
    const client = new ConfigurableEmbedMock(768);
    const batch = Array.from({ length: 256 }, (_, i) => `item-${i}`);
    const env = await handleEmbed({ input: batch }, makeCtx(client));
    expect(env.warnings).toBeDefined();
    expect(env.warnings!.some((w) => /overflow/i.test(w) || /embed_search/i.test(w))).toBe(true);
    // But the result is still returned — warning, not refusal.
    expect(env.result.embeddings.length).toBe(256);
  });

  it("threshold constant is documented + exported for tests", () => {
    expect(EMBED_PAYLOAD_WARN_BYTES).toBeGreaterThan(0);
  });
});
