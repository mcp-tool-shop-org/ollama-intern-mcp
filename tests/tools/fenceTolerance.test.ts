/**
 * Fence-tolerant model-output parsing (Phase 3b, Slice A).
 *
 * F1's first live dogfood jury (2026-07-06) proved glm-5.2 and kimi-k2.7
 * on Ollama Cloud wrap replies in markdown fences even under
 * `format:"json"` — the cloud side doesn't grammar-enforce every model.
 * F2 made EVERY runTool-driven tool cloud-reachable (cloud-primary always
 * was; standby adds per-call escalation), so the bare-JSON.parse parsers
 * across the tool surface share the latent defect F1 hit.
 *
 * This file pins the promoted shared helpers and the migrated handlers:
 *   - parseModelJson: direct parse first, then FIRST fenced block, else
 *     rethrow the ORIGINAL error (bespoke callers keep their own failure
 *     semantics — extract's unparseable path, classify's abstain).
 *   - parseModelJsonObject: fence-tolerant successor to parseJsonObject
 *     ({} on failure, object narrowing).
 *   - Handler spot-checks over each DISTINCT failure-semantics family:
 *     codeReview (the {}-tolerant parseJsonObject family — 8 sites share
 *     this one helper call path), classify (abstain family), extract
 *     (throwing family), triageLogs (empty-triage family), summarizeFast
 *     (heuristic-fallback family). verifyClaims' fence tests live in its
 *     own suite. summarizeDeep/corpusAnswer receive the identical
 *     one-token swap of the unit-tested helper.
 */

import { describe, it, expect } from "vitest";
import { parseModelJson, parseModelJsonObject } from "../../src/tools/briefs/common.js";
import { handleCodeReview } from "../../src/tools/codeReview.js";
import { handleClassify } from "../../src/tools/classify.js";
import { handleExtract } from "../../src/tools/extract.js";
import { handleTriageLogs } from "../../src/tools/triageLogs.js";
import { handleSummarizeFast } from "../../src/tools/summarizeFast.js";
import { createFakeOllama, makeFakeCtx } from "../_helpers/index.js";

/** The live glm/kimi shape: ```json fence around an otherwise-valid body. */
const fenced = (json: unknown): string => "```json\n" + JSON.stringify(json) + "\n```";

function ctxWith(raw: string) {
  const client = createFakeOllama({ defaultGenerateResponse: raw });
  return makeFakeCtx({ client });
}

describe("parseModelJson — direct-then-fence, original error preserved", () => {
  it("parses raw JSON directly (the common case, no fence scan)", () => {
    expect(parseModelJson('{"a": 1}')).toEqual({ a: 1 });
    expect(parseModelJson("  [1,2]  ")).toEqual([1, 2]);
  });

  it("parses a ```json fenced block (glm-5.2 / kimi-k2.7 live shape)", () => {
    expect(parseModelJson(fenced({ verdicts: [] }))).toEqual({ verdicts: [] });
  });

  it("parses a bare ``` fenced block (no language tag)", () => {
    expect(parseModelJson('```\n{"b": 2}\n```')).toEqual({ b: 2 });
  });

  it("prefers the direct parse when raw JSON legitimately CONTAINS a fence inside a string", () => {
    const obj = { note: 'see ```json {"x":1}``` above' };
    expect(parseModelJson(JSON.stringify(obj))).toEqual(obj);
  });

  it("rethrows when both direct and fenced parses fail (bespoke catch blocks stay reachable)", () => {
    expect(() => parseModelJson("just prose, no json")).toThrow(SyntaxError);
    expect(() => parseModelJson("```json\nstill not json\n```")).toThrow(SyntaxError);
  });
});

describe("parseModelJsonObject — fence-tolerant, {} on failure", () => {
  it("returns the object from a fenced reply", () => {
    expect(parseModelJsonObject(fenced({ summary: "s" }))).toEqual({ summary: "s" });
  });

  it("returns {} on garbage / non-object shapes (never throws)", () => {
    expect(parseModelJsonObject("nope")).toEqual({});
    expect(parseModelJsonObject("[1,2]")).toEqual({});
    expect(parseModelJsonObject("null")).toEqual({});
  });
});

describe("migrated handlers accept the live fence shape", () => {
  const SMALL_DIFF = [
    "diff --git a/src/x.ts b/src/x.ts",
    "--- a/src/x.ts",
    "+++ b/src/x.ts",
    "@@ -1,2 +1,3 @@",
    " export function x() {",
    '+  console.log("dbg");',
    " }",
  ].join("\n");

  it("code_review parses fenced findings (the site Fable elevated — cloud-reachable since F2)", async () => {
    const ctx = ctxWith(
      fenced({
        findings: [
          {
            file: "src/x.ts",
            line: 2,
            severity: "low",
            category: "style",
            description: "debug log left in",
            recommendation: "remove the console.log",
          },
        ],
        summary: "one style nit",
      }),
    );
    const env = await handleCodeReview({ diff_text: SMALL_DIFF }, ctx);
    expect(env.result.findings.length).toBe(1);
    expect(env.result.summary).toBe("one style nit");
  });

  it("classify accepts a fenced label instead of abstaining with parse_error", async () => {
    const ctx = ctxWith(fenced({ label: "fix", confidence: 0.9 }));
    const env = await handleClassify(
      { text: "patch null pointer in auth", labels: ["feat", "fix", "chore"] },
      ctx,
    );
    expect(env.result.label).toBe("fix");
    expect(env.result.confidence).toBe(0.9);
  });

  it("extract returns ok:true on fenced data instead of unparseable", async () => {
    const ctx = ctxWith(fenced({ name: "foo", count: 3 }));
    const env = await handleExtract(
      {
        text: "foo happened 3 times",
        schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      } as Parameters<typeof handleExtract>[0],
      ctx,
    );
    expect(env.result.ok).toBe(true);
    expect(env.result.data).toEqual({ name: "foo", count: 3 });
  });

  it("triage_logs parses fenced errors instead of returning the empty-triage fallback", async () => {
    const ctx = ctxWith(fenced({ errors: ["E1: connection reset"], warnings: [] }));
    const env = await handleTriageLogs({ log_text: "E1: connection reset\nok\n" }, ctx);
    expect(env.result.errors).toEqual(["E1: connection reset"]);
  });

  it("summarize_fast (frame mode) parses a fenced frame-summary instead of echoing the fence as prose", async () => {
    const ctx = ctxWith(fenced({ on_topic: true, summary: "tight summary" }));
    const env = await handleSummarizeFast(
      { text: "long text about the topic", frame: "what is the topic?" },
      ctx,
    );
    expect(env.result.summary).toBe("tight summary");
    expect(env.result.on_topic).toBe(true);
  });
});
