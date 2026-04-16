import { describe, it, expect } from "vitest";
import { checkWriteConfirm, assertWriteAllowed } from "../../src/guardrails/writeConfirm.js";
import { PROTECTED_PATHS_VERSION } from "../../src/protectedPaths.js";
import { InternError } from "../../src/errors.js";

describe("checkWriteConfirm", () => {
  it("allows writes with no target_path", () => {
    const r = checkWriteConfirm({ target_path: undefined, confirm_write: false });
    expect(r.blocked).toBe(false);
    expect(r.rules_version).toBe(PROTECTED_PATHS_VERSION);
  });

  it("allows writes to non-protected paths", () => {
    const r = checkWriteConfirm({ target_path: "src/foo.ts", confirm_write: false });
    expect(r.blocked).toBe(false);
  });

  it("blocks writes to memory/ without confirm_write", () => {
    const r = checkWriteConfirm({ target_path: "memory/feedback.md", confirm_write: false });
    expect(r.blocked).toBe(true);
    expect(r.pattern).toBe("memory/");
  });

  it("blocks nested protected paths (e.g. repo/memory/file)", () => {
    const r = checkWriteConfirm({ target_path: "some-repo/memory/thing.md", confirm_write: false });
    expect(r.blocked).toBe(true);
  });

  it("blocks .claude/ writes", () => {
    const r = checkWriteConfirm({ target_path: ".claude/rules/new.md", confirm_write: false });
    expect(r.blocked).toBe(true);
    expect(r.pattern).toBe(".claude/");
  });

  it("blocks docs/canon/ writes", () => {
    const r = checkWriteConfirm({ target_path: "docs/canon/chapter1.md", confirm_write: false });
    expect(r.blocked).toBe(true);
  });

  it("allows protected-path writes when confirm_write is true", () => {
    const r = checkWriteConfirm({ target_path: "memory/feedback.md", confirm_write: true });
    expect(r.blocked).toBe(false);
  });

  it("blocks exact-file protected paths (LICENSE, SECURITY.md)", () => {
    expect(checkWriteConfirm({ target_path: "LICENSE", confirm_write: false }).blocked).toBe(true);
    expect(checkWriteConfirm({ target_path: "SECURITY.md", confirm_write: false }).blocked).toBe(true);
    expect(checkWriteConfirm({ target_path: "subdir/LICENSE", confirm_write: false }).blocked).toBe(true);
  });
});

describe("assertWriteAllowed", () => {
  it("throws a PROTECTED_PATH_WRITE InternError when blocked", () => {
    try {
      assertWriteAllowed({ target_path: "memory/x.md", confirm_write: false });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InternError);
      expect((err as InternError).code).toBe("PROTECTED_PATH_WRITE");
    }
  });

  it("does not throw when allowed", () => {
    expect(() => assertWriteAllowed({ target_path: "src/foo.ts", confirm_write: false })).not.toThrow();
  });
});
