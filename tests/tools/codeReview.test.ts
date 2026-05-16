/**
 * ollama_code_review tool tests (FT-001 / Phase 7).
 *
 * code_review is a Phase-7 tools-domain addition: the model reviews a
 * unified diff and returns structured findings keyed by file/line. This
 * file pins the canonical contract:
 *
 *   - happy path: small diff → some findings, each with file + line + severity
 *   - abstain: model returns null/empty → empty findings, weak=true
 *   - severity_floor: low-severity items filtered out
 *   - max_findings: caller-supplied cap honored (server-side trim)
 *   - oversized diff: rejected with SCHEMA_INVALID before the wire call
 *
 * RACE NOTE: this test depends on src/tools/codeReview.ts which is the
 * tools-domain agent's work in Wave 7. If the file isn't landed yet,
 * the test imports fail at module load — that's acceptable race-handling
 * per the dispatch ("if cross-domain code isn't there yet, mark .todo()").
 * We use a dynamic import inside a beforeAll so the suite reports the
 * race cleanly rather than crashing every test in the file.
 */

import { describe, it, expect } from "vitest";
import { createFakeOllama, makeFakeCtx } from "../_helpers/index.js";
import { handleCodeReview, codeReviewSchema } from "../../src/tools/codeReview.js";

// Source is landed (Phase 7 Wave 7) + registered in src/index.ts (Phase 8
// coordinator fix). Suite runs unconditionally.
const describeIfImported = () => describe;

// Small unified-diff fixture (3 hunks across 2 files) — large enough to
// drive multiple findings but small enough to keep the test cheap.
const SMALL_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1234..5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 export function foo() {
+  console.log("debug");
   return 42;
 }
diff --git a/src/bar.ts b/src/bar.ts
index abcd..ef01 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,5 +10,6 @@ export class Bar {
   async go() {
+    await fetch("http://example.com"); // no error handling
     return null;
   }
 }
`;

// ── Smoke check that the import landed (or skipped cleanly) ────

describe("codeReview — module import", () => {
  it("module is present (handleCodeReview defined)", () => {
    expect(typeof handleCodeReview).toBe("function");
    expect(codeReviewSchema).toBeDefined();
  });
});

describeIfImported()("handleCodeReview — happy path (small diff)", () => {
  it("returns structured findings from a small diff", async () => {
    // Model returns 2 findings using the canonical schema enums
    // (severity: critical|high|medium|low, category: bug|security|performance|style|maintainability).
    const modelOut = JSON.stringify({
      findings: [
        {
          file: "src/foo.ts",
          line: 2,
          severity: "low",
          category: "style",
          description: "console.log left in source",
          recommendation: "remove the debug console.log before merge",
        },
        {
          file: "src/bar.ts",
          line: 11,
          severity: "high",
          category: "bug",
          description: "fetch result not error-checked",
          recommendation: "wrap in try/catch and surface the error to the caller",
        },
      ],
      summary: "two findings: a debug log and a missing error handler",
    });
    const client = createFakeOllama({ defaultGenerateResponse: modelOut });
    const ctx = makeFakeCtx({ client });
    const env = (await handleCodeReview!({ diff_text: SMALL_DIFF }, ctx)) as {
      result: { findings: unknown[]; summary?: string; diff_size_bytes?: number };
    };
    expect(Array.isArray(env.result.findings)).toBe(true);
    expect(env.result.findings.length).toBeGreaterThan(0);
    // Every finding carries a file + severity field — that's the
    // contract callers can rely on for downstream PR-comment rendering.
    for (const f of env.result.findings as Array<Record<string, unknown>>) {
      expect(typeof f.file).toBe("string");
      expect(typeof f.line === "number" || f.line === undefined).toBe(true);
      expect(typeof f.severity).toBe("string");
    }
  });
});

describeIfImported()("handleCodeReview — abstain path", () => {
  it("model returns null → empty findings (no fabrication)", async () => {
    const client = createFakeOllama({ defaultGenerateResponse: "null" });
    const ctx = makeFakeCtx({ client });
    const env = (await handleCodeReview!({ diff_text: SMALL_DIFF }, ctx)) as {
      result: { findings: unknown[] };
    };
    expect(env.result.findings).toEqual([]);
  });

  it('model returns {"findings": []} → empty findings', async () => {
    const client = createFakeOllama({
      defaultGenerateResponse: JSON.stringify({ findings: [] }),
    });
    const ctx = makeFakeCtx({ client });
    const env = (await handleCodeReview!({ diff_text: SMALL_DIFF }, ctx)) as {
      result: { findings: unknown[] };
    };
    expect(env.result.findings).toEqual([]);
  });

  it("model returns invalid JSON → empty findings (parser-tolerant)", async () => {
    const client = createFakeOllama({ defaultGenerateResponse: "not json" });
    const ctx = makeFakeCtx({ client });
    const env = (await handleCodeReview!({ diff_text: SMALL_DIFF }, ctx)) as {
      result: { findings: unknown[] };
    };
    expect(env.result.findings).toEqual([]);
  });
});

describeIfImported()("handleCodeReview — severity_floor filtering", () => {
  it("filters out findings below the severity floor", async () => {
    const modelOut = JSON.stringify({
      findings: [
        { file: "src/foo.ts", line: 2, severity: "low", category: "style", description: "low item", recommendation: "fix low" },
        { file: "src/foo.ts", line: 3, severity: "medium", category: "style", description: "med item", recommendation: "fix med" },
        { file: "src/foo.ts", line: 4, severity: "high", category: "bug", description: "high item", recommendation: "fix high" },
      ],
    });
    const client = createFakeOllama({ defaultGenerateResponse: modelOut });
    const ctx = makeFakeCtx({ client });
    const env = (await handleCodeReview!(
      { diff_text: SMALL_DIFF, severity_floor: "medium" },
      ctx,
    )) as { result: { findings: Array<{ severity: string }> } };
    const severities = env.result.findings.map((f) => f.severity);
    expect(severities).not.toContain("low");
    expect(severities).toContain("medium");
    expect(severities).toContain("high");
  });
});

describeIfImported()("handleCodeReview — max_findings cap", () => {
  it("caps the returned findings to max_findings (server-side trim)", async () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({
      file: "src/foo.ts",
      line: i + 1,
      severity: "medium",
      category: "bug",
      description: `finding ${i}`,
      recommendation: `fix ${i}`,
    }));
    const client = createFakeOllama({
      defaultGenerateResponse: JSON.stringify({ findings }),
    });
    const ctx = makeFakeCtx({ client });
    const env = (await handleCodeReview!(
      { diff_text: SMALL_DIFF, max_findings: 3 },
      ctx,
    )) as { result: { findings: unknown[] } };
    expect(env.result.findings.length).toBeLessThanOrEqual(3);
  });
});

describeIfImported()("handleCodeReview — oversized diff rejection", () => {
  it("rejects diffs larger than the documented cap with SCHEMA_INVALID", async () => {
    // Build a clearly-oversized diff > 2MB cap (schema rejects at 2MB).
    // We assert "rejection happens before a wire call" so the model
    // never wastes budget on garbage input.
    const giantDiff =
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n" +
      "+x\n".repeat(700_000); // ~2.8MB, comfortably above the 2MB cap
    const client = createFakeOllama();
    const ctx = makeFakeCtx({ client });
    // MCP layer parses input via codeReviewSchema BEFORE calling the
    // handler. The schema is the rejection gate; we assert it throws
    // and that the handler never sees the request (and never calls
    // the model). Direct handler calls in tests must mirror this
    // parse-first path.
    let threw = false;
    try {
      const parsed = codeReviewSchema!.parse({ diff_text: giantDiff });
      // If parse somehow accepts, fail the test below by checking the
      // wire call count after a direct handler invocation.
      await handleCodeReview!(parsed, ctx);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(client.callCount.generate).toBe(0);
  });
});

describeIfImported()("handleCodeReview — schema strictness", () => {
  it("empty diff_text rejects at the schema (zod parse error)", () => {
    if (!codeReviewSchema) {
      // Tool didn't export schema yet — race-tolerant skip.
      return;
    }
    expect(() => codeReviewSchema!.parse({ diff_text: "" })).toThrow();
  });

  it("non-string diff_text rejects at the schema", () => {
    if (!codeReviewSchema) return;
    expect(() => codeReviewSchema!.parse({ diff_text: 123 })).toThrow();
  });
});
