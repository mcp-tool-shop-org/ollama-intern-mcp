/**
 * ollama_repo_brief — FLAGSHIP compound job.
 *
 * Produces an OPERATOR MAP of a repo: what it is, how it's shaped, what
 * matters first, what looks risky, what to read next. Not a research
 * clone — research answers a specific question about paths; repo_brief
 * synthesizes a structured orientation brief from the same kind of
 * source material.
 *
 * Tier: Deep. Evidence-backed (every key surface / risk area carries
 * evidence_refs). Thin evidence degrades to weak: true with
 * coverage_notes naming the gap. No remediation drift — read_next is
 * investigative, not prescriptive.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { timestamp } from "../observability.js";
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

export const repoBriefSchema = z.object({
  source_paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Files the brief should read server-side. Typically README, key src/ entries, package/manifest files, docs. Claude does not preload them — that's the context-saving shape."),
  corpus: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .optional()
    .describe("Optional: named corpus (e.g. 'handbook', 'doctrine') for cross-cutting context beyond the repo's own files."),
  corpus_query: z
    .string()
    .min(1)
    .optional()
    .describe("Query used to pull chunks from the corpus. Defaults to 'repo architecture and surfaces' when unspecified."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars per source file (default 20k)."),
  max_key_surfaces: z.number().int().min(1).max(20).optional().describe("Cap on key_surfaces (default 8)."),
  max_risk_areas: z.number().int().min(1).max(10).optional().describe("Cap on risk_areas (default 5)."),
  max_read_next: z.number().int().min(1).max(15).optional().describe("Cap on read_next (default 8)."),
});

export type RepoBriefInput = z.infer<typeof repoBriefSchema>;

export interface KeySurface {
  surface: string;
  why: string;
  evidence_refs: string[];
}

export interface RiskArea {
  risk: string;
  evidence_refs: string[];
}

export interface ReadNextItem {
  file: string;
  why: string;
}

export interface RepoBriefResult {
  repo_thesis: string;
  key_surfaces: KeySurface[];
  architecture_shape: string;
  risk_areas: RiskArea[];
  read_next: ReadNextItem[];
  evidence: EvidenceItem[];
  weak: boolean;
  coverage_notes: string[];
  corpus_used: { name: string; chunks_used: number } | null;
}

const WEAK_EVIDENCE_THRESHOLD = 2;

function buildPrompt(
  evidence: EvidenceItem[],
  caps: { keySurfaces: number; riskAreas: number; readNext: number },
): string {
  const blocks = evidence.map((e) => (
    `[${e.id}] kind=${e.kind} ref=${e.ref}\n${e.excerpt}`
  )).join("\n\n");
  return [
    `You are producing a REPO ORIENTATION BRIEF for an operator who has never seen this codebase.`,
    `Not a research answer. Not a marketing blurb. A structured operator map.`,
    `Use only the numbered evidence below. Every surface and risk must cite at least one evidence id.`,
    ``,
    `Evidence:`,
    blocks,
    ``,
    `Respond with JSON matching this shape exactly:`,
    `{`,
    `  "repo_thesis":        "<one-to-three sentences: what this repo is and does>",`,
    `  "key_surfaces":       [ { "surface": "...", "why": "...", "evidence_refs": ["e1", ...] } ],`,
    `  "architecture_shape": "<one paragraph: how the pieces fit together>",`,
    `  "risk_areas":         [ { "risk": "...", "evidence_refs": ["..."] } ],`,
    `  "read_next":          [ { "file": "<path or section>", "why": "..." } ]`,
    `}`,
    ``,
    `Rules:`,
    `- Maximum ${caps.keySurfaces} key_surfaces, ${caps.riskAreas} risk_areas, ${caps.readNext} read_next.`,
    `- evidence_refs MUST be ids from the list above. Do not invent ids.`,
    `- If the evidence is thin, return fewer items rather than padding with speculation.`,
    `- read_next is INVESTIGATIVE — files or sections to LOOK AT next. Never prescriptive fixes, refactors, or remediations.`,
    `- Do not propose code changes, dependency bumps, or deployments.`,
    `- repo_thesis must be grounded in the evidence. No marketing copy, no "this is a great codebase for X" filler.`,
  ].join("\n");
}

function assessCoverage(args: {
  evidenceCount: number;
  thesisLen: number;
  surfacesCount: number;
  architectureLen: number;
  strippedRefs: number;
  corpusName: string | null;
  corpusHitCount: number;
}): { weak: boolean; notes: string[] } {
  const notes: string[] = [];
  const weak =
    args.evidenceCount < WEAK_EVIDENCE_THRESHOLD ||
    args.thesisLen === 0 ||
    (args.surfacesCount === 0 && args.architectureLen === 0);

  if (args.evidenceCount < WEAK_EVIDENCE_THRESHOLD) {
    notes.push(`Only ${args.evidenceCount} evidence item(s) were fed to the brief — consider adding more source_paths or a corpus for richer context.`);
  }
  if (args.thesisLen === 0) {
    notes.push(`The model produced no repo_thesis. The evidence may not support an orientation brief yet.`);
  }
  if (args.surfacesCount === 0 && args.architectureLen === 0) {
    notes.push(`Neither key_surfaces nor architecture_shape was populated. Brief coverage is too thin to rely on.`);
  }
  if (args.strippedRefs > 0) {
    notes.push(`Stripped ${args.strippedRefs} evidence_ref(s) that pointed at unknown ids.`);
  }
  if (args.corpusName && args.corpusHitCount === 0) {
    notes.push(`Corpus "${args.corpusName}" returned 0 chunks for the query — cross-cutting context was not available.`);
  }
  return { weak, notes };
}

export async function handleRepoBrief(
  input: RepoBriefInput,
  ctx: RunContext,
): Promise<Envelope<RepoBriefResult>> {
  // Cap + sanitize the caller-supplied corpus_query before it flows to embed.
  const sanitizedUserQuery = normalizeCorpusQuery(input.corpus_query);
  const corpusQuery = sanitizedUserQuery ?? "repo architecture and surfaces";
  const assembled = await assembleEvidence({
    source_paths: input.source_paths,
    corpus: input.corpus,
    corpus_query: corpusQuery,
    per_file_max_chars: input.per_file_max_chars,
  }, ctx);
  return synthesizeRepoBrief(input, ctx, assembled);
}

/**
 * Internal synthesis step. Takes pre-assembled evidence and runs the
 * Deep-tier brief synthesis. Exported so the repo_pack orchestrator
 * can share one evidence assembly across brief + extract without
 * exposing a "preassembled_evidence" knob on the public tool surface.
 */
export async function synthesizeRepoBrief(
  input: RepoBriefInput,
  ctx: RunContext,
  assembled: AssembledEvidence,
): Promise<Envelope<RepoBriefResult>> {
  const caps = {
    keySurfaces: input.max_key_surfaces ?? 8,
    riskAreas: input.max_risk_areas ?? 5,
    readNext: input.max_read_next ?? 8,
  };
  const { evidence, corpus_used } = assembled;
  const validIds = new Set(evidence.map((e) => e.id));

  const parseWarnings: string[] = [];

  const envelope = await runTool<RepoBriefResult>({
    tool: "ollama_repo_brief",
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
    parse: (raw): RepoBriefResult => {
      const o = parseJsonObject(raw);
      let stripped = 0;

      const repo_thesis = readString(o, "repo_thesis");
      const architecture_shape = readString(o, "architecture_shape");

      const key_surfaces: KeySurface[] = [];
      for (const entry of readArray(o, "key_surfaces")) {
        const s = entry as { surface?: unknown; why?: unknown; evidence_refs?: unknown };
        if (typeof s.surface !== "string") continue;
        const refs = normalizeRefs(s.evidence_refs, validIds);
        stripped += refs.stripped;
        key_surfaces.push({
          surface: s.surface,
          why: typeof s.why === "string" ? s.why : "",
          evidence_refs: refs.valid,
        });
        if (key_surfaces.length >= caps.keySurfaces) break;
      }

      const risk_areas: RiskArea[] = [];
      for (const entry of readArray(o, "risk_areas")) {
        const r = entry as { risk?: unknown; evidence_refs?: unknown };
        if (typeof r.risk !== "string") continue;
        const refs = normalizeRefs(r.evidence_refs, validIds);
        stripped += refs.stripped;
        risk_areas.push({ risk: r.risk, evidence_refs: refs.valid });
        if (risk_areas.length >= caps.riskAreas) break;
      }

      const read_next: ReadNextItem[] = [];
      for (const entry of readArray(o, "read_next")) {
        const r = entry as { file?: unknown; why?: unknown };
        if (typeof r.file !== "string") continue;
        read_next.push({
          file: r.file,
          why: typeof r.why === "string" ? r.why : "",
        });
        if (read_next.length >= caps.readNext) break;
      }

      const coverage = assessCoverage({
        evidenceCount: evidence.length,
        thesisLen: repo_thesis.length,
        surfacesCount: key_surfaces.length,
        architectureLen: architecture_shape.length,
        strippedRefs: stripped,
        corpusName: input.corpus ?? null,
        corpusHitCount: corpus_used?.chunks_used ?? 0,
      });

      if (stripped > 0) {
        parseWarnings.push(`Stripped ${stripped} evidence_ref(s) that pointed at unknown ids.`);
      }
      if (repo_thesis.length === 0 && key_surfaces.length === 0 && architecture_shape.length === 0) {
        parseWarnings.push("Model produced an empty brief; evidence may not support synthesis.");
      }

      return {
        repo_thesis,
        key_surfaces,
        architecture_shape,
        risk_areas,
        read_next,
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
      tool: "ollama_repo_brief",
      rule: "evidence_refs",
      action: "stripped",
      detail: { warnings: parseWarnings.length },
    });
  }

  return envelope;
}
