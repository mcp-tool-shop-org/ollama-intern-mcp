/**
 * ollama_incident_brief — FLAGSHIP compound job.
 *
 * Structured operator brief built from log signal, file paths, and
 * (optionally) a named corpus for background context. Distinct from
 * ollama_triage_logs (symptoms in one blob) and from ollama_research
 * / ollama_corpus_answer (answer a specific question). This is the
 * "what just happened" shape.
 *
 * Shared-brief laws (see src/tools/briefs/):
 *   - evidence first-class (refs to unknown ids stripped server-side)
 *   - thin evidence → weak: true with coverage_notes
 *   - no remediation drift: next_checks are investigative only
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE, resolveTier } from "../tiers.js";
import { runTool } from "./runner.js";
import { callEvent, timestamp } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import type { EvidenceItem } from "./briefs/evidence.js";
import {
  assembleEvidence,
  normalizeRefs,
  normalizeConfidence,
  parseJsonObject,
  readArray,
  type AssembledEvidence,
} from "./briefs/common.js";

export const incidentBriefSchema = z.object({
  log_text: z.string().min(1).optional().describe("Raw log blob to reason over. Combine with source_paths and/or corpus for a richer brief."),
  source_paths: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("File paths read server-side (Claude does not preload). Use for config files, related source files, incident notes."),
  corpus: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .optional()
    .describe("Optional: named corpus (e.g. 'doctrine', 'memory') to pull background context from. Requires corpus_query when the log signal is too short to derive one."),
  corpus_query: z
    .string()
    .min(1)
    .optional()
    .describe("Query used to pull chunks from the corpus. Defaults to a digest of the log head if not provided."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars per source file (default 20k)."),
  max_hypotheses: z.number().int().min(1).max(10).optional().describe("Cap on root-cause hypotheses in the output (default 5)."),
});

export type IncidentBriefInput = z.infer<typeof incidentBriefSchema>;

export interface Hypothesis {
  hypothesis: string;
  confidence: "high" | "medium" | "low";
  evidence_refs: string[];
}

export interface AffectedSurface {
  surface: string;
  evidence_refs: string[];
}

export interface TimelineClue {
  clue: string;
  evidence_refs: string[];
}

export interface NextCheck {
  check: string;
  why: string;
}

export interface IncidentBriefResult {
  root_cause_hypotheses: Hypothesis[];
  affected_surfaces: AffectedSurface[];
  timeline_clues: TimelineClue[];
  next_checks: NextCheck[];
  evidence: EvidenceItem[];
  weak: boolean;
  coverage_notes: string[];
  corpus_used: { name: string; chunks_used: number } | null;
}

const WEAK_EVIDENCE_THRESHOLD = 2;

function buildPrompt(evidence: EvidenceItem[], maxHypotheses: number): string {
  const blocks = evidence.map((e) => (
    `[${e.id}] kind=${e.kind} ref=${e.ref}\n${e.excerpt}`
  )).join("\n\n");
  return [
    `You are an incident analyst. You produce a STRUCTURED OPERATOR BRIEF, not a prose summary.`,
    `Use only the numbered evidence below. Every claim must cite at least one evidence id.`,
    ``,
    `Evidence:`,
    blocks,
    ``,
    `Respond with JSON matching this shape exactly:`,
    `{`,
    `  "root_cause_hypotheses": [ { "hypothesis": "...", "confidence": "high|medium|low", "evidence_refs": ["e1", ...] } ],`,
    `  "affected_surfaces":     [ { "surface": "...", "evidence_refs": ["..."] } ],`,
    `  "timeline_clues":        [ { "clue": "...", "evidence_refs": ["..."] } ],`,
    `  "next_checks":           [ { "check": "...", "why": "..." } ]`,
    `}`,
    ``,
    `Rules:`,
    `- Maximum ${maxHypotheses} root-cause hypotheses. Rank by likelihood.`,
    `- evidence_refs MUST be ids from the list above (e.g. "e1"). Do not invent ids.`,
    `- If evidence is thin, return fewer items rather than padding with speculation.`,
    `- next_checks are INVESTIGATIVE ("look at X", "verify Y", "check Z") — never prescriptive fixes or remediations.`,
    `- Do not suggest code changes, rollbacks, restarts, or deployments.`,
    `- If the evidence does not support a brief, return empty arrays and let the caller see weak coverage.`,
  ].join("\n");
}

function assessCoverage(args: {
  evidenceCount: number;
  hypothesesCount: number;
  surfacesCount: number;
  strippedRefs: number;
  logProvided: boolean;
  pathsProvided: boolean;
  corpusName: string | null;
  corpusHitCount: number;
}): { weak: boolean; notes: string[] } {
  const notes: string[] = [];
  const weak =
    args.evidenceCount < WEAK_EVIDENCE_THRESHOLD ||
    args.hypothesesCount === 0 ||
    (args.surfacesCount === 0 && args.hypothesesCount === 0);

  if (args.evidenceCount < WEAK_EVIDENCE_THRESHOLD) {
    notes.push(`Only ${args.evidenceCount} evidence item(s) were fed to the brief — consider adding source_paths or a corpus for richer context.`);
  }
  if (args.hypothesesCount === 0) {
    notes.push(`No root-cause hypotheses were produced. The evidence may not support a brief yet.`);
  }
  if (args.strippedRefs > 0) {
    notes.push(`Stripped ${args.strippedRefs} evidence_ref(s) that pointed at unknown ids.`);
  }
  if (args.corpusName && args.corpusHitCount === 0) {
    notes.push(`Corpus "${args.corpusName}" returned 0 chunks for the query — background context was not available.`);
  }
  if (!args.logProvided && !args.pathsProvided) {
    notes.push(`No primary evidence (log_text or source_paths) was provided.`);
  }
  return { weak, notes };
}

function assertAtLeastOnePrimary(input: IncidentBriefInput): void {
  if (!input.log_text && (!input.source_paths || input.source_paths.length === 0)) {
    throw new InternError(
      "SCHEMA_INVALID",
      "ollama_incident_brief: at least one of log_text or source_paths must be provided.",
      "Pass log_text for raw log blobs, source_paths for files the server should read, or both. Optionally add a corpus for background context.",
      false,
    );
  }
}

export async function handleIncidentBrief(
  input: IncidentBriefInput,
  ctx: RunContext,
): Promise<Envelope<IncidentBriefResult>> {
  assertAtLeastOnePrimary(input);

  // Default the corpus query to the log head if the caller didn't hand one in.
  const corpusQuery = input.corpus_query ?? (input.log_text ? input.log_text.slice(0, 400) : "");
  const assembled = await assembleEvidence({
    log_text: input.log_text,
    source_paths: input.source_paths,
    corpus: input.corpus,
    corpus_query: corpusQuery,
    per_file_max_chars: input.per_file_max_chars,
  }, ctx);
  return synthesizeIncidentBrief(input, ctx, assembled);
}

/**
 * Internal synthesis step. Takes pre-assembled evidence and runs the
 * Deep-tier brief synthesis. Exported so the incident_pack orchestrator
 * can share one evidence assembly across triage + brief without
 * exposing a "preassembled_evidence" knob on the public tool.
 */
export async function synthesizeIncidentBrief(
  input: IncidentBriefInput,
  ctx: RunContext,
  assembled: AssembledEvidence,
): Promise<Envelope<IncidentBriefResult>> {
  const maxHypotheses = input.max_hypotheses ?? 5;
  const { evidence, corpus_used } = assembled;
  const validIds = new Set(evidence.map((e) => e.id));

  // 0-evidence inputs short-circuit before the model — refuse to
  // synthesize without grounding.
  if (evidence.length === 0) {
    const startedAt = Date.now();
    const deepModel = resolveTier("deep", ctx.tiers);
    const residency = await ctx.client.residency(deepModel);
    const result: IncidentBriefResult = {
      root_cause_hypotheses: [],
      affected_surfaces: [],
      timeline_clues: [],
      next_checks: [],
      evidence: [],
      weak: true,
      coverage_notes: [
        "No evidence could be assembled from the provided inputs. Model was not invoked — synthesis without grounding would be unsafe.",
      ],
      corpus_used,
    };
    const envelope = buildEnvelope<IncidentBriefResult>({
      result,
      tier: "deep",
      model: deepModel,
      hardwareProfile: ctx.hardwareProfile,
      tokensIn: 0,
      tokensOut: 0,
      startedAt,
      residency,
      warnings: ["incident_brief: zero evidence items; model not invoked"],
    });
    await ctx.logger.log(callEvent("ollama_incident_brief", envelope));
    return envelope;
  }

  const parseWarnings: string[] = [];

  const envelope = await runTool<IncidentBriefResult>({
    tool: "ollama_incident_brief",
    tier: "deep",
    ctx,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(evidence, maxHypotheses),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 1500,
      },
    }),
    parse: (raw): IncidentBriefResult => {
      const o = parseJsonObject(raw);
      let stripped = 0;

      const hypotheses: Hypothesis[] = [];
      for (const entry of readArray(o, "root_cause_hypotheses")) {
        const h = entry as { hypothesis?: unknown; confidence?: unknown; evidence_refs?: unknown };
        if (typeof h.hypothesis !== "string") continue;
        const refs = normalizeRefs(h.evidence_refs, validIds);
        stripped += refs.stripped;
        hypotheses.push({
          hypothesis: h.hypothesis,
          confidence: normalizeConfidence(h.confidence),
          evidence_refs: refs.valid,
        });
        if (hypotheses.length >= maxHypotheses) break;
      }

      const surfaces: AffectedSurface[] = [];
      for (const entry of readArray(o, "affected_surfaces")) {
        const s = entry as { surface?: unknown; evidence_refs?: unknown };
        if (typeof s.surface !== "string") continue;
        const refs = normalizeRefs(s.evidence_refs, validIds);
        stripped += refs.stripped;
        surfaces.push({ surface: s.surface, evidence_refs: refs.valid });
      }

      const clues: TimelineClue[] = [];
      for (const entry of readArray(o, "timeline_clues")) {
        const c = entry as { clue?: unknown; evidence_refs?: unknown };
        if (typeof c.clue !== "string") continue;
        const refs = normalizeRefs(c.evidence_refs, validIds);
        stripped += refs.stripped;
        clues.push({ clue: c.clue, evidence_refs: refs.valid });
      }

      const checks: NextCheck[] = [];
      for (const entry of readArray(o, "next_checks")) {
        const n = entry as { check?: unknown; why?: unknown };
        if (typeof n.check !== "string") continue;
        checks.push({
          check: n.check,
          why: typeof n.why === "string" ? n.why : "",
        });
      }

      const coverage = assessCoverage({
        evidenceCount: evidence.length,
        hypothesesCount: hypotheses.length,
        surfacesCount: surfaces.length,
        strippedRefs: stripped,
        logProvided: Boolean(input.log_text),
        pathsProvided: Boolean(input.source_paths && input.source_paths.length > 0),
        corpusName: input.corpus ?? null,
        corpusHitCount: corpus_used?.chunks_used ?? 0,
      });

      if (stripped > 0) {
        parseWarnings.push(`Stripped ${stripped} evidence_ref(s) that pointed at unknown ids.`);
      }
      if (hypotheses.length === 0 && surfaces.length === 0 && clues.length === 0 && checks.length === 0) {
        parseWarnings.push("Model produced an empty brief; evidence may not support synthesis.");
      }

      return {
        root_cause_hypotheses: hypotheses,
        affected_surfaces: surfaces,
        timeline_clues: clues,
        next_checks: checks,
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
      tool: "ollama_incident_brief",
      rule: "evidence_refs",
      action: "stripped",
      detail: { warnings: parseWarnings.length },
    });
  }

  return envelope;
}
