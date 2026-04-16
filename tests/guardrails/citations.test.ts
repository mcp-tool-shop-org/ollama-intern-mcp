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
