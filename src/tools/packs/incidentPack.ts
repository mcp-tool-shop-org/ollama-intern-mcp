/**
 * ollama_incident_pack — FIRST PACK. Deterministic orchestration of the
 * tools Claude already trusts, into one completed job.
 *
 * Fixed pipeline:
 *   1. ollama_triage_logs     (if log_text is provided)
 *   2. assemble evidence      (log + paths + corpus_search if corpus)
 *   3. ollama_incident_brief  (via internal synthesizeIncidentBrief,
 *                              reusing the already-assembled evidence —
 *                              no double file-read, no double corpus query)
 *   4. artifact_write         (markdown + json to disk)
 *
 * Fixed markdown layout — deterministic renderer, NOT ollama_draft.
 * Packs are completed jobs, not another place for prose drift.
 *
 * Artifact paths:
 *   <artifact_dir>/<YYYY-MM-DD-HHMM[-slug]>.md
 *   <artifact_dir>/<YYYY-MM-DD-HHMM[-slug]>.json
 * Default artifact_dir = ~/.ollama-intern/artifacts/incident/.
 *
 * MCP response is compact: paths + counts + step trace. Do NOT dump
 * the full brief into the response — that's what the artifact is for.
 */

import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Envelope } from "../../envelope.js";
import { buildEnvelope } from "../../envelope.js";
import { callEvent } from "../../observability.js";
import type { RunContext } from "../../runContext.js";
import { InternError } from "../../errors.js";
import { assembleEvidence } from "../briefs/common.js";
import { handleTriageLogs, type TriageLogsResult } from "../triageLogs.js";
import {
  synthesizeIncidentBrief,
  type IncidentBriefInput,
  type IncidentBriefResult,
} from "../incidentBrief.js";
import { strictStringArray } from "../../guardrails/stringifiedArrayGuard.js";

// ── Schema ──────────────────────────────────────────────────

export const incidentPackSchema = z.object({
  log_text: z.string().min(1).optional().describe("Raw log blob. Combine with source_paths and/or corpus for richer coverage."),
  source_paths: strictStringArray({ min: 1, fieldName: "source_paths" }).optional().describe("File paths read server-side (related source, config, incident notes)."),
  corpus: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .optional()
    .describe("Optional named corpus for background context (e.g. 'doctrine', 'memory')."),
  corpus_query: z.string().min(1).optional().describe("Corpus query (defaults to the log head)."),
  title: z.string().min(1).max(120).optional().describe("Short human title — used in the artifact header and filename slug."),
  artifact_dir: z.string().min(1).optional().describe("Directory to write the incident.md + incident.json artifact pair. Defaults to ~/.ollama-intern/artifacts/incident/."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional(),
  max_hypotheses: z.number().int().min(1).max(10).optional(),
});

export type IncidentPackInput = z.infer<typeof incidentPackSchema>;

// ── Result shape ────────────────────────────────────────────

export interface StepEntry {
  tool: string;
  ok: boolean;
  elapsed_ms: number;
  warnings?: string[];
  artifact_written?: boolean;
}

export interface IncidentPackSummary {
  hypotheses_count: number;
  affected_surfaces_count: number;
  next_checks_count: number;
  weak: boolean;
  corpus_used: { name: string; chunks_used: number } | null;
}

export interface IncidentPackResult {
  artifact: {
    markdown_path: string;
    json_path: string;
  };
  summary: IncidentPackSummary;
  steps: StepEntry[];
}

// ── Slug + path helpers ─────────────────────────────────────

function defaultArtifactDir(): string {
  return (
    process.env.INTERN_ARTIFACT_DIR
      ? join(process.env.INTERN_ARTIFACT_DIR, "incident")
      : join(homedir(), ".ollama-intern", "artifacts", "incident")
  );
}

function buildSlug(opts: { title?: string; hypothesis?: string; when: Date }): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ts = `${opts.when.getFullYear()}-${pad(opts.when.getMonth() + 1)}-${pad(opts.when.getDate())}-${pad(opts.when.getHours())}${pad(opts.when.getMinutes())}`;
  const source = (opts.title ?? opts.hypothesis ?? "").trim();
  if (source.length === 0) return ts;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .join("-")
    .slice(0, 40);
  return slug.length > 0 ? `${ts}-${slug}` : ts;
}

// ── Markdown renderer (deterministic) ───────────────────────

function renderMarkdown(args: {
  title: string;
  generatedAt: string;
  hardwareProfile: string;
  triage: TriageLogsResult | null;
  brief: IncidentBriefResult;
  steps: StepEntry[];
}): string {
  const lines: string[] = [];
  const b = args.brief;

  lines.push(`# Incident — ${args.title}`);
  lines.push("");
  lines.push(`_Generated ${args.generatedAt} · profile ${args.hardwareProfile}_`);
  lines.push("");

  // ── Incident (pre-brief snapshot + weak banner) ──────────
  lines.push(`## Incident`);
  lines.push("");
  if (args.triage) {
    const errCount = args.triage.errors.length;
    const warnCount = args.triage.warnings.length;
    lines.push(`- ${errCount} error${errCount === 1 ? "" : "s"}, ${warnCount} warning${warnCount === 1 ? "" : "s"} surfaced by triage.`);
    if (args.triage.suspected_root_cause && args.triage.suspected_root_cause !== "NOT_A_LOG") {
      lines.push(`- Triage suspected root cause: ${args.triage.suspected_root_cause}`);
    }
  } else {
    lines.push(`- No log_text provided; triage step skipped.`);
  }
  if (b.weak) {
    lines.push("");
    lines.push(`> ⚠ Weak brief — coverage_notes below name the gaps.`);
  }
  lines.push("");

  // ── Likely root cause ────────────────────────────────────
  lines.push(`## Likely root cause`);
  lines.push("");
  if (b.root_cause_hypotheses.length === 0) {
    lines.push(`_No root-cause hypotheses were produced._`);
  } else {
    for (const h of b.root_cause_hypotheses) {
      const refs = h.evidence_refs.length > 0 ? ` — see ${h.evidence_refs.join(", ")}` : "";
      lines.push(`- **[${h.confidence}]** ${h.hypothesis}${refs}`);
    }
  }
  lines.push("");

  // ── Affected surfaces ────────────────────────────────────
  lines.push(`## Affected surfaces`);
  lines.push("");
  if (b.affected_surfaces.length === 0) {
    lines.push(`_None identified._`);
  } else {
    for (const s of b.affected_surfaces) {
      const refs = s.evidence_refs.length > 0 ? ` — see ${s.evidence_refs.join(", ")}` : "";
      lines.push(`- ${s.surface}${refs}`);
    }
  }
  lines.push("");

  // ── Timeline clues ───────────────────────────────────────
  lines.push(`## Timeline clues`);
  lines.push("");
  if (b.timeline_clues.length === 0) {
    lines.push(`_None identified._`);
  } else {
    for (const c of b.timeline_clues) {
      const refs = c.evidence_refs.length > 0 ? ` — see ${c.evidence_refs.join(", ")}` : "";
      lines.push(`- ${c.clue}${refs}`);
    }
  }
  lines.push("");

  // ── Evidence ─────────────────────────────────────────────
  lines.push(`## Evidence`);
  lines.push("");
  if (b.evidence.length === 0) {
    lines.push(`_No evidence items._`);
  } else {
    for (const e of b.evidence) {
      lines.push(`**[${e.id}]** \`${e.kind}\` — \`${e.ref}\``);
      lines.push("");
      lines.push("```");
      lines.push(e.excerpt.slice(0, 400));
      lines.push("```");
      lines.push("");
    }
  }

  // ── Next checks ──────────────────────────────────────────
  lines.push(`## Next checks`);
  lines.push("");
  if (b.next_checks.length === 0) {
    lines.push(`_No next checks proposed._`);
  } else {
    b.next_checks.forEach((c, i) => {
      const why = c.why.trim().length > 0 ? ` — _${c.why}_` : "";
      lines.push(`${i + 1}. ${c.check}${why}`);
    });
  }
  lines.push("");

  // ── Coverage notes ───────────────────────────────────────
  lines.push(`## Coverage notes`);
  lines.push("");
  if (b.coverage_notes.length === 0) {
    lines.push(`_None._`);
  } else {
    for (const n of b.coverage_notes) lines.push(`- ${n}`);
  }
  lines.push("");

  // ── Step trace ───────────────────────────────────────────
  lines.push(`## Step trace`);
  lines.push("");
  lines.push(`| # | Tool | OK | Elapsed (ms) | Notes |`);
  lines.push(`|---|---|---|---|---|`);
  args.steps.forEach((s, i) => {
    const ok = s.ok ? "✓" : "✗";
    const notes: string[] = [];
    if (s.warnings && s.warnings.length > 0) notes.push(`${s.warnings.length} warning(s)`);
    if (s.artifact_written) notes.push(`artifact written`);
    lines.push(`| ${i + 1} | \`${s.tool}\` | ${ok} | ${s.elapsed_ms} | ${notes.join("; ")} |`);
  });
  lines.push("");

  return lines.join("\n");
}

// ── Handler ─────────────────────────────────────────────────

function assertAtLeastOnePrimary(input: IncidentPackInput): void {
  if (!input.log_text && (!input.source_paths || input.source_paths.length === 0)) {
    throw new InternError(
      "SCHEMA_INVALID",
      "ollama_incident_pack: at least one of log_text or source_paths must be provided.",
      "Pass log_text for raw log blobs, source_paths for files the server should read, or both. Optionally add a corpus for background context.",
      false,
    );
  }
}

export async function handleIncidentPack(
  input: IncidentPackInput,
  ctx: RunContext,
): Promise<Envelope<IncidentPackResult>> {
  assertAtLeastOnePrimary(input);
  const packStartedAt = Date.now();
  const steps: StepEntry[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  // Step 1 — triage_logs (only when log_text is present).
  let triage: TriageLogsResult | null = null;
  if (input.log_text) {
    const t0 = Date.now();
    try {
      const triageEnv = await handleTriageLogs({ log_text: input.log_text }, ctx);
      // Narrow the handleTriageLogs union — we're in single-mode so the
      // result is TriageLogsResult, not BatchResult.
      triage = triageEnv.result as TriageLogsResult;
      tokensIn += triageEnv.tokens_in;
      tokensOut += triageEnv.tokens_out;
      steps.push({
        tool: "ollama_triage_logs",
        ok: true,
        elapsed_ms: Date.now() - t0,
        ...(triageEnv.warnings && triageEnv.warnings.length > 0 ? { warnings: triageEnv.warnings } : {}),
      });
    } catch (err) {
      steps.push({
        tool: "ollama_triage_logs",
        ok: false,
        elapsed_ms: Date.now() - t0,
        warnings: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  // Step 2 — assemble evidence. If corpus is requested, this is also
  // where the embed rail fires. We emit a step entry for corpus_search
  // only when a corpus was actually queried.
  const corpusQuery = input.corpus_query ?? (input.log_text ? input.log_text.slice(0, 400) : "");
  const assembleStart = Date.now();
  const assembled = await assembleEvidence(
    {
      log_text: input.log_text,
      source_paths: input.source_paths,
      corpus: input.corpus,
      corpus_query: corpusQuery,
      per_file_max_chars: input.per_file_max_chars,
    },
    ctx,
  );
  if (input.corpus && assembled.corpus_used) {
    steps.push({
      tool: "ollama_corpus_search",
      ok: true,
      elapsed_ms: Date.now() - assembleStart,
    });
  }

  // Step 3 — incident_brief synthesis, reusing the already-assembled evidence.
  const briefInput: IncidentBriefInput = {
    log_text: input.log_text,
    source_paths: input.source_paths,
    corpus: input.corpus,
    corpus_query: corpusQuery,
    per_file_max_chars: input.per_file_max_chars,
    max_hypotheses: input.max_hypotheses,
  };
  const briefStart = Date.now();
  const briefEnv = await synthesizeIncidentBrief(briefInput, ctx, assembled);
  tokensIn += briefEnv.tokens_in;
  tokensOut += briefEnv.tokens_out;
  steps.push({
    tool: "ollama_incident_brief",
    ok: true,
    elapsed_ms: Date.now() - briefStart,
    ...(briefEnv.warnings && briefEnv.warnings.length > 0 ? { warnings: briefEnv.warnings } : {}),
  });
  const brief = briefEnv.result;

  // Step 4 — artifact write. Deterministic markdown + JSON.
  const artifactDir = input.artifact_dir ?? defaultArtifactDir();
  const when = new Date();
  const firstHypothesis = brief.root_cause_hypotheses[0]?.hypothesis;
  const slug = buildSlug({ title: input.title, hypothesis: firstHypothesis, when });
  const mdPath = join(artifactDir, `${slug}.md`);
  const jsonPath = join(artifactDir, `${slug}.json`);

  const writeStart = Date.now();
  const title = input.title ?? firstHypothesis ?? "incident";
  const generatedAt = when.toISOString();
  const markdown = renderMarkdown({
    title,
    generatedAt,
    hardwareProfile: ctx.hardwareProfile,
    triage,
    brief,
    steps, // snapshot up through synthesize; the artifact-write step self-references without infinite recursion
  });
  const jsonArtifact: IncidentPackArtifact = {
    schema_version: 1,
    pack: "incident_pack",
    generated_at: generatedAt,
    hardware_profile: ctx.hardwareProfile,
    title,
    slug,
    input: {
      has_log_text: Boolean(input.log_text),
      source_paths: input.source_paths ?? [],
      corpus: input.corpus ?? null,
      corpus_query: input.corpus_query ?? null,
    },
    triage,
    brief,
    steps, // same snapshot; populated in full once artifact_write completes below
    artifact: { markdown_path: mdPath, json_path: jsonPath },
  };

  let artifactWritten = true;
  let artifactWarnings: string[] | undefined;
  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(mdPath, markdown, "utf8");
    await writeFile(jsonPath, JSON.stringify(jsonArtifact, null, 2), "utf8");
  } catch (err) {
    artifactWritten = false;
    artifactWarnings = [err instanceof Error ? err.message : String(err)];
  }
  steps.push({
    tool: "artifact_write",
    ok: artifactWritten,
    elapsed_ms: Date.now() - writeStart,
    artifact_written: artifactWritten,
    ...(artifactWarnings ? { warnings: artifactWarnings } : {}),
  });

  // Build pack envelope. Compact response — just paths + counts + trace.
  const result: IncidentPackResult = {
    artifact: { markdown_path: mdPath, json_path: jsonPath },
    summary: {
      hypotheses_count: brief.root_cause_hypotheses.length,
      affected_surfaces_count: brief.affected_surfaces.length,
      next_checks_count: brief.next_checks.length,
      weak: brief.weak,
      corpus_used: brief.corpus_used,
    },
    steps,
  };

  const residency = await ctx.client.residency(briefEnv.model);
  const envelope = buildEnvelope<IncidentPackResult>({
    result,
    tier: "deep",
    model: briefEnv.model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut,
    startedAt: packStartedAt,
    residency,
  });
  await ctx.logger.log(callEvent("ollama_incident_pack", envelope, input));
  return envelope;
}

export interface IncidentPackArtifact {
  schema_version: 1;
  pack: "incident_pack";
  generated_at: string;
  hardware_profile: string;
  title: string;
  slug: string;
  input: {
    has_log_text: boolean;
    source_paths: string[];
    corpus: string | null;
    corpus_query: string | null;
  };
  triage: TriageLogsResult | null;
  brief: IncidentBriefResult;
  steps: StepEntry[];
  artifact: { markdown_path: string; json_path: string };
}

// Internal exports used only by tests.
export const __internal = { buildSlug, renderMarkdown, defaultArtifactDir };
