import { describe, it, expect } from "vitest";
import { handleDraft } from "../../src/tools/draft.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
import { InternError } from "../../src/errors.js";
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

/** Queue-based mock that returns successive responses from a list. */
class QueueClient implements OllamaClient {
  public callCount = 0;
  constructor(private responses: string[]) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const idx = Math.min(this.callCount, this.responses.length - 1);
    this.callCount += 1;
    return {
      model: req.model,
      response: this.responses[idx],
      done: true,
      prompt_eval_count: 20,
      eval_count: 10,
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

describe("handleDraft — default (no style=doc)", () => {
  it("does NOT run the banned-phrase check when style is unset", async () => {
    const client = new QueueClient(["this leverages seamless effortless synergy"]);
    const env = await handleDraft({ prompt: "write something" }, makeCtx(client));
    expect(env.result.draft).toContain("seamless");
    expect(env.result.regenerations_triggered).toBeUndefined();
    expect(client.callCount).toBe(1);
  });

  it("does NOT run the banned-phrase check when style=concise", async () => {
    const client = new QueueClient(["blazing fast cutting-edge solution"]);
    const env = await handleDraft(
      { prompt: "write something", style: "concise" },
      makeCtx(client),
    );
    expect(env.result.draft).toContain("blazing fast");
    expect(env.result.regenerations_triggered).toBeUndefined();
    expect(client.callCount).toBe(1);
  });
});

describe("handleDraft — style=doc banned-phrase rejection", () => {
  it("passes clean prose on the first attempt, no regenerations flagged", async () => {
    const client = new QueueClient([
      "The module reads UTF-8, validates against schema, emits an envelope.",
    ]);
    const env = await handleDraft(
      { prompt: "describe the module", style: "doc" },
      makeCtx(client),
    );
    expect(env.result.draft).toContain("envelope");
    expect(env.result.regenerations_triggered).toBeUndefined();
    expect(env.result.detected_phrases).toBeUndefined();
    expect(client.callCount).toBe(1);
  });

  it("regenerates once when the first attempt contains a banned phrase, then succeeds", async () => {
    const client = new QueueClient([
      "Our seamless integration enables...",
      "Parses NDJSON events and writes them to SQLite.",
    ]);
    const env = await handleDraft(
      { prompt: "describe the logger", style: "doc" },
      makeCtx(client),
    );
    expect(env.result.draft).toContain("SQLite");
    expect(env.result.regenerations_triggered).toBe(1);
    expect(env.result.detected_phrases).toContain("seamless");
    expect(client.callCount).toBe(2);
  });

  it("regenerates twice when the first two attempts both contain banned phrases, then succeeds", async () => {
    const client = new QueueClient([
      "Seamless and effortless flow.",
      "We leverage the cache.",
      "The module caches the last 10 responses.",
    ]);
    const env = await handleDraft(
      { prompt: "describe caching", style: "doc" },
      makeCtx(client),
    );
    expect(env.result.draft).toContain("caches the last 10 responses");
    expect(env.result.regenerations_triggered).toBe(2);
    expect(env.result.detected_phrases).toContain("seamless");
    expect(env.result.detected_phrases).toContain("effortless");
    expect(env.result.detected_phrases?.some((p) => p.toLowerCase() === "leverage")).toBe(true);
    expect(client.callCount).toBe(3);
  });

  it("throws DRAFT_BANNED_PHRASE with detected phrases in hint after MAX_ATTEMPTS", async () => {
    const client = new QueueClient([
      "Blazing fast performance.",
      "Effortless and seamless.",
      "Leverage our robust platform.",
      // Fourth would be clean but we should never reach it — MAX_ATTEMPTS=3.
      "Parses NDJSON.",
    ]);
    let caught: InternError | null = null;
    try {
      await handleDraft(
        { prompt: "pitch the product", style: "doc" },
        makeCtx(client),
      );
    } catch (err) {
      caught = err as InternError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("DRAFT_BANNED_PHRASE");
    expect(caught!.message).toMatch(/after 3 attempts/);
    expect(caught!.hint).toContain("falsifiable");
    expect(caught!.retryable).toBe(true);
    expect(client.callCount).toBe(3);
  });

  it("does not duplicate entries in detected_phrases when the same phrase appears multiple times", async () => {
    const client = new QueueClient([
      "seamless seamless seamless",
      "A concrete description of the feature.",
    ]);
    const env = await handleDraft(
      { prompt: "describe", style: "doc" },
      makeCtx(client),
    );
    const count = env.result.detected_phrases?.filter((p) => p === "seamless").length ?? 0;
    expect(count).toBe(1);
  });

  it("logs a guardrail event on each regeneration and on final block", async () => {
    const client = new QueueClient([
      "seamless",
      "effortless",
      "leverage",
    ]);
    const logger = new NullLogger();
    try {
      await handleDraft(
        { prompt: "pitch", style: "doc" },
        makeCtx(client, logger),
      );
    } catch {
      // expected
    }
    const guardrailEvents = logger.events.filter((e) => e.kind === "guardrail");
    // 2 regenerated + 1 blocked = 3 guardrail events (plus the 3 call events)
    const regenerated = guardrailEvents.filter((e) => (e as { action?: string }).action === "regenerated");
    const blocked = guardrailEvents.filter((e) => (e as { action?: string }).action === "blocked");
    expect(regenerated.length).toBe(2);
    expect(blocked.length).toBe(1);
  });
});
