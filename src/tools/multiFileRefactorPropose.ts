/**
 * ollama_multi_file_refactor_propose — Workhorse tier.
 *
 * Coordinated multi-file refactor PLAN (not writes). Caller hands in a set of
 * file paths and a change description; the server reads the files, prompts
 * the Workhorse tier with a strict JSON schema, and returns a per-file
 * before/after plan plus cross-file impact notes. No writes, ever.
 *
 * Tier: workhorse. Goes through runWithTimeoutAndFallback via the shared
 * runner — no bespoke timeout handling.
 *
 * Guardrails:
 *   - per_file_max_chars caps each file read (default 60k)
 *   - thin model output (no per_file_changes or mostly-empty fields) flips
 *     `weak: true` so the caller can see the synthesis didn't land
 *   - paths missing from disk fail loud via SOURCE_PATH_NOT_FOUND (from
 *     loadSources)
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { loadSources, formatSourcesBlock } from "../sources.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { parseJsonObject, readArray } from "./briefs/common.js";
import type { RunContext } from "../runContext.js";

export const multiFileRefactorProposeSchema = z.object({
  files: strictStringArray({ min: 1, max: 20, fieldName: "files" }).describe(
    "Source file paths the refactor touches. Server reads them — Claude does not preload. Min 1, max 20.",
  ),
  change_description: z
    .string()
    .min(20)
    .max(2000)
    .describe(
      "What the refactor should accomplish, in 20-2000 chars. Be specific — vague descriptions produce vague plans (likely weak=true).",
    ),
  per_file_max_chars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .describe("Chars to read per file (default 60_000)."),
});

export type MultiFileRefactorProposeInput = z.infer<typeof multiFileRefactorProposeSchema>;

export type RiskLevel = "low" | "medium" | "high";

export interface PerFileChange {
  file: string;
  before_summary: string;
  after_summary: string;
  risk_level: RiskLevel;
  change_kinds: string[];
}

export interface AffectedImport {
  from: string;
  to: string;
  files: string[];
}

export interface MultiFileRefactorProposeResult {
  per_file_changes: PerFileChange[];
  cross_file_impact: string;
  affected_imports: AffectedImport[];
  verification_steps: string[];
  weak: boolean;
}

const VALID_CHANGE_KINDS = new Set([
  "rename",
  "signature-change",
  "import-update",
  "move",
  "delete",
  "new",
  "refactor",
  "extract",
  "inline",
  "type-change",
]);

function normalizeRisk(v: unknown): RiskLevel {
  if (v === "low" || v === "medium" || v === "high") return v;
  return "medium";
}

function normalizeChangeKinds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of v) {
    if (typeof k !== "string") continue;
    const trimmed = k.trim().toLowerCase();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    // Pass through, but keep the full set allowed — callers may emit niche
    // kinds. We don't reject here, just dedupe + normalize case.
    out.push(trimmed);
  }
  return out;
}

function buildPrompt(input: MultiFileRefactorProposeInput, body: string): string {
  return [
    `You are a senior refactoring planner. You produce a STRUCTURED PLAN, not prose.`,
    `The operator has not written any code yet — your output is the coordination`,
    `they will check before touching files. No remediation lectures, no "consider".`,
    ``,
    `Change to plan:`,
    input.change_description,
    ``,
    `Files (each delimited by === BEGIN/END markers):`,
    body,
    ``,
    `Return JSON matching this shape EXACTLY:`,
    `{`,
    `  "per_file_changes": [`,
    `    {`,
    `      "file": "<path exactly as given above>",`,
    `      "before_summary": "<what this file does today, 1-3 sentences>",`,
    `      "after_summary": "<what it will do after the refactor, 1-3 sentences>",`,
    `      "risk_level": "low" | "medium" | "high",`,
    `      "change_kinds": ["rename" | "signature-change" | "import-update" | "move" | "delete" | "new"]`,
    `    }`,
    `  ],`,
    `  "cross_file_impact": "<one paragraph on how the files need to land together>",`,
    `  "affected_imports": [`,
    `    { "from": "<old import path / symbol>", "to": "<new>", "files": ["<path>", ...] }`,
    `  ],`,
    `  "verification_steps": ["<actionable check, e.g. 'run tsc --noEmit'>", ...]`,
    `}`,
    ``,
    `Rules:`,
    `- Every file in the input MUST appear in per_file_changes (even if the change is trivial).`,
    `- Never invent files that were not supplied.`,
    `- If a refactor is low-impact, say so in risk_level — do not inflate.`,
    `- affected_imports is only for symbol/module renames that cross files. Empty array is fine.`,
    `- verification_steps are CONCRETE commands or checks, not advice.`,
  ].join("\n");
}

function isWeak(result: MultiFileRefactorProposeResult, inputFileCount: number): boolean {
  // Weak when the model failed to cover every input file, or when every
  // per-file entry has empty before/after text (indicating shape-only fill).
  if (result.per_file_changes.length === 0) return true;
  if (result.per_file_changes.length < inputFileCount) return true;
  const anyMeaningful = result.per_file_changes.some(
    (c) => c.before_summary.trim().length > 0 && c.after_summary.trim().length > 0,
  );
  if (!anyMeaningful) return true;
  // If ALL verification_steps are empty and there's no cross_file_impact text
  // AND no affected_imports, treat as weak — operator can't act on it.
  if (
    result.verification_steps.length === 0 &&
    result.cross_file_impact.trim().length === 0 &&
    result.affected_imports.length === 0
  ) {
    return true;
  }
  return false;
}

export async function handleMultiFileRefactorPropose(
  input: MultiFileRefactorProposeInput,
  ctx: RunContext,
): Promise<Envelope<MultiFileRefactorProposeResult>> {
  const perFileMax = input.per_file_max_chars ?? 60_000;
  const sources = await loadSources(input.files, perFileMax);
  const body = formatSourcesBlock(sources);
  const validFileSet = new Set(input.files);

  return runTool<MultiFileRefactorProposeResult>({
    tool: "ollama_multi_file_refactor_propose",
    tier: "workhorse",
    ctx,
    think: true,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input, body),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 2500,
      },
    }),
    parse: (raw): MultiFileRefactorProposeResult => {
      const o = parseJsonObject(raw);

      const perFileChanges: PerFileChange[] = [];
      for (const entry of readArray(o, "per_file_changes")) {
        const e = entry as {
          file?: unknown;
          before_summary?: unknown;
          after_summary?: unknown;
          risk_level?: unknown;
          change_kinds?: unknown;
        };
        if (typeof e.file !== "string") continue;
        // Strip files not in the input set — model never gets to invent.
        if (!validFileSet.has(e.file)) continue;
        perFileChanges.push({
          file: e.file,
          before_summary: typeof e.before_summary === "string" ? e.before_summary : "",
          after_summary: typeof e.after_summary === "string" ? e.after_summary : "",
          risk_level: normalizeRisk(e.risk_level),
          change_kinds: normalizeChangeKinds(e.change_kinds),
        });
      }

      const affectedImports: AffectedImport[] = [];
      for (const entry of readArray(o, "affected_imports")) {
        const e = entry as { from?: unknown; to?: unknown; files?: unknown };
        if (typeof e.from !== "string" || typeof e.to !== "string") continue;
        const files = Array.isArray(e.files)
          ? e.files.filter((f): f is string => typeof f === "string" && validFileSet.has(f))
          : [];
        affectedImports.push({ from: e.from, to: e.to, files });
      }

      const verificationSteps: string[] = [];
      for (const s of readArray(o, "verification_steps")) {
        if (typeof s === "string" && s.trim().length > 0) verificationSteps.push(s.trim());
      }

      const crossFileImpact =
        typeof o.cross_file_impact === "string" ? o.cross_file_impact : "";

      const result: MultiFileRefactorProposeResult = {
        per_file_changes: perFileChanges,
        cross_file_impact: crossFileImpact,
        affected_imports: affectedImports,
        verification_steps: verificationSteps,
        weak: false,
      };
      result.weak = isWeak(result, input.files.length);

      // Track which change_kinds weren't in the canonical set for potential
      // caller-side filtering. Unknown kinds are PASSED THROUGH but noted
      // if a caller cares — we don't reject, we just dedupe.
      void VALID_CHANGE_KINDS;

      return result;
    },
  });
}
