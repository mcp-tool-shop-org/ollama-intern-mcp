/**
 * ollama_incident_brief — FLAGSHIP compound job.
 *
 * Not a prose summary. Not chat over logs. A structured operator brief
 * that weaves log signal, file paths, and (optionally) a named corpus
 * into something reviewable: root-cause hypotheses, affected surfaces,
 * timeline clues, and investigative next checks — every one of them
 * traceable back to specific evidence.
 *
 * Distinct from ollama_triage_logs (finds symptoms in one log blob)
 * and from ollama_research / ollama_corpus_answer (answer a specific
 * question). incident_brief is the "what just happened" shape.
 *
 * Tier: Deep.
 *
 * Laws:
 *
 *   Evidence is first-class. Every numbered evidence item the model
 *   sees survives into the result. Every hypothesis, surface, and
 *   clue carries a list of evidence ids; refs to ids that don't
 *   exist are stripped server-side.
 *
 *   Thin evidence → weak brief. If there isn't enough signal to
 *   support a confident brief, the result carries `weak: true` and
 *   coverage_notes name the gap. No smooth fake narrative.
 *
 *   No remediation drift. next_checks are investigative ("look at
 *   X", "verify Y") — never prescriptive fixes. The prompt enforces
 *   that boundary.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE, resolveTier } from "../tiers.js";
import { runTool } from "./runner.js";
import { callEvent, timestamp } from "../observability.js";
import { loadSources, type LoadedSource } from "../sources.js";
import { loadCorpus } from "../corpus/storage.js";
import { searchCorpus, DEFAULT_SEARCH_MODE, type CorpusHit } from "../corpus/searcher.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

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

export type EvidenceKind = "log" | "path" | "corpus";

export interface EvidenceItem {
  id: string;            // "e1", "e2", ...
  kind: EvidenceKind;
  ref: string;           // "log:<line_range>" | "<path>" | "<path>#<chunk_index>"
  excerpt: string;       // short snippet shown to the model
}

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
  /** Was a corpus consulted; how many chunks it contributed. */
  corpus_used: { name: string; chunks_used: number } | null;
}

// ── Evidence gathering ────────────────────────────────────

const LOG_CHUNK_LINES = 60;
const LOG_EXCERPT_CHARS = 400;
const PATH_EXCERPT_CHARS = 600;
const CORPUS_EXCERPT_CHARS = 500;
const CORPUS_TOP_K = 4;

function sliceLogIntoEvidence(logText: string, startId: number): EvidenceItem[] {
  const lines = logText.split(/\r?\n/);
  const items: EvidenceItem[] = [];
  let cursor = 0;
  let nextId = startId;
  while (cursor < lines.length) {
    const end = Math.min(cursor + LOG_CHUNK_LINES, lines.length);
    const slice = lines.slice(cursor, end).join("\n");
    if (slice.trim().length > 0) {
      items.push({
        id: `e${nextId++}`,
        kind: "log",
        ref: `log:${cursor + 1}-${end}`,
        excerpt: slice.slice(0, LOG_EXCERPT_CHARS),
      });
    }
    cursor = end;
  }
  return items;
}

function pathToEvidence(sources: LoadedSource[], startId: number): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let nextId = startId;
  for (const s of sources) {
    items.push({
      id: `e${nextId++}`,
      kind: "path",
      ref: s.path,
      excerpt: s.body.slice(0, PATH_EXCERPT_CHARS),
    });
  }
  return items;
}

function corpusHitsToEvidence(hits: CorpusHit[], startId: number): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let nextId = startId;
  for (const h of hits) {
    items.push({
      id: `e${nextId++}`,
      kind: "corpus",
      ref: `${h.path}#${h.chunk_index}`,
      excerpt: (h.preview ?? "").slice(0, CORPUS_EXCERPT_CHARS),
    });
  }
  return items;
}

// ── Prompt shape ──────────────────────────────────────────

function buildPrompt(question: string | null, evidence: EvidenceItem[], maxHypotheses: number): string {
  const blocks = evidence.map((e) => (
    `[${e.id}] kind=${e.kind} ref=${e.ref}\n${e.excerpt}`
  )).join("\n\n");
  return [
    `You are an incident analyst. You produce a STRUCTURED OPERATOR BRIEF, not a prose summary.`,
    `Use only the numbered evidence below. Every claim must cite at least one evidence id.`,
    ``,
    question ? `Operator question (if provided): ${question}\n` : ``,
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
  ].filter((l) => l !== ``).join("\n");
}

// ── Output parsing + validation ──────────────────────────

interface RawBriefOutput {
  root_cause_hypotheses?: Array<{ hypothesis?: unknown; confidence?: unknown; evidence_refs?: unknown }>;
  affected_surfaces?: Array<{ surface?: unknown; evidence_refs?: unknown }>;
  timeline_clues?: Array<{ clue?: unknown; evidence_refs?: unknown }>;
  next_checks?: Array<{ check?: unknown; why?: unknown }>;
}

function parseRaw(raw: string): RawBriefOutput {
  try {
    const obj = JSON.parse(raw.trim());
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as RawBriefOutput;
  } catch {
    /* fall through */
  }
  return {};
}

function normalizeRefs(refs: unknown, validIds: Set<string>): { valid: string[]; stripped: number } {
  if (!Array.isArray(refs)) return { valid: [], stripped: 0 };
  const valid: string[] = [];
  let stripped = 0;
  const seen = new Set<string>();
  for (const r of refs) {
    if (typeof r !== "string") { stripped += 1; continue; }
    if (!validIds.has(r)) { stripped += 1; continue; }
    if (seen.has(r)) continue;
    seen.add(r);
    valid.push(r);
  }
  return { valid, stripped };
}

function normalizeConfidence(c: unknown): "high" | "medium" | "low" {
  if (c === "high" || c === "medium" || c === "low") return c;
  return "low";
}

// ── Weak / coverage policy ────────────────────────────────

const WEAK_EVIDENCE_THRESHOLD = 2;

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
    // Should have been rejected at input validation, but guard anyway.
    notes.push(`No primary evidence (log_text or source_paths) was provided.`);
  }
  return { weak, notes };
}

// ── Handler ───────────────────────────────────────────────

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
  const perFileMax = input.per_file_max_chars ?? 20_000;
  const maxHypotheses = input.max_hypotheses ?? 5;

  // Gather evidence up front so the model sees numbered ids it can cite.
  const evidence: EvidenceItem[] = [];
  let nextId = 1;

  if (input.log_text) {
    const logEv = sliceLogIntoEvidence(input.log_text, nextId);
    evidence.push(...logEv);
    nextId += logEv.length;
  }

  if (input.source_paths && input.source_paths.length > 0) {
    const sources = await loadSources(input.source_paths, perFileMax);
    const pathEv = pathToEvidence(sources, nextId);
    evidence.push(...pathEv);
    nextId += pathEv.length;
  }

  let corpusHits: CorpusHit[] = [];
  let corpusUsed: { name: string; chunks_used: number } | null = null;
  if (input.corpus) {
    const corpus = await loadCorpus(input.corpus);
    if (!corpus) {
      throw new InternError(
        "SCHEMA_INVALID",
        `Corpus "${input.corpus}" does not exist`,
        `Build it first with ollama_corpus_index, or use ollama_corpus_list to see available corpora.`,
        false,
      );
    }
    const query = input.corpus_query
      ?? (input.log_text ? input.log_text.slice(0, 400) : "");
    if (query.trim().length > 0) {
      const embedModel = resolveTier("embed", ctx.tiers);
      corpusHits = await searchCorpus({
        corpus,
        query,
        model: embedModel,
        mode: DEFAULT_SEARCH_MODE,
        top_k: CORPUS_TOP_K,
        preview_chars: CORPUS_EXCERPT_CHARS,
        client: ctx.client,
      });
      const corpusEv = corpusHitsToEvidence(corpusHits, nextId);
      evidence.push(...corpusEv);
      nextId += corpusEv.length;
    }
    corpusUsed = { name: input.corpus, chunks_used: corpusHits.length };
  }

  const validIds = new Set(evidence.map((e) => e.id));

  // If no evidence was actually assembled (e.g. empty log after splits),
  // short-circuit without invoking the model.
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
      corpus_used: corpusUsed,
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
      prompt: buildPrompt(null, evidence, maxHypotheses),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 1500,
      },
    }),
    parse: (raw): IncidentBriefResult => {
      const o = parseRaw(raw);
      let stripped = 0;

      const hypotheses: Hypothesis[] = [];
      for (const h of o.root_cause_hypotheses ?? []) {
        if (typeof h?.hypothesis !== "string") continue;
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
      for (const s of o.affected_surfaces ?? []) {
        if (typeof s?.surface !== "string") continue;
        const refs = normalizeRefs(s.evidence_refs, validIds);
        stripped += refs.stripped;
        surfaces.push({ surface: s.surface, evidence_refs: refs.valid });
      }

      const clues: TimelineClue[] = [];
      for (const c of o.timeline_clues ?? []) {
        if (typeof c?.clue !== "string") continue;
        const refs = normalizeRefs(c.evidence_refs, validIds);
        stripped += refs.stripped;
        clues.push({ clue: c.clue, evidence_refs: refs.valid });
      }

      const checks: NextCheck[] = [];
      for (const n of o.next_checks ?? []) {
        if (typeof n?.check !== "string") continue;
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
        corpusHitCount: corpusHits.length,
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
        corpus_used: corpusUsed,
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
