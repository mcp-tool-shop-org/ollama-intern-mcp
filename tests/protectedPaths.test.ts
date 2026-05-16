import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// ═══════════════════════════════════════════════════════════════
// Regression: Windows case-insensitive protected-path matching
// (paired with src/protectedPaths.ts normalize-on-win32 fix)
//
// On NTFS (case-insensitive), "Memory/foo.md" and "MEMORY/foo.md"
// are the same path as "memory/foo.md". Before the fix,
// normalizePath() preserved input case unconditionally so the
// "memory/" rule matched only the lowercase form, leaving the
// upper/mixed-case variants as silent bypasses for ollama_draft.
//
// stubGlobal("process", ...) lets us drive the platform branch on
// any host OS — these tests stay deterministic on Linux CI.
// ═══════════════════════════════════════════════════════════════

describe("normalizePath / matchesProtectedPath — Windows case-insensitive guard", () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    vi.unstubAllGlobals();
  });

  function stubPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p, configurable: true });
  }

  it("[win32] normalizePath lowercases input so mixed/upper-case match lowercase rules", () => {
    stubPlatform("win32");
    expect(normalizePath("Memory/foo.md")).toBe("memory/foo.md");
    expect(normalizePath("MEMORY/foo.md")).toBe("memory/foo.md");
    expect(normalizePath(".Claude/x.md")).toBe(".claude/x.md");
    expect(normalizePath(".CLAUDE/x.md")).toBe(".claude/x.md");
  });

  it("[win32] matchesProtectedPath catches mixed-case Memory/ and .Claude/", () => {
    stubPlatform("win32");
    expect(matchesProtectedPath("Memory/foo.md").protected).toBe(true);
    expect(matchesProtectedPath("MEMORY/foo.md").protected).toBe(true);
    expect(matchesProtectedPath(".Claude/x.md").protected).toBe(true);
    expect(matchesProtectedPath(".CLAUDE/rules.md").protected).toBe(true);
    expect(matchesProtectedPath("subdir/MEMORY/x.md").protected).toBe(true);
    expect(matchesProtectedPath("subdir/.Claude/x.md").protected).toBe(true);
  });

  it("[win32] exact-file rules also match case-insensitively (license, security.md, MEMORY.MD)", () => {
    stubPlatform("win32");
    expect(matchesProtectedPath("license").protected).toBe(true);
    expect(matchesProtectedPath("LICENSE").protected).toBe(true);
    expect(matchesProtectedPath("LiCeNsE").protected).toBe(true);
    expect(matchesProtectedPath("MEMORY.MD").protected).toBe(true);
    expect(matchesProtectedPath("memory.md").protected).toBe(true);
    expect(matchesProtectedPath("Security.md").protected).toBe(true);
  });

  it("[posix] case is preserved (matches POSIX filesystem semantics)", () => {
    stubPlatform("linux");
    // On POSIX, Memory/foo.md and memory/foo.md are DIFFERENT paths —
    // case is preserved by normalizePath, and the lowercase rule does
    // not match the upper-case input. This is correct behavior; an
    // attacker can't bypass on POSIX because the upper-case directory
    // simply does not exist (or is a separate, unprotected one).
    expect(normalizePath("Memory/foo.md")).toBe("Memory/foo.md");
    expect(normalizePath(".Claude/x.md")).toBe(".Claude/x.md");
    expect(matchesProtectedPath("Memory/foo.md").protected).toBe(false);
    expect(matchesProtectedPath(".Claude/x.md").protected).toBe(false);
    // But the canonical lowercase form still matches:
    expect(matchesProtectedPath("memory/foo.md").protected).toBe(true);
  });
});
