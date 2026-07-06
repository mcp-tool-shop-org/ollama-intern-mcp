/**
 * ollama_chat tests — minimum coverage for the last-resort tool.
 *
 * Pre-v2.3.0 chat had no dedicated test file; the per-call model override
 * feature is what drove these. Tests focus on the model-resolution contract
 * (override threading, tier fallback when omitted, schema strictness on
 * empty/whitespace overrides). The chat handler does not engage the timeout
 * fallback cascade, so semantics for "override + fallback" don't apply
 * here — that's exercised in the runner-backed atoms.
 *
 * MIGRATION (FT-003 / Phase 7): replaced the in-file MockClient and
 * makeCtx boilerplate with the shared `createFakeOllama` + `makeFakeCtx`
 * helpers from tests/_helpers/. Behavior under test is unchanged; only
 * boilerplate is reduced.
 */

import { describe, it, expect } from "vitest";
import { handleChat, chatSchema } from "../../src/tools/chat.js";
import { PROFILES } from "../../src/profiles.js";
import { createFakeOllama, makeFakeCtx } from "../_helpers/index.js";
import { RoutingOllamaClient } from "../../src/routing.js";
import type { Tier, TierConfig } from "../../src/tiers.js";

describe("handleChat — baseline", () => {
  it("returns reply + last_resort marker", async () => {
    const client = createFakeOllama({
      chatImpl: async (req) => ({
        model: req.model,
        message: { role: "assistant", content: "hello back" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });
    const env = await handleChat(
      { messages: [{ role: "user", content: "hello" }] },
      makeFakeCtx({ client }),
    );
    expect(env.result.reply).toBe("hello back");
    expect(env.result.last_resort).toBe(true);
    expect(env.tier_used).toBe("workhorse");
  });
});

describe("handleChat — thinking suppression + output budget (v2.7.3)", () => {
  it("passes think=false and num_predict=4096 to the underlying chat call", async () => {
    const client = createFakeOllama({
      chatImpl: async (req) => ({
        model: req.model,
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });
    await handleChat({ messages: [{ role: "user", content: "hi" }] }, makeFakeCtx({ client }));
    // Regression guard for the 2026-06-09 cloud incident: chat was the only
    // generate-shaped tool not passing `think`, so a thinking cloud model
    // burned the whole (then-1024) num_predict on CoT and replied "".
    expect(client.lastChat?.think).toBe(false);
    expect(client.lastChat?.options?.num_predict).toBe(4096);
  });
});

describe("handleChat — per-call model override (v2.3.0)", () => {
  it("input.model is passed to the underlying Ollama chat call", async () => {
    const client = createFakeOllama({
      chatImpl: async (req) => ({
        model: req.model,
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });
    const env = await handleChat(
      {
        messages: [{ role: "user", content: "hi" }],
        model: "hermes3:8b-q5_K_M",
      },
      makeFakeCtx({ client }),
    );
    expect(client.lastChat?.model).toBe("hermes3:8b-q5_K_M");
    expect(env.model).toBe("hermes3:8b-q5_K_M");
    expect(env.model_requested).toBe("hermes3:8b-q5_K_M");
  });

  it("input.model omitted falls through to tier-resolved workhorse model", async () => {
    const client = createFakeOllama({
      chatImpl: async (req) => ({
        model: req.model,
        message: { role: "assistant", content: "ok" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });
    const env = await handleChat(
      { messages: [{ role: "user", content: "hi" }] },
      makeFakeCtx({ client }),
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

describe("handleChat — routing seam + tier-bounded timeout (H4)", () => {
  it("passes tier='workhorse' and a live tier-bounded AbortSignal into the chat call", async () => {
    let capturedTier: string | undefined;
    let capturedSignal: AbortSignal | undefined;
    const client = createFakeOllama({
      chatImpl: async (req, signal, tier) => {
        capturedTier = tier;
        capturedSignal = signal;
        return {
          model: req.model,
          message: { role: "assistant", content: "ok" },
          done: true,
          prompt_eval_count: 1,
          eval_count: 1,
        };
      },
    });
    await handleChat({ messages: [{ role: "user", content: "hi" }] }, makeFakeCtx({ client }));
    // Was undefined → cloud-primary routing served local unconditionally.
    expect(capturedTier).toBe("workhorse");
    // Was undefined → a wedged model held a semaphore permit un-timed despite
    // the schema claiming a timeout. Now a real, un-aborted signal is passed.
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("routes to cloud (not local) and lifts backend provenance onto the envelope", async () => {
    const cloudTiers: TierConfig = {
      instant: "cloud-m",
      workhorse: "cloud-m",
      deep: "cloud-m",
      embed: "nomic-embed-text",
    };
    const localTiers: TierConfig = {
      instant: "local-m",
      workhorse: "local-m",
      deep: "local-m",
      embed: "nomic-embed-text",
    };
    const cloudTimeouts: Record<Tier, number> = {
      instant: 30_000,
      workhorse: 120_000,
      deep: 300_000,
      embed: 10_000,
    };
    const cloud = createFakeOllama({
      chatImpl: async (req) => ({
        model: req.model,
        message: { role: "assistant", content: "from cloud" },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    });
    const local = createFakeOllama({
      chatImpl: async (req) => ({
        model: req.model,
        message: { role: "assistant", content: "from local" },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }),
    });
    const routing = new RoutingOllamaClient({ cloud, local, cloudTiers, localTiers, cloudTimeouts });
    const env = await handleChat(
      { messages: [{ role: "user", content: "hi" }] },
      makeFakeCtx({ client: routing }),
    );
    // With a tier now passed, routing reaches cloud instead of serving local.
    expect(env.result.reply).toBe("from cloud");
    expect((env as unknown as { backend?: string }).backend).toBe("cloud");
  });
});
