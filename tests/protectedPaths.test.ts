import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  matchesProtectedPath,
  normalizePath,
  PROTECTED_PATHS,
  PROTECTED_PATHS_VERSION,
} from "../src/protectedPaths.js";
import { checkWriteConfirm } from "../src/guardrails/writeConfirm.js";

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

  it("[linux] case is preserved (case-SENSITIVE POSIX filesystem)", () => {
    stubPlatform("linux");
    // On case-sensitive Linux, Memory/foo.md and memory/foo.md are DIFFERENT
    // paths — case is preserved and the lowercase rule doesn't match the
    // upper-case input. Correct here: the upper-case dir is a separate,
    // unprotected one. (darwin is POSIX too but case-INSENSITIVE — see below.)
    expect(normalizePath("Memory/foo.md")).toBe("Memory/foo.md");
    expect(normalizePath(".Claude/x.md")).toBe(".Claude/x.md");
    expect(matchesProtectedPath("Memory/foo.md").protected).toBe(false);
    expect(matchesProtectedPath(".Claude/x.md").protected).toBe(false);
    // But the canonical lowercase form still matches:
    expect(matchesProtectedPath("memory/foo.md").protected).toBe(true);
  });

  it("[darwin] catches every case variant — APFS is case-insensitive (M3 bypass)", () => {
    stubPlatform("darwin");
    // macOS's default APFS volume is case-insensitive/case-preserving, so
    // "Memory/x" IS the protected "memory/" file. Before the fix, normalizePath
    // only lowercased on win32, leaving these as silent bypasses of the
    // confirm_write gate on the project's own declared m5-max prod target.
    expect(normalizePath("Memory/foo.md")).toBe("memory/foo.md");
    expect(matchesProtectedPath("Memory/foo.md").protected).toBe(true);
    expect(matchesProtectedPath("MEMORY.MD").protected).toBe(true);
    expect(matchesProtectedPath(".CLAUDE/rules.md").protected).toBe(true);
    expect(matchesProtectedPath("docs/CANON/x.md").protected).toBe(true);
    expect(matchesProtectedPath("subdir/.Claude/x.md").protected).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// F-a488b136: Win32 trailing-dot / trailing-space aliases.
//
// CreateFile strips trailing dots and spaces from each path component
// unless a \\?\ prefix is used. Without the same strip in normalizePath,
// 'SECURITY.md.', 'SECURITY.md ', 'memory./x.md', and '.git./config'
// miss matchesProtectedPath while the OS still writes the protected file.
// Mutate normalizePath to drop the strip and these cases go RED.
// ═══════════════════════════════════════════════════════════════

describe("normalizePath / matchesProtectedPath / checkWriteConfirm — Win32 trailing-dot/space aliases", () => {
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

  function expectProtectedAndBlocked(path: string): void {
    expect(matchesProtectedPath(path).protected, `matchesProtectedPath(${JSON.stringify(path)})`).toBe(true);
    expect(
      checkWriteConfirm({ target_path: path, confirm_write: false }).blocked,
      `checkWriteConfirm(${JSON.stringify(path)})`,
    ).toBe(true);
  }

  it("[win32] named aliases SECURITY.md. / SECURITY.md  / memory./x.md / .git./config are protected+blocked", () => {
    stubPlatform("win32");
    expectProtectedAndBlocked("SECURITY.md.");
    expectProtectedAndBlocked("SECURITY.md ");
    expectProtectedAndBlocked("memory./x.md");
    expectProtectedAndBlocked(".git./config");
  });

  it("[win32] ADS ::$DATA / :stream and 8.3 ~N aliases are protected+blocked (F-586c4962)", () => {
    stubPlatform("win32");
    expectProtectedAndBlocked("SECURITY.md::$DATA");
    expectProtectedAndBlocked("SECURITY.md:stream");
    expectProtectedAndBlocked("SECURI~1.MD");
    expectProtectedAndBlocked("MEMORY~1/x.md");
  });

  it("[win32] trailing-dot and trailing-space aliases of every exact-file and directory rule", () => {
    stubPlatform("win32");
    expect(PROTECTED_PATHS.length).toBeGreaterThan(0);
    for (const rule of PROTECTED_PATHS) {
      if (rule.pattern.endsWith("/")) {
        const dir = rule.pattern.slice(0, -1);
        for (const alias of [`${dir}./x.md`, `${dir} /x.md`, `sub/${dir}./x.md`]) {
          expectProtectedAndBlocked(alias);
        }
      } else {
        for (const alias of [`${rule.pattern}.`, `${rule.pattern} `, `sub/${rule.pattern}.`, `sub/${rule.pattern} `]) {
          expectProtectedAndBlocked(alias);
        }
      }
    }
  });
});
