import { describe, it, expect } from "vitest";
import { detectCoverage } from "../src/coverage.js";
import type { LoadedSource } from "../src/sources.js";

function src(path: string, body: string): LoadedSource {
  return { path, body };
}

describe("detectCoverage", () => {
  it("marks all sources covered when the output mentions their filename stems", () => {
    const sources = [
      src("docs/commandui.md", "CommandUI is a Tauri shell with React 19 frontend."),
      src("docs/hardware-m5-max.md", "The M5 Max MacBook Pro has 128GB unified memory."),
    ];
    const output = "CommandUI v1.0.0 ships via GitHub Releases. The M5 Max arrives with 128GB unified memory.";
    const r = detectCoverage(output, sources);
    expect(r.covered_sources).toEqual(sources.map((s) => s.path));
    expect(r.omitted_sources).toEqual([]);
  });

  it("flags a two-file input where the summary only covers the first (the real adoption-pass bug)", () => {
    const sources = [
      src("docs/commandui.md", "CommandUI is a Tauri shell with React 19 frontend. Scoop bucket. winget PR. Microsoft Store MSIX."),
      src("docs/hardware-m5-max.md", "The M5 Max MacBook Pro has 128GB unified memory, 40-core GPU, arriving 2026-04-24."),
    ];
    // Summary that only covers the first file — the observed failure.
    const output = "CommandUI v1.0.0 shipped via GitHub Releases, Scoop, winget, and Microsoft Store. Tauri v2 + React 19 monorepo.";
    const r = detectCoverage(output, sources);
    expect(r.covered_sources).toContain("docs/commandui.md");
    expect(r.omitted_sources).toContain("docs/hardware-m5-max.md");
    // Coverage note must surface for multi-source omission.
    expect(r.coverage_notes.length).toBeGreaterThan(0);
    expect(r.coverage_notes[0]).toMatch(/omitted.*1 of 2/i);
  });

  it("treats a source as covered when explicitly cited (research citations path)", () => {
    const sources = [
      src("a.md", "alpha content zzzquax"),
      src("b.md", "beta content yyypendax"),
    ];
    // Output mentions neither distinctive token, BUT citations claim both.
    const output = "Some answer that uses neither source's vocabulary directly.";
    const r = detectCoverage(output, sources, { explicitlyCovered: ["a.md", "b.md"] });
    expect(r.covered_sources.sort()).toEqual(["a.md", "b.md"]);
    expect(r.omitted_sources).toEqual([]);
  });

  it("normalizes paths for explicit-coverage comparison (backslash vs forward-slash)", () => {
    const sources = [src("docs/foo.md", "alpha zzzquax")];
    const r = detectCoverage("unrelated output", sources, {
      explicitlyCovered: ["docs\\foo.md"], // backslash-style path from Windows
    });
    expect(r.covered_sources).toEqual(["docs/foo.md"]);
  });

  it("returns no coverage notes when single-source omission (no multi-source omission warning)", () => {
    const sources = [src("only.md", "distinctive content about quantized models")];
    const output = "An answer with no overlap at all.";
    const r = detectCoverage(output, sources);
    expect(r.omitted_sources).toContain("only.md");
    // With only one source, we skip the "omitted N of M" multi-source note.
    expect(r.coverage_notes.some((n) => /omitted.*of/i.test(n))).toBe(false);
  });

  it("filename stem alone is enough signal when body is short", () => {
    const sources = [src("docs/quirkname.md", "the quirkname file.")];
    const r = detectCoverage("We discussed quirkname extensively.", sources);
    expect(r.covered_sources).toEqual(["docs/quirkname.md"]);
  });

  it("is case-insensitive on token matching", () => {
    const sources = [src("docs/foo.md", "distinctive TokenQuirky content here")];
    const r = detectCoverage("The output mentions TOKENQUIRKY once.", sources);
    expect(r.covered_sources).toEqual(["docs/foo.md"]);
  });
});
