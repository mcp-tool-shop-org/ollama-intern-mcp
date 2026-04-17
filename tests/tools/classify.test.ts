import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
