/**
 * MIGRATED (FT-003 / Phase 7) — uses shared tests/_helpers/ instead of
 * the per-file QueueClient + makeCtx boilerplate. The queue-based
 * sequential-response pattern is preserved by composing `createFakeOllama`
 * with a per-call `generateImpl` that pops from a captured array.
 */
import { describe, it, expect } from "vitest";
import { handleDraft } from "../../src/tools/draft.js";
import { InternError } from "../../src/errors.js";
import type { FakeOllamaClient } from "../_helpers/index.js";
import { createFakeOllama, makeFakeCtx } from "../_helpers/index.js";

/**
 * Construct a fake OllamaClient that returns successive `responses` from
 * an internal queue. Once the queue is exhausted the LAST response is
 * returned repeatedly (matches the legacy QueueClient behavior).
 *
 * Legacy parity: the old QueueClient exposed `callCount` as a flat number.
 * The shared factory exposes a structured `callCount.generate` instead;
 * we expose a `queueCallCount` getter on the returned wrapper so callers
 * can read the simple-number form without shadowing the structured one.
 */
function makeQueue(responses: string[]): FakeOllamaClient & { callCount: number } {
  const state = { count: 0 };
  const client = createFakeOllama({
    generateImpl: async (req) => {
      const idx = Math.min(state.count, responses.length - 1);
      state.count += 1;
      return {
        model: req.model,
        response: responses[idx],
        done: true,
        prompt_eval_count: 20,
        eval_count: 10,
      };
    },
  });
  // Return a Proxy so reads of `.callCount` get the flat number while
  // every other property forwards to the underlying client (including the
  // structured `callCount` on the factory — accessed elsewhere as
  // `client.callCount.generate` is not used in this file's tests).
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "callCount") return state.count;
      return Reflect.get(target, prop);
    },
  }) as FakeOllamaClient & { callCount: number };
}

function makeCtx(client: FakeOllamaClient) {
  return makeFakeCtx({ client });
}

// Re-export for the rare test that needs an explicit logger handle
// (draft has one test that asserts on guardrail events fired off the
// logger handed in). The shared helper builds a fresh NullLogger per
// makeFakeCtx call, so the test grabs `.logger` off the returned ctx.

describe("handleDraft — default (no style=doc)", () => {
  it("does NOT run the banned-phrase check when style is unset", async () => {
    const client = makeQueue(["this leverages seamless effortless synergy"]);
    const env = await handleDraft({ prompt: "write something" }, makeCtx(client));
    expect(env.result.draft).toContain("seamless");
    expect(env.result.regenerations_triggered).toBeUndefined();
    expect(client.callCount).toBe(1);
  });

  it("does NOT run the banned-phrase check when style=concise", async () => {
    const client = makeQueue(["blazing fast cutting-edge solution"]);
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
    const client = makeQueue([
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
    const client = makeQueue([
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
    const client = makeQueue([
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
    const client = makeQueue([
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
    const client = makeQueue([
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
    const client = makeQueue([
      "seamless",
      "effortless",
      "leverage",
    ]);
    const ctx = makeCtx(client);
    try {
      await handleDraft({ prompt: "pitch", style: "doc" }, ctx);
    } catch {
      // expected
    }
    const guardrailEvents = ctx.logger.events.filter((e) => e.kind === "guardrail");
    // 2 regenerated + 1 blocked = 3 guardrail events (plus the 3 call events)
    const regenerated = guardrailEvents.filter((e) => (e as { action?: string }).action === "regenerated");
    const blocked = guardrailEvents.filter((e) => (e as { action?: string }).action === "blocked");
    expect(regenerated.length).toBe(2);
    expect(blocked.length).toBe(1);
  });
});
