import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExtract, extractSchema } from "../../src/tools/extract.js";
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

const simpleSchema = {
  type: "object",
  properties: { name: { type: "string" }, count: { type: "number" } },
  required: ["name"],
};

describe("handleExtract — text mode", () => {
  it("returns parsed JSON data on valid output", async () => {
    const client = new MockClient(JSON.stringify({ name: "foo", count: 3 }));
    const env = await handleExtract(
      { text: "foo happened 3 times", schema: simpleSchema },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect(env.result.ok).toBe(true);
    expect(env.result.data).toEqual({ name: "foo", count: 3 });
  });

  it("returns unparseable on invalid JSON", async () => {
    const client = new MockClient("not json");
    const env = await handleExtract(
      { text: "anything", schema: simpleSchema },
      makeCtx(client),
    );
    if ("data" in env.result) throw new Error("expected failure shape");
    expect(env.result.ok).toBe(false);
    expect(env.result.error).toBe("unparseable");
  });
});

describe("handleExtract — source_path mode", () => {
  it("reads the file server-side and extracts from its contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extract-srcpath-"));
    const filePath = join(dir, "report.txt");
    try {
      await writeFile(filePath, "foo happened 7 times today", "utf8");
      const client = new MockClient(JSON.stringify({ name: "foo", count: 7 }));
      const env = await handleExtract(
        { source_path: filePath, schema: simpleSchema },
        makeCtx(client),
      );
      if (!("data" in env.result)) throw new Error("expected success shape");
      expect(env.result.data).toEqual({ name: "foo", count: 7 });
      expect(client.lastGenerate?.prompt).toContain("foo happened 7 times today");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing files with a clear SOURCE_PATH_NOT_FOUND error", async () => {
    const client = new MockClient("{}");
    await expect(
      handleExtract(
        { source_path: "F:/definitely/does/not/exist.txt", schema: simpleSchema },
        makeCtx(client),
      ),
    ).rejects.toThrow(/SOURCE_PATH_NOT_FOUND|Cannot read source path/);
  });

  it("throws SCHEMA_INVALID when both text and source_path are passed", async () => {
    const client = new MockClient("{}");
    await expect(
      handleExtract(
        { text: "x", source_path: "anywhere.txt", schema: simpleSchema },
        makeCtx(client),
      ),
    ).rejects.toThrow(/exactly one of "text", "source_path", or "items"/);
  });

  it("throws SCHEMA_INVALID when none of text/source_path/items are passed", async () => {
    const client = new MockClient("{}");
    await expect(
      handleExtract({ schema: simpleSchema } as Parameters<typeof handleExtract>[0], makeCtx(client)),
    ).rejects.toThrow(/exactly one of "text", "source_path", or "items"/);
  });

  it("respects per_file_max_chars when reading source_path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extract-maxchars-"));
    const filePath = join(dir, "big.txt");
    try {
      const content = "ABCDEFGHIJ".repeat(5000); // 50,000 chars
      await writeFile(filePath, content, "utf8");
      const client = new MockClient(JSON.stringify({ name: "x" }));
      await handleExtract(
        { source_path: filePath, schema: simpleSchema, per_file_max_chars: 2000 },
        makeCtx(client),
      );
      const prompt = client.lastGenerate?.prompt ?? "";
      expect(prompt.length).toBeLessThan(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("handleExtract — frame contract", () => {
  it("back-compat: no frame input → no frame_alignment in result", async () => {
    const client = new MockClient(JSON.stringify({ name: "foo", count: 1 }));
    const env = await handleExtract(
      { text: "foo happened once", schema: simpleSchema },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect(env.result.data).toEqual({ name: "foo", count: 1 });
    expect((env.result as { frame_alignment?: unknown }).frame_alignment).toBeUndefined();
    // Prompt should NOT mention frame either.
    expect(client.lastGenerate?.prompt ?? "").not.toContain("Frame:");
  });

  it("frame supplied + model says on_topic:true → result lifts frame_alignment", async () => {
    const modelOut = JSON.stringify({
      name: "foo",
      count: 4,
      _frame_alignment: { on_topic: true, reason: "the text addresses the asked-about question" },
    });
    const client = new MockClient(modelOut);
    const env = await handleExtract(
      { text: "foo happened 4 times", schema: simpleSchema, frame: "how often does foo happen?" },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect(env.result.data).toEqual({ name: "foo", count: 4 });
    expect(env.result.frame_alignment).toEqual({
      on_topic: true,
      reason: "the text addresses the asked-about question",
    });
    expect(client.lastGenerate?.prompt ?? "").toContain("Frame: how often does foo happen?");
  });

  it("frame supplied + model says on_topic:false → frame_alignment.on_topic is false", async () => {
    const modelOut = JSON.stringify({
      _frame_alignment: { on_topic: false, reason: "source is about a different topic entirely" },
    });
    const client = new MockClient(modelOut);
    const env = await handleExtract(
      { text: "unrelated material", schema: simpleSchema, frame: "what is the deadline?" },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect(env.result.frame_alignment?.on_topic).toBe(false);
    expect(env.result.frame_alignment?.reason).toContain("different topic");
    // The lifted _frame_alignment key should NOT remain on data.
    expect("_frame_alignment" in env.result.data).toBe(false);
  });

  it("frame supplied + malformed _frame_alignment → frame_alignment undefined + warning", async () => {
    const modelOut = JSON.stringify({
      name: "foo",
      _frame_alignment: "this is a string not an object",
    });
    const client = new MockClient(modelOut);
    const env = await handleExtract(
      { text: "anything", schema: simpleSchema, frame: "some frame" },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect(env.result.frame_alignment).toBeUndefined();
    expect(env.warnings?.some((w) => w.includes("_frame_alignment"))).toBe(true);
    // The malformed key is dropped from data.
    expect("_frame_alignment" in env.result.data).toBe(false);
  });

  it("frame supplied + unaddressed_aspects array → passes through to frame_alignment", async () => {
    const modelOut = JSON.stringify({
      _frame_alignment: {
        on_topic: false,
        reason: "off-topic",
        unaddressed_aspects: ["evidence chain", "inspectability"],
      },
    });
    const client = new MockClient(modelOut);
    const env = await handleExtract(
      { text: "x", schema: simpleSchema, frame: "evidence custody question" },
      makeCtx(client),
    );
    if (!("data" in env.result)) throw new Error("expected success shape");
    expect(env.result.frame_alignment?.unaddressed_aspects).toEqual([
      "evidence chain",
      "inspectability",
    ]);
  });
});

describe("handleExtract — per-call model override (v2.3.0)", () => {
  it("input.model is passed to the underlying Ollama generate call", async () => {
    const client = new MockClient(JSON.stringify({ name: "x" }));
    const env = await handleExtract(
      { text: "anything", schema: simpleSchema, model: "hermes3:8b-q5_K_M" },
      makeCtx(client),
    );
    expect(client.lastGenerate?.model).toBe("hermes3:8b-q5_K_M");
    expect(env.model).toBe("hermes3:8b-q5_K_M");
    expect(env.model_requested).toBe("hermes3:8b-q5_K_M");
  });

  it("input.model omitted falls through to tier-resolved workhorse model", async () => {
    const client = new MockClient(JSON.stringify({ name: "x" }));
    const env = await handleExtract(
      { text: "anything", schema: simpleSchema },
      makeCtx(client),
    );
    expect(client.lastGenerate?.model).toBe(PROFILES["dev-rtx5080"].tiers.workhorse);
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.workhorse);
    expect(env.model_requested).toBeUndefined();
  });

  it('input.model "" (empty) throws ZodError at schema parse', () => {
    expect(() =>
      extractSchema.parse({ text: "x", schema: {}, model: "" }),
    ).toThrow();
  });

  it('input.model "   " (whitespace) throws ZodError at schema parse', () => {
    expect(() =>
      extractSchema.parse({ text: "x", schema: {}, model: "   " }),
    ).toThrow();
  });
});
