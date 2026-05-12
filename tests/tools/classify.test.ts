import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClassify, classifySchema } from "../../src/tools/classify.js";
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
    timeouts: PROFILES["dev-rtx5080"].timeouts,
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

describe("handleClassify — source_path mode", () => {
  it("reads the file server-side and uses its contents as the classification text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "classify-srcpath-"));
    const filePath = join(dir, "commit.txt");
    try {
      await writeFile(filePath, "patch null pointer in auth", "utf8");
      const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
      const env = await handleClassify(
        { source_path: filePath, labels: ["feat", "fix", "chore"] },
        makeCtx(client),
      );
      expect(env.result.label).toBe("fix");
      expect(client.lastGenerate?.prompt).toContain("patch null pointer in auth");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing files with a clear SOURCE_PATH_NOT_FOUND error", async () => {
    const client = new MockClient(JSON.stringify({ label: "x", confidence: 1 }));
    await expect(
      handleClassify(
        { source_path: "F:/definitely/does/not/exist.txt", labels: ["a", "b"] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/SOURCE_PATH_NOT_FOUND|Cannot read source path/);
  });

  it("throws SCHEMA_INVALID when both text and source_path are passed", async () => {
    const client = new MockClient(JSON.stringify({ label: "a", confidence: 1 }));
    await expect(
      handleClassify(
        { text: "x", source_path: "anywhere.txt", labels: ["a", "b"] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/exactly one of "text", "source_path", or "items"/);
  });

  it("throws SCHEMA_INVALID when none of text/source_path/items are passed", async () => {
    const client = new MockClient(JSON.stringify({ label: "a", confidence: 1 }));
    await expect(
      handleClassify({ labels: ["a", "b"] } as Parameters<typeof handleClassify>[0], makeCtx(client)),
    ).rejects.toThrow(/exactly one of "text", "source_path", or "items"/);
  });

  it("respects per_file_max_chars when reading source_path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "classify-maxchars-"));
    const filePath = join(dir, "big.txt");
    try {
      const content = "ABCDEFGHIJ".repeat(5000); // 50,000 chars
      await writeFile(filePath, content, "utf8");
      const client = new MockClient(JSON.stringify({ label: "a", confidence: 1 }));
      await handleClassify(
        { source_path: filePath, labels: ["a", "b"], per_file_max_chars: 2000 },
        makeCtx(client),
      );
      // Prompt body should contain at most the truncated window, not the full 50k.
      const prompt = client.lastGenerate?.prompt ?? "";
      expect(prompt.length).toBeLessThan(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("handleClassify — frame contract", () => {
  it("back-compat: no frame input → no off_topic / off_topic_reason in result", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
    const env = await handleClassify(
      { text: "patch null pointer", labels: ["feat", "fix"] },
      makeCtx(client),
    );
    expect(env.result.label).toBe("fix");
    expect((env.result as { off_topic?: boolean }).off_topic).toBeUndefined();
    expect((env.result as { off_topic_reason?: string }).off_topic_reason).toBeUndefined();
    expect(client.lastGenerate?.prompt ?? "").not.toContain("frame:");
  });

  it("frame supplied + model says off_topic:false → off_topic is false, label kept", async () => {
    const client = new MockClient(
      JSON.stringify({ label: "fix", confidence: 0.9, off_topic: false, off_topic_reason: null }),
    );
    const env = await handleClassify(
      { text: "patch null pointer in auth", labels: ["feat", "fix"], frame: "what type of change is this commit?" },
      makeCtx(client),
    );
    expect(env.result.label).toBe("fix");
    expect(env.result.off_topic).toBe(false);
    expect(env.result.off_topic_reason).toBeNull();
    expect(client.lastGenerate?.prompt ?? "").toContain("frame: what type of change");
  });

  it("frame supplied + model says off_topic:true → label is forced null", async () => {
    const client = new MockClient(
      JSON.stringify({
        label: "fix",
        confidence: 0.95,
        off_topic: true,
        off_topic_reason: "input is unrelated to the frame",
      }),
    );
    const env = await handleClassify(
      { text: "weather report", labels: ["feat", "fix"], frame: "what type of change is this commit?" },
      makeCtx(client),
    );
    expect(env.result.label).toBeNull();
    expect(env.result.off_topic).toBe(true);
    expect(env.result.off_topic_reason).toContain("unrelated");
  });

  it("off_topic and below_threshold are independent concepts", async () => {
    // High-confidence label, but off-topic → label nulled because of frame, not threshold.
    const client = new MockClient(
      JSON.stringify({ label: "fix", confidence: 0.99, off_topic: true, off_topic_reason: "wrong frame" }),
    );
    const env = await handleClassify(
      { text: "x", labels: ["feat", "fix"], frame: "f" },
      makeCtx(client),
    );
    expect(env.result.label).toBeNull();
    expect(env.result.off_topic).toBe(true);
    expect(env.result.below_threshold).toBe(false); // confidence 0.99 > 0.7
  });
});

describe("handleClassify — per-call model override (v2.3.0)", () => {
  it("input.model is passed to the underlying Ollama generate call", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
    const env = await handleClassify(
      { text: "x", labels: ["feat", "fix"], model: "hermes3:8b" },
      makeCtx(client),
    );
    expect(client.lastGenerate?.model).toBe("hermes3:8b");
    expect(env.model).toBe("hermes3:8b");
    expect(env.model_requested).toBe("hermes3:8b");
  });

  it("input.model omitted falls through to tier-resolved instant model", async () => {
    const client = new MockClient(JSON.stringify({ label: "fix", confidence: 0.9 }));
    const env = await handleClassify(
      { text: "x", labels: ["feat", "fix"] },
      makeCtx(client),
    );
    expect(client.lastGenerate?.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.instant);
    expect(env.model_requested).toBeUndefined();
  });

  it('input.model "" throws ZodError at schema parse', () => {
    expect(() =>
      classifySchema.parse({ text: "x", labels: ["a", "b"], model: "" }),
    ).toThrow();
  });

  it('input.model "   " (whitespace) throws ZodError at schema parse', () => {
    expect(() =>
      classifySchema.parse({ text: "x", labels: ["a", "b"], model: "   " }),
    ).toThrow();
  });
});
