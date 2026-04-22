/**
 * ollama_change_pack — THIRD PACK. Change-centered review job.
 *
 * Change-first, not repo-first: this pack is about the DELTA, not a
 * general tour. Corpus/context is pulled in only when the caller opts
 * in — otherwise the pack works strictly from diff_text + source_paths
 * (and optionally a CI log_text that caused the review).
 *
 * Fixed pipeline:
 *   1. assemble evidence        (diff + paths + corpus if given)
 *   2. ollama_triage_logs       (ONLY when log_text is provided)
 *   3. ollama_change_brief      (via synthesizeChangeBrief — evidence reused)
 *   4. ollama_extract (narrow)  (scripts_touched / config_surfaces /
 *                                runtime_hints — fixed review schema)
 *   5. artifact_write           (deterministic markdown + JSON)
 *
 * Release-note draft discipline: the draft lives in the brief's
 * `release_note_draft` field under a prompt that already forbids
 * promotional copy. The markdown renders it as a blockquote to signal
 * "DRAFT the operator reviews" — not final copy.
 *
 * No VCS integration. Strong job shape without control-plane creep.
 */

import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Envelope } from "../../envelope.js";
import { buildEnvelope } from "../../envelope.js";
import { callEvent, packStepEvent } from "../../observability.js";
import type { RunContext } from "../../runContext.js";
import { InternError } from "../../errors.js";
import { assembleEvidence } from "../briefs/common.js";
import { loadSources, formatSourcesBlock } from "../../sources.js";
import { handleTriageLogs, type TriageLogsResult } from "../triageLogs.js";
import {
  synthesizeChangeBrief,
  type ChangeBriefInput,
  type ChangeBriefResult,
} from "../changeBrief.js";
import { handleExtract, type ExtractResult } from "../extract.js";
import { strictStringArray } from "../../guardrails/stringifiedArrayGuard.js";
import { normalizeCorpusQuery } from "../_helpers.js";

// ── Schema ──────────────────────────────────────────────────

export const changePackSchema = z.object({
  diff_text: z.string().min(1).optional().describe("Unified-diff text (e.g. `git diff` output). Split per file on `diff --git` markers. At least one of diff_text or source_paths is required."),
  source_paths: strictStringArray({ min: 0, fieldName: "source_paths" }).optional().describe("Changed files to read server-side (Claude does not preload). Alongside or instead of diff_text. Optional — diff-driven calls work without it; runtime requires at least one of diff_text or source_paths."),
  log_text: z.string().min(1).optional().describe("Optional CI log that triggered this review. When present, triage_logs runs and its signal is surfaced in the Change section."),
  corpus: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .optional()
    .describe("Optional named corpus for architecture/doctrine context. Pulled in only when you need it to sharpen impact — this pack is about the delta, not a repo tour."),
  corpus_query: z.string().min(1).optional().describe("Corpus query (defaults to the head of diff_text or first source path)."),
  title: z.string().min(1).max(120).optional().describe("Short human title — used in the artifact header and filename slug. Defaults to the change_summary head."),
  artifact_dir: z.string().min(1).optional().describe("Directory to write the change.md + change.json artifact pair. Defaults to ~/.ollama-intern/artifacts/change/."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional(),
  max_breakpoints: z.number().int().min(1).max(12).optional(),
  max_validation_checks: z.number().int().min(1).max(15).optional(),
});

export type ChangePackInput = z.infer<typeof changePackSchema>;

// ── Targeted extract schema (FIXED — change-review needs only) ──

const CHANGE_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    scripts_touched: {
      type: "array",
      items: { type: "string" },
      description: "Names of scripts or commands altered by this change (npm scripts, Makefile targets, task runners).",
    },
    config_surfaces: {
      type: "array",
      items: { type: "string" },
      description: "Configuration files or settings changed by this delta.",
    },
    runtime_hints: {
      type: "array",
      items: { type: "string" },
      description: "Runtime or version requirements stated or altered (Node version, Python version, compiler target).",
    },
  },
} as const;

export interface ChangeFacts {
  scripts_touched?: string[];
  config_surfaces?: string[];
  runtime_hints?: string[];
}

// ── Result shape ────────────────────────────────────────────

export interface StepEntry {
  tool: string;
  ok: boolean;
  elapsed_ms: number;
  warnings?: string[];
  artifact_written?: boolean;
}

export interface ChangePackSummary {
  affected_surfaces_count: number;
  likely_breakpoints_count: number;
  validation_checks_count: number;
  release_note_present: boolean;
  extracted_facts_present: boolean;
  triage_ran: boolean;
  weak: boolean;
  corpus_used: { name: string; chunks_used: number } | null;
}

export interface ChangePackResult {
  artifact: {
    markdown_path: string;
    json_path: string;
  };
  summary: ChangePackSummary;
  steps: StepEntry[];
}

// ── Helpers ─────────────────────────────────────────────────

function assertAtLeastOnePrimary(input: ChangePackInput): void {
  if (!input.diff_text && (!input.source_paths || input.source_paths.length === 0)) {
    throw new InternError(
      "SCHEMA_INVALID",
      "ollama_change_pack: at least one of diff_text or source_paths must be provided.",
      "Pass diff_text for unified-diff output, source_paths for changed files, or both. log_text and corpus are optional add-ons.",
      false,
    );
  }
}

function defaultArtifactDir(): string {
  return (
    process.env.INTERN_ARTIFACT_DIR
      ? join(process.env.INTERN_ARTIFACT_DIR, "change")
      : join(homedir(), ".ollama-intern", "artifacts", "change")
  );
}

function buildSlug(opts: { title?: string; summaryHead?: string; when: Date }): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ts = `${opts.when.getFullYear()}-${pad(opts.when.getMonth() + 1)}-${pad(opts.when.getDate())}-${pad(opts.when.getHours())}${pad(opts.when.getMinutes())}`;
  const source = (opts.title ?? opts.summaryHead ?? "").trim();
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

function renderFactsInline(facts: ChangeFacts | null): string[] {
  if (!facts) return [];
  const out: string[] = [];
  if (facts.scripts_touched && facts.scripts_touched.length > 0) {
    out.push(`- **Scripts touched:** ${facts.scripts_touched.map((s) => `\`${s}\``).join(", ")}`);
  }
  if (facts.config_surfaces && facts.config_surfaces.length > 0) {
    out.push(`- **Config surfaces:** ${facts.config_surfaces.map((c) => `\`${c}\``).join(", ")}`);
  }
  if (facts.runtime_hints && facts.runtime_hints.length > 0) {
    out.push(`- **Runtime hints:** ${facts.runtime_hints.join(", ")}`);
  }
  return out;
}

function renderMarkdown(args: {
  title: string;
  generatedAt: string;
  hardwareProfile: string;
  triage: TriageLogsResult | null;
  brief: ChangeBriefResult;
  facts: ChangeFacts | null;
  steps: StepEntry[];
}): string {
  const lines: string[] = [];
  const b = args.brief;

  lines.push(`# Change — ${args.title}`);
  lines.push("");
  lines.push(`_Generated ${args.generatedAt} · profile ${args.hardwareProfile}_`);
  lines.push("");

  // ── Change (CI signal + weak banner) ─────────────────────
  lines.push(`## Change`);
  lines.push("");
  if (args.triage) {
    const errCount = args.triage.errors.length;
    const warnCount = args.triage.warnings.length;
    lines.push(`- ${errCount} error${errCount === 1 ? "" : "s"}, ${warnCount} warning${warnCount === 1 ? "" : "s"} in the CI log.`);
    if (args.triage.suspected_root_cause && args.triage.suspected_root_cause !== "NOT_A_LOG") {
      lines.push(`- Triage suspected root cause: ${args.triage.suspected_root_cause}`);
    }
  } else {
    lines.push(`- No CI log was provided; triage step skipped.`);
  }
  if (b.weak) {
    lines.push("");
    lines.push(`> ⚠ Weak brief — coverage_notes below name the gaps.`);
  }
  lines.push("");

  // ── Summary (brief prose + optional extracted bullets) ──
  lines.push(`## Summary`);
  lines.push("");
  if (b.change_summary.trim().length > 0) {
    lines.push(b.change_summary.trim());
  } else {
    lines.push(`_The brief produced no change_summary._`);
  }
  const factLines = renderFactsInline(args.facts);
  if (factLines.length > 0) {
    lines.push("");
    for (const l of factLines) lines.push(l);
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

  // ── Why it matters ───────────────────────────────────────
  lines.push(`## Why it matters`);
  lines.push("");
  if (b.why_it_matters.trim().length > 0) {
    lines.push(b.why_it_matters.trim());
  } else {
    lines.push(`_The brief produced no why_it_matters._`);
  }
  lines.push("");

  // ── Likely breakpoints ───────────────────────────────────
  lines.push(`## Likely breakpoints`);
  lines.push("");
  if (b.likely_breakpoints.length === 0) {
    lines.push(`_None identified._`);
  } else {
    for (const bp of b.likely_breakpoints) {
      const refs = bp.evidence_refs.length > 0 ? ` — see ${bp.evidence_refs.join(", ")}` : "";
      lines.push(`- ${bp.breakpoint}${refs}`);
    }
  }
  lines.push("");

  // ── Validation checks ────────────────────────────────────
  lines.push(`## Validation checks`);
  lines.push("");
  if (b.validation_checks.length === 0) {
    lines.push(`_No validation checks proposed._`);
  } else {
    b.validation_checks.forEach((c, i) => {
      const why = c.why.trim().length > 0 ? ` — _${c.why}_` : "";
      lines.push(`${i + 1}. ${c.check}${why}`);
    });
  }
  lines.push("");

  // ── Release note draft (blockquote signals DRAFT) ───────
  lines.push(`## Release note draft`);
  lines.push("");
  if (b.release_note_draft.trim().length > 0) {
    const quoted = b.release_note_draft.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n");
    lines.push(quoted);
    lines.push("");
    lines.push(`_Draft — the operator reviews before publishing._`);
  } else {
    lines.push(`_No release note draft produced._`);
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

export async function handleChangePack(
  input: ChangePackInput,
  ctx: RunContext,
): Promise<Envelope<ChangePackResult>> {
  assertAtLeastOnePrimary(input);
  const packStartedAt = Date.now();
  const steps: StepEntry[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  // Fixed change-pack pipeline: assemble → triage → brief → extract →
  // artifact_write. Total remains 5 even when triage is skipped so operator
  // UIs see a stable denominator across runs.
  const TOTAL_STEPS = 5;

  // Step 1 — assemble evidence (diff + paths + corpus if provided).
  await ctx.logger.log(packStepEvent({ pack: "change", step: "assemble_evidence", step_index: 1, total_steps: TOTAL_STEPS }));
  const sanitizedUserQuery = normalizeCorpusQuery(input.corpus_query);
  const fallbackQuery = input.diff_text
    ? input.diff_text.slice(0, 400)
    : (input.source_paths?.[0] ?? "");
  const corpusQuery = sanitizedUserQuery ?? fallbackQuery;
  const assembleStart = Date.now();
  const assembled = await assembleEvidence(
    {
      diff_text: input.diff_text,
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

  // Step 2 — triage_logs (only when log_text is provided).
  let triage: TriageLogsResult | null = null;
  if (input.log_text) {
    await ctx.logger.log(packStepEvent({ pack: "change", step: "triage", step_index: 2, total_steps: TOTAL_STEPS }));
    const t0 = Date.now();
    try {
      const triageEnv = await handleTriageLogs({ log_text: input.log_text }, ctx);
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

  // Step 3 — change_brief synthesis, reusing the evidence.
  await ctx.logger.log(packStepEvent({ pack: "change", step: "brief", step_index: 3, total_steps: TOTAL_STEPS }));
  const briefInput: ChangeBriefInput = {
    diff_text: input.diff_text,
    source_paths: input.source_paths,
    corpus: input.corpus,
    corpus_query: corpusQuery,
    per_file_max_chars: input.per_file_max_chars,
    max_breakpoints: input.max_breakpoints,
    max_validation_checks: input.max_validation_checks,
  };
  const briefStart = Date.now();
  const briefEnv = await synthesizeChangeBrief(briefInput, ctx, assembled);
  tokensIn += briefEnv.tokens_in;
  tokensOut += briefEnv.tokens_out;
  steps.push({
    tool: "ollama_change_brief",
    ok: true,
    elapsed_ms: Date.now() - briefStart,
    ...(briefEnv.warnings && briefEnv.warnings.length > 0 ? { warnings: briefEnv.warnings } : {}),
  });
  const brief = briefEnv.result;

  // Step 4 — targeted extract. Feed source_paths content when present,
  // otherwise the diff. Corpus is NOT passed to extract — corpus is
  // doctrine, not delta material.
  await ctx.logger.log(packStepEvent({ pack: "change", step: "extract", step_index: 4, total_steps: TOTAL_STEPS }));
  const perFileMax = input.per_file_max_chars ?? 20_000;
  let extractInputText = "";
  if (input.source_paths && input.source_paths.length > 0) {
    const sources = await loadSources(input.source_paths, perFileMax);
    extractInputText = formatSourcesBlock(sources);
  } else if (input.diff_text) {
    extractInputText = input.diff_text;
  }

  let facts: ChangeFacts | null = null;
  const extractStart = Date.now();
  try {
    const extractEnv = await handleExtract(
      {
        text: extractInputText,
        schema: CHANGE_EXTRACT_SCHEMA as unknown as Record<string, unknown>,
        hint: "Extract ONLY concrete review facts from the change. Leave arrays empty if not present. Do not invent values. Do not include anything beyond scripts_touched, config_surfaces, runtime_hints.",
      },
      ctx,
    );
    tokensIn += extractEnv.tokens_in;
    tokensOut += extractEnv.tokens_out;
    const extractResult = extractEnv.result as ExtractResult;
    let extractWarning: string | null = null;
    if (extractResult.ok) {
      facts = extractResult.data as ChangeFacts;
    } else {
      extractWarning = "Extract output was unparseable; review facts omitted.";
    }
    steps.push({
      tool: "ollama_extract",
      ok: extractResult.ok,
      elapsed_ms: Date.now() - extractStart,
      ...(extractWarning ? { warnings: [extractWarning] } : {}),
    });
  } catch (err) {
    steps.push({
      tool: "ollama_extract",
      ok: false,
      elapsed_ms: Date.now() - extractStart,
      warnings: [err instanceof Error ? err.message : String(err)],
    });
  }

  // Step 5 — artifact write.
  await ctx.logger.log(packStepEvent({ pack: "change", step: "artifact_write", step_index: 5, total_steps: TOTAL_STEPS }));
  const artifactDir = input.artifact_dir ?? defaultArtifactDir();
  const when = new Date();
  const summaryHead = brief.change_summary.split(/[.\n]/)[0]?.trim();
  const slug = buildSlug({ title: input.title, summaryHead, when });
  const mdPath = join(artifactDir, `${slug}.md`);
  const jsonPath = join(artifactDir, `${slug}.json`);

  const writeStart = Date.now();
  const title = input.title ?? (summaryHead && summaryHead.length > 0 ? summaryHead : "change");
  const generatedAt = when.toISOString();
  const markdown = renderMarkdown({
    title,
    generatedAt,
    hardwareProfile: ctx.hardwareProfile,
    triage,
    brief,
    facts,
    steps, // pre-write snapshot; markdown omits artifact_write
  });
  const jsonArtifact: ChangePackArtifact = {
    schema_version: 1,
    pack: "change_pack",
    generated_at: generatedAt,
    hardware_profile: ctx.hardwareProfile,
    title,
    slug,
    input: {
      has_diff_text: Boolean(input.diff_text),
      has_log_text: Boolean(input.log_text),
      source_paths: input.source_paths ?? [],
      corpus: input.corpus ?? null,
      corpus_query: input.corpus_query ?? null,
    },
    triage,
    brief,
    extracted_facts: facts,
    steps,
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

  const result: ChangePackResult = {
    artifact: { markdown_path: mdPath, json_path: jsonPath },
    summary: {
      affected_surfaces_count: brief.affected_surfaces.length,
      likely_breakpoints_count: brief.likely_breakpoints.length,
      validation_checks_count: brief.validation_checks.length,
      release_note_present: brief.release_note_draft.trim().length > 0,
      extracted_facts_present: facts !== null,
      triage_ran: triage !== null,
      weak: brief.weak,
      corpus_used: brief.corpus_used,
    },
    steps,
  };

  const residency = await ctx.client.residency(briefEnv.model);
  const envelope = buildEnvelope<ChangePackResult>({
    result,
    tier: "deep",
    model: briefEnv.model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut,
    startedAt: packStartedAt,
    residency,
  });
  await ctx.logger.log(callEvent("ollama_change_pack", envelope));
  return envelope;
}

export interface ChangePackArtifact {
  schema_version: 1;
  pack: "change_pack";
  generated_at: string;
  hardware_profile: string;
  title: string;
  slug: string;
  input: {
    has_diff_text: boolean;
    has_log_text: boolean;
    source_paths: string[];
    corpus: string | null;
    corpus_query: string | null;
  };
  triage: TriageLogsResult | null;
  brief: ChangeBriefResult;
  extracted_facts: ChangeFacts | null;
  steps: StepEntry[];
  artifact: { markdown_path: string; json_path: string };
}

// Internal exports used only by tests.
export const __internal = { buildSlug, renderMarkdown, CHANGE_EXTRACT_SCHEMA };
