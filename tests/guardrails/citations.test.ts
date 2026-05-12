import { describe, it, expect } from "vitest";
import { validateCitations, parseCitations } from "../../src/guardrails/citations.js";

describe("validateCitations", () => {
  it("keeps citations whose path is in allowedPaths", () => {
    const r = validateCitations(
      [{ path: "src/foo.ts", line_range: "1-5" }, { path: "src/bar.ts" }],
      ["src/foo.ts", "src/bar.ts"],
    );
    expect(r.valid).toHaveLength(2);
    expect(r.stripped).toHaveLength(0);
  });

  it("strips citations whose path is not in allowedPaths (hallucination guard)", () => {
    const r = validateCitations(
      [{ path: "src/foo.ts" }, { path: "src/imaginary.ts" }],
      ["src/foo.ts"],
    );
    expect(r.valid).toEqual([{ path: "src/foo.ts" }]);
    expect(r.stripped).toEqual([{ path: "src/imaginary.ts" }]);
  });

  it("normalizes paths before comparing (./ and backslashes)", () => {
    const r = validateCitations(
      [{ path: "./src/foo.ts" }, { path: "src\\bar.ts" }],
      ["src/foo.ts", "src/bar.ts"],
    );
    expect(r.valid).toHaveLength(2);
    expect(r.stripped).toHaveLength(0);
  });

  it("preserves line_range on valid citations, not on stripped", () => {
    const r = validateCitations([{ path: "src/foo.ts", line_range: "10-20" }], ["src/foo.ts"]);
    expect(r.valid[0].line_range).toBe("10-20");
  });

  // ── line_range bounds check (abstention slice) ─────────────

  it("drops line_range when range end exceeds file line count; path is kept", () => {
    const lines = new Map<string, number>([["src/foo.ts", 50]]);
    const r = validateCitations(
      [{ path: "src/foo.ts", line_range: "1-99" }],
      ["src/foo.ts"],
      lines,
    );
    expect(r.valid).toEqual([{ path: "src/foo.ts" }]);
    expect(r.out_of_bounds_ranges).toEqual([
      { path: "src/foo.ts", line_range: "1-99", file_lines: 50 },
    ]);
  });

  it("keeps line_range when range is within file line count", () => {
    const lines = new Map<string, number>([["src/foo.ts", 50]]);
    const r = validateCitations(
      [{ path: "src/foo.ts", line_range: "10-20" }],
      ["src/foo.ts"],
      lines,
    );
    expect(r.valid[0].line_range).toBe("10-20");
    expect(r.out_of_bounds_ranges).toEqual([]);
  });

  it("single-number range past EOF is dropped", () => {
    const lines = new Map<string, number>([["src/foo.ts", 5]]);
    const r = validateCitations(
      [{ path: "src/foo.ts", line_range: "100" }],
      ["src/foo.ts"],
      lines,
    );
    expect(r.valid[0].line_range).toBeUndefined();
    expect(r.out_of_bounds_ranges).toHaveLength(1);
  });

  it("unparseable line_range falls through unchanged (permissive)", () => {
    // Free-form strings the parser can't handle aren't dropped — they
    // surface as-is. Bounds check only fires on numeric "N" or "N-M".
    const lines = new Map<string, number>([["src/foo.ts", 50]]);
    const r = validateCitations(
      [{ path: "src/foo.ts", line_range: "around line 10" }],
      ["src/foo.ts"],
      lines,
    );
    expect(r.valid[0].line_range).toBe("around line 10");
    expect(r.out_of_bounds_ranges).toEqual([]);
  });

  it("no linesByPath → backwards compatible (no bounds check fires)", () => {
    const r = validateCitations(
      [{ path: "src/foo.ts", line_range: "1-99999" }],
      ["src/foo.ts"],
    );
    expect(r.valid[0].line_range).toBe("1-99999");
    expect(r.out_of_bounds_ranges).toEqual([]);
  });
});

describe("parseCitations", () => {
  it("parses path:range style from a Sources block", () => {
    const cites = parseCitations("Sources:\nsrc/foo.ts:10-20\nsrc/bar.ts");
    expect(cites).toContainEqual({ path: "src/foo.ts", line_range: "10-20" });
    expect(cites).toContainEqual({ path: "src/bar.ts" });
  });

  it("skips lines that aren't paths", () => {
    const cites = parseCitations("Sources:\nnothing here\nsrc/foo.ts");
    expect(cites).toEqual([{ path: "src/foo.ts" }]);
  });
});
