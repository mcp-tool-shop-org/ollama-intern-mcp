/**
 * ollama_change_brief — FLAGSHIP compound job.
 *
 * Produces a STRUCTURED IMPACT BRIEF for a change: what changed, why
 * it matters, what it could break, what should be checked, and what
 * release-note / handoff language is worth drafting. Not a git chat
 * bot and not prose paragraphs.
 *
 * Accepts diff_text and/or source_paths (changed files), with an
 * optional corpus for doctrine/architecture background. No VCS
 * integration — the caller hands in the evidence; the tool
 * synthesizes.
 *
 * Tier: Deep. Evidence-backed, thin-evidence-honest, no remediation
 * drift. likely_breakpoints is investigative ("this could break X");
 * validation_checks are verifications, not fixes. release_note_draft
 * is a draft — operator still reviews.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { timestamp } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import type { EvidenceItem } from "./briefs/evidence.js";
import {
  assembleEvidence,
  normalizeRefs,
  parseJsonObject,
  readString,
  readArray,
  type AssembledEvidence,
} from "./briefs/common.js";
import { normalizeCorpusQuery } from "./_helpers.js";

export const changeBriefSchema = z.object({
  diff_text: z.string().min(1).optional().describe("Unified-diff text (e.g. `git diff` output). Split per file on `diff --git` markers into numbered evidence items."),
  source_paths: z
    .array(z.string().min(1))
    .optional()
    .describe("Changed files to read server-side. Use alongside diff_text when the full file context matters, or alone when no diff is available. Optional — diff-driven calls work without it; runtime requires at least one of diff_text or source_paths."),
  corpus: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .optional()
    .describe("Optional: named corpus (e.g. 'handbook', 'doctrine') for architecture and release-process context."),
  corpus_query: z
    .string()
    .min(1)
    .optional()
    .describe("Query used to pull chunks from the corpus. Defaults to a digest of the diff/path heads."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars per source file (default 20k)."),
  max_breakpoints: z.number().int().min(1).max(12).optional().describe("Cap on likely_breakpoints (default 6)."),
  max_validation_checks: z.number().int().min(1).max(15).optional().describe("Cap on validation_checks (default 8)."),
});

export type ChangeBriefInput = z.infer<typeof changeBriefSchema>;

export interface AffectedSurface {
  surface: string;
  evidence_refs: string[];
}

export interface LikelyBreakpoint {
  breakpoint: string;
  evidence_refs: string[];
}

export interface ValidationCheck {
  check: string;
  why: string;
}

export interface ChangeBriefResult {
  change_summary: string;
  affected_surfaces: AffectedSurface[];
  why_it_matters: string;
  likely_breakpoints: LikelyBreakpoint[];
  validation_checks: ValidationCheck[];
  release_note_draft: string;
  evidence: EvidenceItem[];
  weak: boolean;
  coverage_notes: string[];
  corpus_used: { name: string; chunks_used: number } | null;
}

function assertAtLeastOnePrimary(input: ChangeBriefInput): void {
  if (!input.diff_text && (!input.source_paths || input.source_paths.length === 0)) {
    throw new InternError(
      "SCHEMA_INVALID",
      "ollama_change_brief: at least one of diff_text or source_paths must be provided.",
      "Pass diff_text for unified-diff output, source_paths for changed files the server should read, or both. Optionally add a corpus for architecture context.",
      false,
    );
  }
}

function buildPrompt(
  evidence: EvidenceItem[],
  caps: { breakpoints: number; checks: number },
): string {
  const blocks = evidence.map((e) => (
    `[${e.id}] kind=${e.kind} ref=${e.ref}\n${e.excerpt}`
  )).join("\n\n");
  return [
    `You are producing a CHANGE IMPACT BRIEF for a reviewer. Structured, reviewable, evidence-backed.`,
    `Not a prose summary. Not a git chat bot. Every affected surface and likely breakpoint must cite evidence.`,
    ``,
    `Evidence:`,
    blocks,
    ``,
    `Respond with JSON matching this shape exactly:`,
    `{`,
    `  "change_summary":     "<one-to-three sentences: what changed, concretely>",`,
    `  "affected_surfaces":  [ { "surface": "...", "evidence_refs": ["e1", ...] } ],`,
    `  "why_it_matters":     "<one paragraph: user/system-level impact>",`,
    `  "likely_breakpoints": [ { "breakpoint": "...", "evidence_refs": ["..."] } ],`,
    `  "validation_checks":  [ { "check": "...", "why": "..." } ],`,
    `  "release_note_draft": "<2-4 sentence release note the operator can edit>"`,
    `}`,
    ``,
    `Rules:`,
    `- Maximum ${caps.breakpoints} likely_breakpoints and ${caps.checks} validation_checks.`,
    `- evidence_refs MUST be ids from the list above. Do not invent ids.`,
    `- likely_breakpoints are INVESTIGATIVE (things that could break, with reasoning) — never "apply this fix", "revert this", or remediations.`,
    `- validation_checks are what to VERIFY after the change — tests to run, states to check, regressions to watch for. Never code changes.`,
    `- release_note_draft is a DRAFT the operator will review; write it neutrally and factually, not promotionally.`,
    `- If evidence is thin, return fewer items rather than padding with speculation.`,
  ].join("\n");
}

function assessCoverage(args: {
  evidenceCount: number;
  summaryLen: number;
  surfacesCount: number;
  strippedRefs: number;
  diffProvided: boolean;
  pathsProvided: boolean;
  corpusName: string | null;
  corpusHitCount: number;
}): { weak: boolean; notes: string[] } {
  const notes: string[] = [];
  // A change brief is weak when the model didn't produce a summary or
  // any affected surfaces. Evidence count alone isn't meaningful here —
  // a single-file diff is a legitimate change.
  const weak = args.summaryLen === 0 || args.surfacesCount === 0;

  if (args.evidenceCount === 0) {
    notes.push("No evidence could be assembled from the provided inputs.");
  }
  if (args.summaryLen === 0) {
    notes.push(`The model produced no change_summary. The evidence may not describe a coherent change.`);
  }
  if (args.surfacesCount === 0) {
    notes.push(`No affected_surfaces were identified. Brief coverage is too thin to rely on.`);
  }
  if (args.strippedRefs > 0) {
    notes.push(`Stripped ${args.strippedRefs} evidence_ref(s) that pointed at unknown ids.`);
  }
  if (args.corpusName && args.corpusHitCount === 0) {
    notes.push(`Corpus "${args.corpusName}" returned 0 chunks for the query — architecture context was not available.`);
  }
  if (!args.diffProvided && !args.pathsProvided) {
    notes.push(`No primary evidence (diff_text or source_paths) was provided.`);
  }
  return { weak, notes };
}

export async function handleChangeBrief(
  input: ChangeBriefInput,
  ctx: RunContext,
): Promise<Envelope<ChangeBriefResult>> {
  assertAtLeastOnePrimary(input);

  // Cap + sanitize caller-supplied corpus_query before it flows to embed.
  const sanitizedUserQuery = normalizeCorpusQuery(input.corpus_query);

  // Fall back the corpus query to the head of diff_text or first source
  // path name so it has some grounding signal when the caller doesn't
  // supply one.
  const fallback = input.diff_text
    ? input.diff_text.slice(0, 400)
    : (input.source_paths?.[0] ?? "");
  const corpusQuery = sanitizedUserQuery ?? fallback;

  const assembled = await assembleEvidence({
    diff_text: input.diff_text,
    source_paths: input.source_paths,
    corpus: input.corpus,
    corpus_query: corpusQuery,
    per_file_max_chars: input.per_file_max_chars,
  }, ctx);
  return synthesizeChangeBrief(input, ctx, assembled);
}

/**
 * Internal synthesis step. Takes pre-assembled evidence and runs the
 * Deep-tier brief synthesis. Exported so the change_pack orchestrator
 * can share one evidence assembly across brief + targeted extract
 * without exposing a "preassembled_evidence" knob on the public tool.
 */
export async function synthesizeChangeBrief(
  input: ChangeBriefInput,
  ctx: RunContext,
  assembled: AssembledEvidence,
): Promise<Envelope<ChangeBriefResult>> {
  const caps = {
    breakpoints: input.max_breakpoints ?? 6,
    checks: input.max_validation_checks ?? 8,
  };
  const { evidence, corpus_used } = assembled;
  const validIds = new Set(evidence.map((e) => e.id));

  const parseWarnings: string[] = [];

  const envelope = await runTool<ChangeBriefResult>({
    tool: "ollama_change_brief",
    tier: "deep",
    ctx,
    think: true,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(evidence, caps),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 2000,
      },
    }),
    parse: (raw): ChangeBriefResult => {
      const o = parseJsonObject(raw);
      let stripped = 0;

      const change_summary = readString(o, "change_summary");
      const why_it_matters = readString(o, "why_it_matters");
      const release_note_draft = readString(o, "release_note_draft");

      const affected_surfaces: AffectedSurface[] = [];
      for (const entry of readArray(o, "affected_surfaces")) {
        const s = entry as { surface?: unknown; evidence_refs?: unknown };
        if (typeof s.surface !== "string") continue;
        const refs = normalizeRefs(s.evidence_refs, validIds);
        stripped += refs.stripped;
        affected_surfaces.push({ surface: s.surface, evidence_refs: refs.valid });
      }

      const likely_breakpoints: LikelyBreakpoint[] = [];
      for (const entry of readArray(o, "likely_breakpoints")) {
        const b = entry as { breakpoint?: unknown; evidence_refs?: unknown };
        if (typeof b.breakpoint !== "string") continue;
        const refs = normalizeRefs(b.evidence_refs, validIds);
        stripped += refs.stripped;
        likely_breakpoints.push({ breakpoint: b.breakpoint, evidence_refs: refs.valid });
        if (likely_breakpoints.length >= caps.breakpoints) break;
      }

      const validation_checks: ValidationCheck[] = [];
      for (const entry of readArray(o, "validation_checks")) {
        const c = entry as { check?: unknown; why?: unknown };
        if (typeof c.check !== "string") continue;
        validation_checks.push({
          check: c.check,
          why: typeof c.why === "string" ? c.why : "",
        });
        if (validation_checks.length >= caps.checks) break;
      }

      const coverage = assessCoverage({
        evidenceCount: evidence.length,
        summaryLen: change_summary.length,
        surfacesCount: affected_surfaces.length,
        strippedRefs: stripped,
        diffProvided: Boolean(input.diff_text),
        pathsProvided: Boolean(input.source_paths && input.source_paths.length > 0),
        corpusName: input.corpus ?? null,
        corpusHitCount: corpus_used?.chunks_used ?? 0,
      });

      if (stripped > 0) {
        parseWarnings.push(`Stripped ${stripped} evidence_ref(s) that pointed at unknown ids.`);
      }

      return {
        change_summary,
        affected_surfaces,
        why_it_matters,
        likely_breakpoints,
        validation_checks,
        release_note_draft,
        evidence,
        weak: coverage.weak,
        coverage_notes: coverage.notes,
        corpus_used,
      };
    },
  });

  if (parseWarnings.length > 0) {
    envelope.warnings = [...(envelope.warnings ?? []), ...parseWarnings];
    await ctx.logger.log({
      kind: "guardrail",
      ts: timestamp(),
      tool: "ollama_change_brief",
      rule: "evidence_refs",
      action: "stripped",
      detail: { warnings: parseWarnings.length },
    });
  }

  return envelope;
}
