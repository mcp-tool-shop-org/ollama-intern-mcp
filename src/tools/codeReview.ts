/**
 * ollama_code_review — FT-001. Structured code review of a diff.
 *
 * Given a unified diff (and optionally the full source paths the diff
 * touches), returns a structured list of review findings. Each finding
 * has severity + category + file + line + symbol + description +
 * recommendation. Output is filtered by `severity_floor` and truncated
 * to `max_findings`.
 *
 * Tier: workhorse by default; callers can opt up to deep for
 * security-critical or high-stakes reviews. Instant is also allowed for
 * fast smoke passes on small diffs.
 *
 * Shape discipline: mirrors `refactor_plan` / `multi_file_refactor_propose`
 * — JSON mode, runner-resolved tier/model, coerce-before-trust on the
 * model output so malformed entries are dropped rather than crashing the
 * tool. The result envelope's `result.findings` is the operator-facing
 * surface; `result.summary` is a 1-2 sentence overall verdict;
 * `result.diff_size_bytes` lets receipts spot when a diff was clipped.
 *
 * Registration note for backend-core: this tool exports its handler +
 * schema but does NOT self-register on the MCP server (server.tool
 * registration lives in src/index.ts, outside the tools agent's scope).
 * Add the registration block to src/index.ts:
 *
 *   import { codeReviewSchema, handleCodeReview } from "./tools/codeReview.js";
 *
 *   server.tool(
 *     "ollama_code_review",
 *     "REVIEW. Structured code review of a unified diff. Pass `diff` (required, 1-2MB), optional `source_paths[]` for full file context, optional `severity_floor` (default 'low'), `max_findings` (default 50, max 200), `tier` (default 'workhorse'; 'deep' for high-stakes, 'instant' for fast smoke passes). Returns `{findings:[{severity, category, file, line, symbol?, description, recommendation}], summary, diff_size_bytes}` — severity is critical|high|medium|low, category is bug|security|performance|style|maintainability. Malformed entries are dropped server-side (never throws on model output shape).",
 *     codeReviewSchema.shape,
 *     (args) => wrap(handleCodeReview(args, ctx)),
 *   );
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { loadSources, formatSourcesBlock } from "../sources.js";
import { parseJsonObject, readObjectArray, readString } from "./briefs/common.js";
import type { RunContext } from "../runContext.js";

// ── Closed enums — match the dispatch spec exactly ─────────

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const CATEGORIES = [
  "bug",
  "security",
  "performance",
  "style",
  "maintainability",
] as const;
const TIERS = ["instant", "workhorse", "deep"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Category = (typeof CATEGORIES)[number];

// ── Schema ──────────────────────────────────────────────────

export const codeReviewSchema = z.object({
  diff_text: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024) // 2 MB — smaller than the 50 MB Ollama payload cap
    .describe(
      "Unified diff text (e.g. `git diff` output). Required. Max 2 MB to keep prompts within sensible context budgets — for larger reviews chunk the diff per logical change. Field name matches changePack / changeBrief convention.",
    ),
  source_paths: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe(
      "Optional full source files for the changed locations. Provides the model with full context for cross-line/cross-symbol concerns (e.g. 'this rename breaks line 200 in the same file the diff only touches line 50'). Max 50 paths.",
    ),
  severity_floor: z
    .enum(SEVERITIES)
    .default("low")
    .optional()
    .describe(
      "Drop findings below this severity from the result. Default 'low' (returns everything).",
    ),
  max_findings: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .optional()
    .describe(
      "Cap on returned findings after filtering. Default 50, max 200. The cap protects against a chatty model on a small diff burying real signal.",
    ),
  tier: z
    .enum(TIERS)
    .default("workhorse")
    .optional()
    .describe(
      "Which tier to run on. 'workhorse' is the default; 'deep' is recommended for security-critical or high-stakes reviews; 'instant' for fast smoke passes on tiny diffs.",
    ),
});

export type CodeReviewInput = z.infer<typeof codeReviewSchema>;

// ── Result shape ────────────────────────────────────────────

export interface CodeReviewFinding {
  severity: Severity;
  category: Category;
  file: string;
  /** 1-based source line. 0 means "could not localize". */
  line: number;
  /** Optional symbol the finding pertains to (function, method, struct name). */
  symbol?: string;
  description: string;
  recommendation: string;
}

export interface CodeReviewResult {
  findings: CodeReviewFinding[];
  /** 1-2 sentence overall verdict — drives operator triage at a glance. */
  summary: string;
  /** Byte size of the input diff — surfaces clipping when a diff was truncated upstream. */
  diff_size_bytes: number;
}

// ── Coerce helpers — drop malformed, never throw ────────────

/**
 * Severity rank for floor-filtering. Higher number = more severe. Lets
 * `severity_floor: 'medium'` drop low + omit nothing of medium-or-higher.
 */
const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

/**
 * Coerce a single model-emitted finding to a CodeReviewFinding.
 *
 * Returns null when the entry is too malformed to use (missing required
 * fields, unknown severity, unknown category). Drops are silent — the
 * batch-truncation message in the model prompt explains that bad
 * entries are dropped, so an operator sees "fewer findings than
 * expected" rather than a tool crash.
 *
 * Rules:
 *   - severity + category MUST be from the closed enums (else drop)
 *   - file MUST be a non-empty string (else drop)
 *   - line is coerced to int; non-finite or negative becomes 0 (= "unknown")
 *   - symbol is optional; non-string is dropped
 *   - description + recommendation must each be non-empty strings (else drop)
 *
 * Why "drop" instead of "throw": one malformed entry never explodes the
 * whole review. Same discipline as coerceOnboardingFacts in repoPack.
 */
function coerceFinding(entry: Record<string, unknown>): CodeReviewFinding | null {
  if (!isSeverity(entry.severity)) return null;
  if (!isCategory(entry.category)) return null;
  const file = readString(entry, "file");
  if (file.length === 0) return null;
  const description = readString(entry, "description");
  if (description.length === 0) return null;
  const recommendation = readString(entry, "recommendation");
  if (recommendation.length === 0) return null;

  // Line coercion: accept numbers (incl. floats — Math.trunc) and digit
  // strings ("42") — both common model output shapes. 0 = "unknown line",
  // never throws on garbage.
  let line = 0;
  const rawLine = entry.line;
  if (typeof rawLine === "number" && Number.isFinite(rawLine)) {
    line = Math.max(0, Math.trunc(rawLine));
  } else if (typeof rawLine === "string" && /^\d+$/.test(rawLine.trim())) {
    line = parseInt(rawLine.trim(), 10);
  }

  const out: CodeReviewFinding = {
    severity: entry.severity,
    category: entry.category,
    file,
    line,
    description: description.trim(),
    recommendation: recommendation.trim(),
  };
  if (typeof entry.symbol === "string" && entry.symbol.trim().length > 0) {
    out.symbol = entry.symbol.trim();
  }
  return out;
}

/**
 * Coerce the model's full output into a CodeReviewResult.
 *
 * Mirrors the coerceOnboardingFacts pattern from repoPack:
 *   - null/non-object → empty findings + empty summary
 *   - malformed entries dropped, never thrown
 *   - severity_floor filter applied AFTER drops so the operator sees
 *     "drops + filtered" honestly (not "filtered first, dropping any
 *     pre-filtered count makes the post-filter total wrong")
 *   - max_findings truncation is the LAST step so the cap reflects the
 *     filtered set, not the raw model output
 *
 * Findings are returned in the model's emit order. Stable ordering
 * lets a snapshot test compare runs without sorting.
 */
function coerceReview(
  data: unknown,
  opts: { severityFloor: Severity; maxFindings: number; diffSize: number },
): CodeReviewResult {
  // Tolerant top-level: model returned non-object / null / array →
  // empty result with the floor + cap honored. summary stays "" so
  // operator UIs can show a placeholder.
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { findings: [], summary: "", diff_size_bytes: opts.diffSize };
  }
  const obj = data as Record<string, unknown>;
  const summary = readString(obj, "summary").trim();
  const floorRank = SEVERITY_RANK[opts.severityFloor];

  const raw: CodeReviewFinding[] = [];
  for (const entry of readObjectArray(obj, "findings")) {
    const coerced = coerceFinding(entry);
    if (coerced === null) continue;
    if (SEVERITY_RANK[coerced.severity] < floorRank) continue;
    raw.push(coerced);
  }

  const findings = raw.slice(0, opts.maxFindings);
  return { findings, summary, diff_size_bytes: opts.diffSize };
}

// ── Prompt builder ──────────────────────────────────────────

function buildPrompt(args: {
  diff_text: string;
  sourceBody: string;
  severityFloor: Severity;
  maxFindings: number;
}): string {
  const lines: string[] = [];
  lines.push(
    `You are a senior code reviewer. Read the unified diff below and produce a STRUCTURED REVIEW.`,
    `Do NOT recap what the diff does. Focus on what's WRONG or RISKY — bugs, security issues,`,
    `performance problems, style/maintainability concerns the change introduces or fails to fix.`,
    ``,
    `Severity floor: ${args.severityFloor} or higher. Below-floor findings will be dropped server-side`,
    `— save your output budget for findings that matter.`,
    `Hard cap: ${args.maxFindings} findings. Pick the most important; below-floor entries don't count`,
    `against the cap because they're dropped.`,
    ``,
  );
  if (args.sourceBody.length > 0) {
    lines.push(
      `Full source for the changed files (use this for cross-line context the diff alone hides):`,
      args.sourceBody,
      ``,
    );
  }
  lines.push(
    `Unified diff:`,
    `\`\`\``,
    args.diff_text,
    `\`\`\``,
    ``,
    `Return JSON matching this shape EXACTLY:`,
    `{`,
    `  "findings": [`,
    `    {`,
    `      "severity": "critical" | "high" | "medium" | "low",`,
    `      "category": "bug" | "security" | "performance" | "style" | "maintainability",`,
    `      "file": "<path exactly as it appears in the diff>",`,
    `      "line": <1-based source line in the post-change file, or 0 if you cannot localize>,`,
    `      "symbol": "<optional function/method/struct name the finding pertains to>",`,
    `      "description": "<what's wrong, in 1-3 sentences>",`,
    `      "recommendation": "<concrete fix — not 'consider', not 'maybe', a specific action>"`,
    `    }`,
    `  ],`,
    `  "summary": "<1-2 sentence overall verdict — 'looks fine', 'risky around X', 'broken in Y'>"`,
    `}`,
    ``,
    `Rules:`,
    `- Never invent files not in the diff or source list.`,
    `- 'recommendation' is a concrete action, NOT advice. Bad: "consider validating". Good: "validate that 'name' is non-empty before passing to mkdir".`,
    `- If the diff looks clean, return findings: [] and summary describing why ('purely cosmetic rename', 'tests-only change', etc.).`,
    `- Do NOT pad with style findings to look thorough — empty findings is fine when the diff is clean.`,
  );
  return lines.join("\n");
}

// ── Handler ─────────────────────────────────────────────────

export async function handleCodeReview(
  input: CodeReviewInput,
  ctx: RunContext,
): Promise<Envelope<CodeReviewResult>> {
  const severityFloor: Severity = input.severity_floor ?? "low";
  const maxFindings = input.max_findings ?? 50;
  const tier = input.tier ?? "workhorse";
  // Track byte size of the diff for the envelope so a receipt-based
  // caller can spot when their diff was clipped upstream (e.g. CI passed
  // only the first 64KB of a huge change). The Buffer.byteLength call is
  // UTF-8 aware so multi-byte characters don't under-count.
  const diffSize = Buffer.byteLength(input.diff_text, "utf8");

  // Optional source-paths context. We load + format here in the handler
  // so the prompt builder stays pure and the loadSources call is
  // observable in stack traces.
  let sourceBody = "";
  if (input.source_paths && input.source_paths.length > 0) {
    const sources = await loadSources(input.source_paths, 60_000);
    sourceBody = formatSourcesBlock(sources);
  }

  return runTool<CodeReviewResult>({
    tool: "ollama_code_review",
    tier,
    ctx,
    // Workhorse uses Qwen 3 in some profiles, which thinks by default.
    // Reviews benefit from extended reasoning, so leave think=true for
    // workhorse + deep. Instant runs on hermes3:8b which ignores `think`.
    think: tier !== "instant",
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt({
        diff_text: input.diff_text,
        sourceBody,
        severityFloor,
        maxFindings,
      }),
      format: "json",
      // Reviews can be long when a diff is dense. 4 chars/token * 200
      // findings * 60 chars/finding ≈ 3000 tokens; bump to 3500 to leave
      // room for the summary. The model's own format:json contract bounds
      // it tighter than this most of the time.
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 3500,
      },
    }),
    parse: (raw): CodeReviewResult => {
      const o = parseJsonObject(raw);
      return coerceReview(o, { severityFloor, maxFindings, diffSize });
    },
  });
}

// Internal exports for tests. Tests are the tests-agent's domain, but
// exposing the coerce helper lets a future test exercise the malformed-
// entry-drop contract without round-tripping through the model.
export const __internal = { coerceFinding, coerceReview, SEVERITY_RANK };
