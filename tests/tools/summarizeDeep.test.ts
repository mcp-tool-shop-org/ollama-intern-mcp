import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSummarizeDeep } from "../../src/tools/summarizeDeep.js";
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
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.lastPrompt = req.prompt;
    return { model: req.model, response: "digest", done: true, prompt_eval_count: 100, eval_count: 20 };
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

describe("handleSummarizeDeep", () => {
  it("accepts raw text and digests it", async () => {
    const client = new MockClient();
    const text = "A long document that Claude wants digested with a specific focus.";
    const env = await handleSummarizeDeep(
      { text, max_words: 40 },
      makeCtx(client),
    );
    expect(env.result.summary).toBe("digest");
    expect(env.result.source_chars).toBe(text.length);
    expect(client.lastPrompt).toContain("A long document that Claude wants");
  });

  it("accepts source_paths and reads files server-side (context-saving mode)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-sd-"));
    const p1 = join(dir, "a.md");
    const p2 = join(dir, "b.md");
    await writeFile(p1, "alpha content about cats", "utf8");
    await writeFile(p2, "bravo content about dogs", "utf8");
    try {
      const client = new MockClient();
      const env = await handleSummarizeDeep(
        { source_paths: [p1, p2], max_words: 40 },
        makeCtx(client),
      );
      expect(env.result.summary).toBe("digest");
      // Both files' content must appear in the prompt the model actually saw.
      expect(client.lastPrompt).toContain("alpha content about cats");
      expect(client.lastPrompt).toContain("bravo content about dogs");
      // source_preview should be the first file's leading chars.
      expect(env.result.source_preview).toBe("alpha content about cats");
      expect(env.result.source_chars).toBe("alpha content about cats".length + "bravo content about dogs".length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects calls that pass both text AND source_paths", async () => {
    const client = new MockClient();
    await expect(
      handleSummarizeDeep(
        { text: "a", source_paths: ["x.md"] },
        makeCtx(client),
      ),
    ).rejects.toThrow(/exactly one/i);
  });

  it("rejects calls that pass neither text NOR source_paths", async () => {
    const client = new MockClient();
    await expect(
      handleSummarizeDeep({} as { text?: string; source_paths?: string[] }, makeCtx(client)),
    ).rejects.toThrow(/exactly one/i);
  });

  it("surfaces SOURCE_PATH_NOT_FOUND when a source path doesn't exist", async () => {
    const client = new MockClient();
    await expect(
      handleSummarizeDeep(
        { source_paths: ["F:/absolutely/does/not/exist.md"] },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });
});
