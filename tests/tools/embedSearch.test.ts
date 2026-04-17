import { describe, it, expect } from "vitest";
import { handleEmbedSearch } from "../../src/tools/embedSearch.js";
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

/**
 * Mock that returns pre-baked vectors keyed by input text so we can
 * control ranking without running Ollama. Vectors are 2D for clarity.
 */
class EmbedMock implements OllamaClient {
  public lastEmbed?: EmbedRequest;
  constructor(private table: Record<string, number[]>) {}

  async generate(_req: GenerateRequest): Promise<GenerateResponse> { throw new Error("not used"); }
  async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.lastEmbed = req;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      embeddings: inputs.map((t) => this.table[t] ?? [0, 0]),
    };
  }
  async residency(_m: string): Promise<Residency | null> {
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

describe("handleEmbedSearch", () => {
  it("returns ranked candidates by cosine similarity and does NOT return raw vectors", async () => {
    const client = new EmbedMock({
      "how do protected paths work?": [1, 0],
      "protected-path list prevents overwriting canon files": [0.9, 0.1],
      "benchmarks capture tok/s": [0, 1],
      "classify returns label and confidence": [0.3, 0.9],
    });
    const env = await handleEmbedSearch(
      {
        query: "how do protected paths work?",
        candidates: [
          { id: "bench", text: "benchmarks capture tok/s" },
          { id: "paths", text: "protected-path list prevents overwriting canon files" },
          { id: "classify", text: "classify returns label and confidence" },
        ],
      },
      makeCtx(client),
    );

    // Ranking: paths (0.9-ish) > classify (0.3) > bench (0)
    expect(env.result.ranked.map((r) => r.id)).toEqual(["paths", "classify", "bench"]);
    expect(env.result.ranked[0].score).toBeGreaterThan(env.result.ranked[1].score);
    // Result must NOT carry the raw vectors — that's the whole point of this tool.
    expect(Object.keys(env.result)).not.toContain("embeddings");
    expect(env.result.model_version).toBe(PROFILES["dev-rtx5080"].tiers.embed);
    expect(env.result.candidates_embedded).toBe(3);
    expect(env.tier_used).toBe("embed");
    expect(env.hardware_profile).toBe("dev-rtx5080");
  });

  it("respects top_k", async () => {
    const client = new EmbedMock({
      q: [1, 0],
      "a": [1, 0],
      "b": [0.8, 0.2],
      "c": [0, 1],
    });
    const env = await handleEmbedSearch(
      {
        query: "q",
        candidates: [
          { id: "c1", text: "a" },
          { id: "c2", text: "b" },
          { id: "c3", text: "c" },
        ],
        top_k: 2,
      },
      makeCtx(client),
    );
    expect(env.result.ranked).toHaveLength(2);
    expect(env.result.ranked.map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("includes preview when preview_chars > 0, omits when 0", async () => {
    const client = new EmbedMock({ q: [1, 0], "hello world": [1, 0] });
    const withPreview = await handleEmbedSearch(
      { query: "q", candidates: [{ id: "only", text: "hello world" }], preview_chars: 5 },
      makeCtx(client),
    );
    expect(withPreview.result.ranked[0].preview).toBe("hello");

    const withoutPreview = await handleEmbedSearch(
      { query: "q", candidates: [{ id: "only", text: "hello world" }] },
      makeCtx(client),
    );
    expect(withoutPreview.result.ranked[0].preview).toBeUndefined();
  });

  it("sends a single embed call with query + all candidates in one batch", async () => {
    const client = new EmbedMock({ q: [1, 0], a: [1, 0], b: [0, 1] });
    await handleEmbedSearch(
      {
        query: "q",
        candidates: [
          { id: "c1", text: "a" },
          { id: "c2", text: "b" },
        ],
      },
      makeCtx(client),
    );
    expect(Array.isArray(client.lastEmbed?.input)).toBe(true);
    expect(client.lastEmbed?.input).toEqual(["q", "a", "b"]);
  });
});
