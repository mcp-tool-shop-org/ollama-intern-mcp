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
