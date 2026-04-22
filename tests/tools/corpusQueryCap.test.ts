/**
 * Stage B+C — corpus_query cap / sanitization.
 *
 * Locks the _helpers normalizer contract:
 *   - Queries under the cap are accepted (with fences/newlines stripped)
 *   - Queries whose cleaned form exceeds MAX_CORPUS_QUERY_CHARS refuse
 *     with SCHEMA_INVALID and an actionable hint
 *   - undefined input passes through unchanged
 */

import { describe, it, expect } from "vitest";
import { normalizeCorpusQuery, MAX_CORPUS_QUERY_CHARS } from "../../src/tools/_helpers.js";

describe("normalizeCorpusQuery", () => {
  it("passes undefined through", () => {
    expect(normalizeCorpusQuery(undefined)).toBeUndefined();
  });

  it("accepts a short query verbatim (whitespace trimmed)", () => {
    expect(normalizeCorpusQuery("   hello world  ")).toBe("hello world");
  });

  it("strips code fences and newlines from an otherwise valid query", () => {
    const raw = "```ts\nincident\nretry\n```";
    const out = normalizeCorpusQuery(raw);
    expect(out).toBeDefined();
    expect(out).not.toContain("```");
    expect(out).not.toContain("\n");
    expect(out).toBe("ts incident retry");
  });

  it("rejects queries that exceed the cap after cleaning", () => {
    const over = "a ".repeat(MAX_CORPUS_QUERY_CHARS); // space-separated to survive whitespace collapse
    expect(() => normalizeCorpusQuery(over)).toThrow(/exceeds 200 chars/);
  });

  it("throws a SCHEMA_INVALID InternError with an actionable hint", () => {
    try {
      normalizeCorpusQuery("x".repeat(MAX_CORPUS_QUERY_CHARS + 50));
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as { code?: string; hint?: string; message?: string };
      expect(e.code).toBe("SCHEMA_INVALID");
      expect(e.hint ?? "").toMatch(/log_text|shorter|shorten/i);
    }
  });

  it("exposes MAX_CORPUS_QUERY_CHARS = 200", () => {
    expect(MAX_CORPUS_QUERY_CHARS).toBe(200);
  });
});
