/**
 * ollama_triage_logs — stable-shape log digest: errors, warnings, suspected root cause.
 * Tier: Instant.
 *
 * Two input modes:
 *   - `log_text` : single log blob, returns {errors, warnings, suspected_root_cause?}
 *   - `items`    : batch of log blobs, each with a caller-provided id.
 *                  Returns one batch envelope with per-item {id, ok, result|error}.
 *
 * Exactly one of {log_text, items} must be provided.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { runBatch, type BatchResult } from "./batch.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const triageLogsSchema = z.object({
  log_text: z.string().min(1).optional().describe("Single log output to triage. Use this OR items, not both."),
  items: z
    .array(
      z.object({
        id: z.string().min(1).describe("Caller-provided, unique within the batch."),
        log_text: z.string().min(1),
      }),
    )
    .min(1)
    .optional()
    .describe("Batch of log blobs, each with a stable id. Returns one batch envelope with per-item {id, ok, result|error} entries."),
  patterns: strictStringArray({ min: 0, minItemLen: 0, fieldName: "patterns" }).optional().describe("Optional regex patterns the triage should bias toward — applied to every item in a batch."),
});

export type TriageLogsInput = z.infer<typeof triageLogsSchema>;

export interface TriageLogsResult {
  errors: string[];
  warnings: string[];
  suspected_root_cause?: string;
}

const MAX_PATTERN_LEN = 200;

/**
 * Reject patterns that could break out of the triage prompt. User-supplied
 * strings flow directly into the LLM prompt body, so newlines, carriage
 * returns, and code-fence delimiters are injection vectors. Length-cap
 * keeps a single pattern from dominating the prompt budget.
 */
function sanitizePatterns(patterns: string[] | undefined): void {
  if (!patterns || patterns.length === 0) return;
  for (const p of patterns) {
    if (p.length > MAX_PATTERN_LEN) {
      throw new InternError(
        "SCHEMA_INVALID",
        `patterns entry exceeds ${MAX_PATTERN_LEN} chars (got ${p.length}).`,
        "Shorten the pattern — triage patterns are regex hints, not log snippets.",
        false,
      );
    }
    if (/[\r\n]/.test(p) || p.includes("```")) {
      throw new InternError(
        "SCHEMA_INVALID",
        `patterns entry contains disallowed characters (newlines or triple backticks).`,
        "Patterns must be single-line literals without code-fence delimiters — they are embedded directly into the triage prompt.",
        false,
      );
    }
  }
}

function buildPromptFor(logText: string, patterns?: string[]): string {
  const patternsLine = patterns && patterns.length > 0
    ? `\nPay particular attention to these patterns: ${patterns.join(", ")}`
    : "";
  return [
    `You are a log triage assistant. If the input is not a log, reply exactly: {"errors": [], "warnings": [], "suspected_root_cause": "NOT_A_LOG"}.`,
    `Return JSON in exactly this shape:`,
    `{"errors": ["..."], "warnings": ["..."], "suspected_root_cause": "..."}`,
    `- errors: one string per distinct error (deduplicated, no stack traces)`,
    `- warnings: one string per distinct warning`,
    `- suspected_root_cause: one sentence or null`,
    patternsLine,
    ``,
    `Log:`,
    logText,
  ].join("\n");
}

function parse(raw: string): TriageLogsResult {
  try {
    const obj = JSON.parse(raw.trim());
    return {
      errors: Array.isArray(obj.errors) ? obj.errors.filter((x: unknown) => typeof x === "string") : [],
      warnings: Array.isArray(obj.warnings) ? obj.warnings.filter((x: unknown) => typeof x === "string") : [],
      ...(typeof obj.suspected_root_cause === "string" ? { suspected_root_cause: obj.suspected_root_cause } : {}),
    };
  } catch {
    return { errors: [], warnings: [] };
  }
}

function assertExactlyOneInput(input: TriageLogsInput): void {
  const given = (input.log_text !== undefined ? 1 : 0) + (input.items !== undefined ? 1 : 0);
  if (given !== 1) {
    throw new InternError(
      "SCHEMA_INVALID",
      `ollama_triage_logs: provide exactly one of "log_text" or "items" (given ${given}).`,
      "Pass log_text for a single call, or items:[{id,log_text}] for a batch. Not both, not neither.",
      false,
    );
  }
}

export async function handleTriageLogs(
  input: TriageLogsInput,
  ctx: RunContext,
): Promise<Envelope<TriageLogsResult> | Envelope<BatchResult<TriageLogsResult>>> {
  assertExactlyOneInput(input);
  sanitizePatterns(input.patterns);

  if (input.items) {
    return runBatch<{ id: string; log_text: string }, TriageLogsResult>({
      tool: "ollama_triage_logs",
      tier: "instant",
      ctx,
      think: false,
      items: input.items,
      build: (item, _tier, model) => ({
        model,
        prompt: buildPromptFor(item.log_text, input.patterns),
        format: "json",
        options: { temperature: TEMPERATURE_BY_SHAPE.triage, num_predict: 512 },
      }),
      parse,
    });
  }

  const logText = input.log_text as string;
  return runTool<TriageLogsResult>({
    tool: "ollama_triage_logs",
    tier: "instant",
    ctx,
    think: false,
    build: (_tier, model) => ({
      model,
      prompt: buildPromptFor(logText, input.patterns),
      format: "json",
      options: { temperature: TEMPERATURE_BY_SHAPE.triage, num_predict: 512 },
    }),
    parse,
  });
}
