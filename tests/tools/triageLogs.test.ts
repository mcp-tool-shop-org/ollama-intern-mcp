import { describe, it, expect } from "vitest";
import {
  triageLogsSchema,
  MAX_LOG_TEXT_BYTES,
} from "../../src/tools/triageLogs.js";

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
