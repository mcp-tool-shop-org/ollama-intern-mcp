/**
 * ollama_refactor_plan — Workhorse tier.
 *
 * Complements ollama_multi_file_refactor_propose by answering HOW to sequence
 * the change safely. Produces a phased plan: which files land first, what
 * tests to write per phase, what's parallelizable, and a rollback strategy.
 *
 * Tier: workhorse. Shares loadSources + structured-JSON pattern with
 * multi_file_refactor_propose. Goes through runWithTimeoutAndFallback.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { loadSources, formatSourcesBlock } from "../sources.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { parseJsonObject, readArray } from "./briefs/common.js";
import type { RunContext } from "../runContext.js";

export const refactorPlanSchema = z.object({
  files: strictStringArray({ min: 1, max: 20, fieldName: "files" }).describe(
    "Source file paths the refactor touches. Min 1, max 20 — same envelope as multi_file_refactor_propose.",
  ),
  change_description: z
    .string()
    .min(20)
    .max(2000)
    .describe("What the refactor accomplishes. 20-2000 chars."),
  per_file_max_chars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .describe("Chars to read per file (default 60_000)."),
  priority: z
    .enum(["safety", "speed", "parallelism"])
    .optional()
    .describe(
      "Planning bias. 'safety' (default) sequences conservative phases with heavy tests-first. 'speed' compresses phases. 'parallelism' prefers splitting work across agents/files when possible.",
    ),
});

export type RefactorPlanInput = z.infer<typeof refactorPlanSchema>;

export interface RefactorPhase {
  phase: number;
  files_involved: string[];
  reason: string;
  tests_to_write: string[];
  parallelizable: boolean;
}

export interface RefactorPlanResult {
  phases: RefactorPhase[];
  sequencing_notes: string;
  rollback_strategy: string;
  estimated_phases: number;
  weak: boolean;
}

function priorityHint(priority: RefactorPlanInput["priority"]): string {
  switch (priority) {
    case "speed":
      return `Bias: SPEED. Compress phases — it's OK to bundle related files in one phase if tests still cover the delta.`;
    case "parallelism":
      return `Bias: PARALLELISM. Prefer splitting independent files into separate parallelizable phases (or sub-phases), even if that adds one extra sequencing step.`;
    case "safety":
    default:
      return `Bias: SAFETY. Prefer many small phases over one big one. Tests land BEFORE the code they cover when possible.`;
  }
}

function buildPrompt(input: RefactorPlanInput, body: string): string {
  return [
    `You are a senior refactoring planner. Given a set of files and a change,`,
    `produce a PHASED PLAN — how to sequence the work safely.`,
    ``,
    priorityHint(input.priority),
    ``,
    `Change to plan:`,
    input.change_description,
    ``,
    `Files:`,
    body,
    ``,
    `Return JSON matching this shape EXACTLY:`,
    `{`,
    `  "phases": [`,
    `    {`,
    `      "phase": 1,`,
    `      "files_involved": ["<path>", ...],`,
    `      "reason": "<why this phase comes before later ones>",`,
    `      "tests_to_write": ["<description of a specific test>", ...],`,
    `      "parallelizable": true | false`,
    `    }`,
    `  ],`,
    `  "sequencing_notes": "<paragraph on the overall plan logic>",`,
    `  "rollback_strategy": "<how to undo partially-landed phases>",`,
    `  "estimated_phases": <integer>`,
    `}`,
    ``,
    `Rules:`,
    `- phase numbers are 1-based and strictly increasing. No gaps.`,
    `- Every files_involved entry MUST come from the input file list.`,
    `- parallelizable=true only if the phase has no cross-file dependency with an earlier phase.`,
    `- tests_to_write is what to ADD before/with the phase, not a post-mortem suite.`,
    `- Never suggest infrastructure changes outside the file list.`,
  ].join("\n");
}

function isWeak(result: RefactorPlanResult): boolean {
  if (result.phases.length === 0) return true;
  // No phase has tests + no sequencing notes → plan is shape without substance.
  const anyTests = result.phases.some((p) => p.tests_to_write.length > 0);
  if (!anyTests && result.sequencing_notes.trim().length === 0) return true;
  // No rollback_strategy is a red flag for a plan that claims safety.
  if (result.rollback_strategy.trim().length === 0) return true;
  return false;
}

export async function handleRefactorPlan(
  input: RefactorPlanInput,
  ctx: RunContext,
): Promise<Envelope<RefactorPlanResult>> {
  const perFileMax = input.per_file_max_chars ?? 60_000;
  const sources = await loadSources(input.files, perFileMax);
  const body = formatSourcesBlock(sources);
  const validFileSet = new Set(input.files);

  return runTool<RefactorPlanResult>({
    tool: "ollama_refactor_plan",
    tier: "workhorse",
    ctx,
    think: true,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input, body),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 2200,
      },
    }),
    parse: (raw): RefactorPlanResult => {
      const o = parseJsonObject(raw);

      const rawPhases: RefactorPhase[] = [];
      for (const entry of readArray(o, "phases")) {
        const e = entry as {
          phase?: unknown;
          files_involved?: unknown;
          reason?: unknown;
          tests_to_write?: unknown;
          parallelizable?: unknown;
        };
        const phaseNum = typeof e.phase === "number" && Number.isFinite(e.phase) ? Math.trunc(e.phase) : NaN;
        if (!Number.isFinite(phaseNum)) continue;
        const files = Array.isArray(e.files_involved)
          ? e.files_involved.filter((f): f is string => typeof f === "string" && validFileSet.has(f))
          : [];
        const tests = Array.isArray(e.tests_to_write)
          ? e.tests_to_write.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
          : [];
        rawPhases.push({
          phase: phaseNum,
          files_involved: files,
          reason: typeof e.reason === "string" ? e.reason : "",
          tests_to_write: tests,
          parallelizable: Boolean(e.parallelizable),
        });
      }

      // Renumber phases 1..N in arrival order. Models occasionally produce
      // 1, 2, 2, 4 or start at 0. We keep their relative order but fix the
      // numbering so the output is always clean.
      rawPhases.sort((a, b) => a.phase - b.phase);
      const phases = rawPhases.map((p, i) => ({ ...p, phase: i + 1 }));

      const result: RefactorPlanResult = {
        phases,
        sequencing_notes: typeof o.sequencing_notes === "string" ? o.sequencing_notes : "",
        rollback_strategy: typeof o.rollback_strategy === "string" ? o.rollback_strategy : "",
        estimated_phases: phases.length,
        weak: false,
      };
      result.weak = isWeak(result);
      return result;
    },
  });
}
