import { describe, it, expect } from "vitest";
import {
  matchesProtectedPath,
  normalizePath,
  PROTECTED_PATHS,
  PROTECTED_PATHS_VERSION,
} from "../src/protectedPaths.js";

describe("normalizePath", () => {
  it("replaces backslashes with forward slashes", () => {
    expect(normalizePath("a\\b\\c")).toBe("a/b/c");
  });
  it("strips leading ./", () => {
    expect(normalizePath("./foo/bar")).toBe("foo/bar");
  });
});

describe("matchesProtectedPath", () => {
  it("version is an integer that can be bumped", () => {
    expect(Number.isInteger(PROTECTED_PATHS_VERSION)).toBe(true);
    expect(PROTECTED_PATHS).toBeInstanceOf(Array);
    expect(PROTECTED_PATHS.length).toBeGreaterThan(0);
  });

  it("matches top-level protected dir", () => {
    expect(matchesProtectedPath("memory/x.md").protected).toBe(true);
  });

  it("matches nested protected dir", () => {
    expect(matchesProtectedPath("repo/.claude/rules.md").protected).toBe(true);
    expect(matchesProtectedPath("subdir/memory/x.md").protected).toBe(true);
  });

  it("does not match similar-looking but unprotected paths", () => {
    expect(matchesProtectedPath("src/memory_helpers.ts").protected).toBe(false);
    expect(matchesProtectedPath("docs/canonical.md").protected).toBe(false);
  });

  it("matches exact-file rules anywhere in a subtree", () => {
    expect(matchesProtectedPath("LICENSE").protected).toBe(true);
    expect(matchesProtectedPath("sub/LICENSE").protected).toBe(true);
    expect(matchesProtectedPath("LICENSE.txt").protected).toBe(false);
  });

  it("rule returned includes reason", () => {
    const r = matchesProtectedPath("memory/x.md");
    expect(r.rule?.reason).toMatch(/memory/i);
  });
});
