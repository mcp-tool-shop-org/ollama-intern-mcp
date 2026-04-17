import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { strictStringArray } from "../../src/guardrails/stringifiedArrayGuard.js";

describe("strictStringArray — happy path", () => {
  it("accepts a single-element array of strings", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse(["a.md"]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(["a.md"]);
  });

  it("accepts a multi-element array of strings", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse(["a.md", "b.md", "c.md"]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("enforces min length", () => {
    const schema = strictStringArray({ min: 2, fieldName: "labels" });
    const result = schema.safeParse(["only-one"]);
    expect(result.success).toBe(false);
  });

  it("enforces max length", () => {
    const schema = strictStringArray({ min: 1, max: 2, fieldName: "labels" });
    const result = schema.safeParse(["a", "b", "c"]);
    expect(result.success).toBe(false);
  });

  it("rejects empty-string items by default (minItemLen=1)", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse([""]);
    expect(result.success).toBe(false);
  });

  it("allows empty-string items when minItemLen=0", () => {
    const schema = strictStringArray({ min: 0, minItemLen: 0, fieldName: "patterns" });
    const result = schema.safeParse(["", "something"]);
    expect(result.success).toBe(true);
  });

  it("accepts an empty array when min=0", () => {
    const schema = strictStringArray({ min: 0, minItemLen: 0, fieldName: "patterns" });
    const result = schema.safeParse([]);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it("works when wrapped in .optional()", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" }).optional();
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse(["a.md"]).success).toBe(true);
  });
});

describe("strictStringArray — stringified-array diagnostic", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("rejects a JSON-stringified single-element array with a specific diagnostic", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse('["a.md"]');
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).toContain("Stringified array detected");
      expect(msg).toContain("source_paths");
      expect(msg).toContain("fix the caller, not the server");
      expect(msg).toContain('["a.md"]');
    }
  });

  it("rejects a JSON-stringified multi-element array with a specific diagnostic", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse('["a.md","b.md"]');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Stringified array detected");
    }
  });

  it("emits a stderr warning tagged for grep when a string arrives", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    schema.safeParse('["a.md"]');
    expect(errSpy).toHaveBeenCalledOnce();
    const firstArg = errSpy.mock.calls[0][0] as string;
    expect(firstArg).toContain("[ollama-intern:stringified-array-guard]");
    expect(firstArg).toContain("field=source_paths");
    expect(firstArg).toContain("received=string");
    expect(firstArg).toContain("looks_like_json_array=true");
  });

  it("gives a different hint when the string does not look like a JSON array", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse("just-a-plain-string");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).not.toContain("Stringified array detected");
      expect(msg).toContain('Wrap single values as an array');
      expect(msg).toContain("source_paths");
    }
  });

  it("records looks_like_json_array=false in stderr when the string is not JSON-shaped", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    schema.safeParse("just-a-plain-string");
    expect(errSpy).toHaveBeenCalledOnce();
    const firstArg = errSpy.mock.calls[0][0] as string;
    expect(firstArg).toContain("looks_like_json_array=false");
  });

  it("truncates long string previews to 80 chars with an ellipsis", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const longArr = "[" + Array(100).fill('"x.md"').join(",") + "]";
    const result = schema.safeParse(longArr);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).toContain("...");
    }
  });

  it("does NOT silently coerce — data is never parsed", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse('["a.md"]');
    expect(result.success).toBe(false);
  });
});

describe("strictStringArray — non-string, non-array input", () => {
  it("rejects numbers with zod's normal messaging", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse(123);
    expect(result.success).toBe(false);
  });

  it("rejects objects", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse({ a: "b" });
    expect(result.success).toBe(false);
  });

  it("rejects array of non-strings", () => {
    const schema = strictStringArray({ min: 1, fieldName: "source_paths" });
    const result = schema.safeParse([1, 2, 3]);
    expect(result.success).toBe(false);
  });
});

describe("strictStringArray — z.object integration (real MCP schema shape)", () => {
  it("produces the exact same success shape as z.array(z.string())", () => {
    const strictVersion = z.object({
      question: z.string(),
      source_paths: strictStringArray({ min: 1, fieldName: "source_paths" }),
    });
    const result = strictVersion.safeParse({
      question: "q",
      source_paths: ["a.md"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ question: "q", source_paths: ["a.md"] });
    }
  });

  it("fails with clear field path when embedded in a larger object schema", () => {
    const schema = z.object({
      question: z.string(),
      source_paths: strictStringArray({ min: 1, fieldName: "source_paths" }),
    });
    const result = schema.safeParse({ question: "q", source_paths: '["a.md"]' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.path).toContain("source_paths");
      expect(issue.message).toContain("Stringified array detected");
    }
  });
});
