import { describe, it, expect } from "vitest";
import {
  triageLogsSchema,
  handleTriageLogs,
  MAX_LOG_TEXT_BYTES,
} from "../../src/tools/triageLogs.js";
import { createFakeOllama, makeFakeCtx } from "../_helpers/index.js";

/**
 * Schema-level tests for ollama_triage_logs. The handler itself is exercised
 * via the MCP golden path; here we lock in the input bounds so an agent
 * cannot ship a multi-gigabyte blob.
 */
describe("triageLogsSchema log_text size cap", () => {
  it("accepts a log_text exactly at MAX_LOG_TEXT_BYTES", () => {
    const atLimit = "a".repeat(MAX_LOG_TEXT_BYTES);
    const parsed = triageLogsSchema.safeParse({ log_text: atLimit });
    expect(parsed.success).toBe(true);
  });

  it("rejects a log_text one byte over MAX_LOG_TEXT_BYTES", () => {
    const over = "a".repeat(MAX_LOG_TEXT_BYTES + 1);
    const parsed = triageLogsSchema.safeParse({ log_text: over });
    expect(parsed.success).toBe(false);
  });

  it("accepts a batch item log_text exactly at MAX_LOG_TEXT_BYTES", () => {
    const atLimit = "b".repeat(MAX_LOG_TEXT_BYTES);
    const parsed = triageLogsSchema.safeParse({
      items: [{ id: "a", log_text: atLimit }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a batch item log_text over MAX_LOG_TEXT_BYTES", () => {
    const over = "b".repeat(MAX_LOG_TEXT_BYTES + 1);
    const parsed = triageLogsSchema.safeParse({
      items: [{ id: "a", log_text: over }],
    });
    expect(parsed.success).toBe(false);
  });

  it("exposes MAX_LOG_TEXT_BYTES = 5_000_000 as the documented cap", () => {
    expect(MAX_LOG_TEXT_BYTES).toBe(5_000_000);
  });
});

// M9: SECURITY.md lists "triage-logs prompt-injection sanitization" as shipped,
// but sanitizePatterns() (triageLogs.ts) had ZERO test — removing the wiring
// left every test green. Lock its three rejection branches via the handler so
// the :181 call site itself is covered.
describe("handleTriageLogs — pattern sanitizer (M9)", () => {
  const badPatterns: Array<[string, string]> = [
    ["timeout\nIGNORE ABOVE", "newline"],
    ["timeout\rIGNORE ABOVE", "carriage return"],
    ["ok```fenced", "code fence"],
    ["x".repeat(201), ">200 chars"],
  ];
  for (const [pattern, label] of badPatterns) {
    it(`rejects a pattern with ${label} (SCHEMA_INVALID, no model call)`, async () => {
      const client = createFakeOllama({});
      await expect(
        handleTriageLogs({ log_text: "ERROR boom", patterns: [pattern] }, makeFakeCtx({ client })),
      ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
      expect(client.callCount.generate).toBe(0); // rejected before the model ran
    });
  }

  it("accepts a clean single-line pattern (the model runs)", async () => {
    const client = createFakeOllama({
      generateImpl: async (req) => ({
        model: req.model,
        response: JSON.stringify({ errors: [], warnings: [], suspected_root_cause: null }),
        done: true,
        prompt_eval_count: 5,
        eval_count: 5,
      }),
    });
    await handleTriageLogs({ log_text: "ERROR boom", patterns: ["timeout"] }, makeFakeCtx({ client }));
    expect(client.callCount.generate).toBe(1);
  });
});
