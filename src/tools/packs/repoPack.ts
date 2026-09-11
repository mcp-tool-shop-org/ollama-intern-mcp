/**
 * ollama_repo_pack — SECOND PACK. Onboarding job, not repo Q&A.
 *
 * Fixed pipeline (deterministic, no agent routing):
 *   1. assemble evidence           (source_paths + corpus_search if corpus)
 *   2. ollama_repo_brief           (via synthesizeRepoBrief — reuses evidence)
 *   3. ollama_extract (narrow)     (concrete onboarding facts only)
 *   4. artifact_write              (deterministic markdown + JSON)
 *
 * Corpus-first posture: when a corpus is declared, it's queried for
 * cross-cutting context and its chunks count as evidence. Source paths
 * still feed the brief AND are the sole input to extract — corpus is
 * doctrine, source_paths are the concrete repo.
 *
 * Extract is TARGETED — fixed, narrow schema for onboarding facts the
 * brief should not improvise:
 *   package_names, entrypoints, scripts, config_files,
 *   exposed_surfaces, runtime_hints.
 * Callers cannot widen the extract schema — that's the job-shape law.
 *
 * Artifact paths:
 *   <artifact_dir>/<YYYY-MM-DD-HHMM[-slug]>.md
 *   <artifact_dir>/<YYYY-MM-DD-HHMM[-slug]>.json
 * Default artifact_dir = ~/.ollama-intern/artifacts/repo/.
 *
 * MCP response is compact: paths + summary + steps. The full brief +
 * extracted facts live in the artifact, not the MCP payload.
 */

import { z } from "zod";
import { resolveUniqueArtifactPaths, writeArtifactPair, resolvePackArtifactDir, assertPackArtifactWriteAllowed } from "./artifactWrite.js";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";

import type { Envelope } from "../../envelope.js";
import { buildEnvelope } from "../../envelope.js";
import { callEvent } from "../../observability.js";
import type { RunContext } from "../../runContext.js";
import {
  withRunContext as withRunCorrelation,
  mintRunId,
  getRunContext as getRunCorrelation,
} from "../../runContext.js";
import {
  buildPackStepEventWithCorrelation as packStepEvent,
  withCallContext,
  mintCallId,
  getCallContext,
} from "../_runContext.js";
import { assembleEvidence } from "../briefs/common.js";
import { renderEvidenceMarkdown } from "../briefs/evidence.js";
import { loadSources, formatSourcesBlock } from "../../sources.js";
import {
  synthesizeRepoBrief,
  type RepoBriefInput,
  type RepoBriefResult,
} from "../repoBrief.js";
import { handleExtract, type ExtractResult } from "../extract.js";
import {
  normalizeCorpusQuery,
  allowlistPathsMatch,
  MAX_CORPUS_QUERY_CHARS,
  CORPUS_QUERY_CAP_NOTE,
} from "../_helpers.js";

// ── Schema ──────────────────────────────────────────────────

export const repoPackSchema = z.object({
  source_paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Files the onboarding brief should read (README, key src entries, package/manifest, docs). Required — these are the repo's concrete source-of-truth."),
  corpus: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .optional()
    .describe("Optional named corpus (e.g. 'handbook', 'doctrine') for cross-cutting architecture context. When given, queried as the pack's main working surface alongside source_paths."),
  corpus_query: z
    .string()
    .min(1)
    // Bound in the SCHEMA so the client's picker renders the limit — the
    // runtime normalizeCorpusQuery re-checks the fence/newline-stripped
    // form as defence-in-depth. A pack that refuses at char 201 halfway
    // through a multi-step run must have shown the cap up front.
    .max(MAX_CORPUS_QUERY_CHARS, `corpus_query must be ${MAX_CORPUS_QUERY_CHARS} characters or fewer`)
    .optional()
    .describe("Corpus query (defaults to 'repo architecture and surfaces')." + CORPUS_QUERY_CAP_NOTE),
  title: z.string().min(1).max(120).optional().describe("Short human title — used in the artifact header and filename slug. Defaults to the repo thesis head."),
  artifact_dir: z.string().min(1).optional().describe("Directory to write the repo.md + repo.json artifact pair. Defaults to ~/.ollama-intern/artifacts/repo/."),
  allowed_roots: z
    .array(z.string().min(1))
    .optional()
    .describe("Absolute directories artifact_dir may live under when it is not inside INTERN_ARTIFACT_DIR. Same dual-declaration as ollama_artifact_export_to_path."),
  confirm_write: z
    .boolean()
    .optional()
    .describe("Required when the artifact pair would land on a protected path (.git/, SECURITY.md, memory/, ...). Same gate as ollama_draft."),
  // Forwarded verbatim to the brief step, so these carry the SAME meanings
  // and the SAME defaults as the ollama_repo_brief siblings — describe them
  // identically rather than shipping bare `number` fields with no unit.
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars per source file (default 20k)."),
  max_key_surfaces: z.number().int().min(1).max(20).optional().describe("Cap on key_surfaces (default 8)."),
  max_risk_areas: z.number().int().min(1).max(10).optional().describe("Cap on risk_areas (default 5)."),
  max_read_next: z.number().int().min(1).max(15).optional().describe("Cap on read_next (default 8)."),
});

export type RepoPackInput = z.infer<typeof repoPackSchema>;

// ── Targeted extract schema (FIXED — not caller-configurable) ───

const ONBOARDING_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    package_names: {
      type: "array",
      items: { type: "string" },
      description: "Package / module names declared by the repo (npm, PyPI, crate, etc.).",
    },
    entrypoints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          purpose: { type: "string" },
        },
      },
      description: "Executable entry points (bin files, main modules, server launchers).",
    },
    scripts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          command: { type: "string" },
        },
      },
      description: "Named commands the repo advertises (npm scripts, Makefile targets, task runners).",
    },
    config_files: {
      type: "array",
      items: { type: "string" },
      description: "Configuration files that control build/runtime behavior.",
    },
    exposed_surfaces: {
      type: "array",
      items: { type: "string" },
      description: "User-facing surfaces this repo exposes (CLI, HTTP API, MCP server, library export, etc.).",
    },
    runtime_hints: {
      type: "array",
      items: { type: "string" },
      description: "Runtime / version requirements stated in the repo (Node version, Python version, compiler target).",
    },
  },
} as const;

export interface OnboardingFacts {
  package_names?: string[];
  entrypoints?: Array<{ file?: string; purpose?: string }>;
  scripts?: Array<{ name?: string; command?: string }>;
  config_files?: string[];
  exposed_surfaces?: string[];
  runtime_hints?: string[];
  /** Paths the model named that were stripped (not in source_paths, not on disk). */
  unverified_paths?: string[];
}

/**
 * Sanitize untrusted extract output into the OnboardingFacts shape.
 *
 * extract.handleExtract returns ExtractResult.data as `unknown` — the model
 * may have produced "string-instead-of-array" / mixed-type entries / null
 * inside arrays. A bare cast `as OnboardingFacts` would compile but throw
 * at render time when `.map()` hits a non-array or `.file` on null.
 *
 * Rules:
 *   - Returns a fully-shaped object with safe defaults (empty arrays).
 *   - Drops non-string entries from string arrays.
 *   - Drops non-object entries from object arrays.
 *   - Coerces a single string-where-array-was-expected into a 1-element array.
 *   - Never throws on malformed input — only sanitizes.
 */
export function coerceOnboardingFacts(data: unknown): OnboardingFacts {
  const obj = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};

  const stringArray = (v: unknown): string[] => {
    if (typeof v === "string") return v.length > 0 ? [v] : [];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
  };

  const entrypointArray = (v: unknown): Array<{ file?: string; purpose?: string }> => {
    if (!Array.isArray(v)) return [];
    const out: Array<{ file?: string; purpose?: string }> = [];
    for (const entry of v) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const item: { file?: string; purpose?: string } = {};
      if (typeof e.file === "string") item.file = e.file;
      if (typeof e.purpose === "string") item.purpose = e.purpose;
      out.push(item);
    }
    return out;
  };

  const scriptArray = (v: unknown): Array<{ name?: string; command?: string }> => {
    if (!Array.isArray(v)) return [];
    const out: Array<{ name?: string; command?: string }> = [];
    for (const entry of v) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      const item: { name?: string; command?: string } = {};
      if (typeof e.name === "string") item.name = e.name;
      if (typeof e.command === "string") item.command = e.command;
      out.push(item);
    }
    return out;
  };

  return {
    package_names: stringArray(obj.package_names),
    entrypoints: entrypointArray(obj.entrypoints),
    scripts: scriptArray(obj.scripts),
    config_files: stringArray(obj.config_files),
    exposed_surfaces: stringArray(obj.exposed_surfaces),
    runtime_hints: stringArray(obj.runtime_hints),
  };
}

function pathsEquivalent(a: string, b: string): boolean {
  return allowlistPathsMatch(a, b);
}

function isUnderRoot(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function onboardingPathVerified(candidate: string, sourcePaths: string[]): Promise<boolean> {
  for (const sp of sourcePaths) {
    if (pathsEquivalent(candidate, sp)) return true;
  }
  const roots = [...new Set(sourcePaths.map((sp) => dirname(resolve(sp))))];
  const probes: string[] = isAbsolute(candidate)
    ? [resolve(candidate)]
    : roots.map((r) => resolve(r, candidate));
  for (const probe of probes) {
    if (!roots.some((r) => isUnderRoot(probe, r))) continue;
    try {
      const st = await stat(probe);
      if (st.isFile()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Drop entrypoint.file / config_files strings that are not a loaded
 * source_paths entry and do not exist on disk under those roots.
 * Invented paths go to unverified_paths + a coverage note.
 */
async function scrubOnboardingPaths(
  facts: OnboardingFacts,
  sourcePaths: string[],
): Promise<{ facts: OnboardingFacts; coverageNote: string | null }> {
  const stripped: string[] = [];
  const entrypoints: Array<{ file?: string; purpose?: string }> = [];
  for (const e of facts.entrypoints ?? []) {
    if (typeof e.file === "string" && e.file.length > 0) {
      if (await onboardingPathVerified(e.file, sourcePaths)) {
        entrypoints.push(e);
      } else {
        stripped.push(e.file);
        if (e.purpose) entrypoints.push({ purpose: e.purpose });
      }
    } else {
      entrypoints.push(e);
    }
  }
  const config_files: string[] = [];
  for (const f of facts.config_files ?? []) {
    if (await onboardingPathVerified(f, sourcePaths)) {
      config_files.push(f);
    } else {
      stripped.push(f);
    }
  }
  const next: OnboardingFacts = {
    ...facts,
    entrypoints,
    config_files,
  };
  if (stripped.length > 0) {
    next.unverified_paths = stripped;
    const listed = stripped.map((p) => `\`${p}\``).join(", ");
    return {
      facts: next,
      coverageNote: `Dropped ${stripped.length} invented onboarding path(s) not in source_paths and not present on disk: ${listed}.`,
    };
  }
  return { facts: next, coverageNote: null };
}

// ── Result shape ────────────────────────────────────────────

export interface StepEntry {
  tool: string;
  ok: boolean;
  elapsed_ms: number;
  warnings?: string[];
  artifact_written?: boolean;
}

export interface RepoPackSummary {
  key_surfaces_count: number;
  risk_areas_count: number;
  read_next_count: number;
  extracted_facts_present: boolean;
  weak: boolean;
  corpus_used: { name: string; chunks_used: number } | null;
}

export interface RepoPackResult {
  artifact: {
    /**
     * Path to the written markdown artifact. `null` when the artifact
     * write failed — the pack still ran successfully, but the caller
     * MUST NOT pass this to artifact_read (which would surface a
     * confusing SOURCE_PATH_NOT_FOUND with no link back to the original
     * write error). When `null`, see `artifact.error` for the operator-
     * facing reason, and `summary` for the data that would have been
     * persisted.
     */
    markdown_path: string | null;
    /** Path to the written JSON artifact. `null` on write failure — same contract as `markdown_path`. */
    json_path: string | null;
    /**
     * Populated only when the write failed. Names the path the pack
     * attempted to write to and the underlying filesystem error, so the
     * caller can surface a single coherent error instead of a
     * write-failure → later-read-failure chain.
     */
    error?: {
      attempted_markdown_path: string;
      attempted_json_path: string;
      reason: string;
    };
  };
  summary: RepoPackSummary;
  steps: StepEntry[];
}

// ── Path / slug helpers ─────────────────────────────────────

function defaultArtifactDir(): string {
  return (
    process.env.INTERN_ARTIFACT_DIR
      ? join(process.env.INTERN_ARTIFACT_DIR, "repo")
      : join(homedir(), ".ollama-intern", "artifacts", "repo")
  );
}

function buildSlug(opts: { title?: string; thesisHead?: string; when: Date }): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ts = `${opts.when.getFullYear()}-${pad(opts.when.getMonth() + 1)}-${pad(opts.when.getDate())}-${pad(opts.when.getHours())}${pad(opts.when.getMinutes())}`;
  const source = (opts.title ?? opts.thesisHead ?? "").trim();
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

function renderFactsBlock(facts: OnboardingFacts | null): string[] {
  if (!facts) return ["_Extract step did not produce structured facts._"];
  const out: string[] = [];

  if (facts.package_names && facts.package_names.length > 0) {
    out.push(`**Packages:** ${facts.package_names.map((p) => `\`${p}\``).join(", ")}`);
  }
  if (facts.exposed_surfaces && facts.exposed_surfaces.length > 0) {
    out.push(`**Exposed surfaces:** ${facts.exposed_surfaces.join(", ")}`);
  }
  if (facts.runtime_hints && facts.runtime_hints.length > 0) {
    out.push(`**Runtime hints:** ${facts.runtime_hints.join(", ")}`);
  }
  if (facts.entrypoints && facts.entrypoints.length > 0) {
    out.push(``);
    out.push(`**Entrypoints:**`);
    for (const e of facts.entrypoints) {
      const file = e.file ?? "?";
      const purpose = e.purpose ? ` — ${e.purpose}` : "";
      out.push(`- \`${file}\`${purpose}`);
    }
  }
  if (facts.scripts && facts.scripts.length > 0) {
    out.push(``);
    out.push(`**Scripts:**`);
    for (const s of facts.scripts) {
      const name = s.name ?? "?";
      const cmd = s.command ?? "";
      out.push(`- \`${name}\`${cmd ? `: \`${cmd}\`` : ""}`);
    }
  }
  if (facts.config_files && facts.config_files.length > 0) {
    out.push(``);
    out.push(`**Config files:** ${facts.config_files.map((f) => `\`${f}\``).join(", ")}`);
  }
  if (out.length === 0) return ["_Extract step produced an empty onboarding record._"];
  return out;
}

function renderMarkdown(args: {
  title: string;
  generatedAt: string;
  hardwareProfile: string;
  brief: RepoBriefResult;
  facts: OnboardingFacts | null;
  steps: StepEntry[];
}): string {
  const lines: string[] = [];
  const b = args.brief;

  lines.push(`# Repo — ${args.title}`);
  lines.push("");
  lines.push(`_Generated ${args.generatedAt} · profile ${args.hardwareProfile}_`);
  lines.push("");

  // ── Thesis ───────────────────────────────────────────────
  lines.push(`## Thesis`);
  lines.push("");
  if (b.repo_thesis.trim().length > 0) {
    lines.push(b.repo_thesis.trim());
  } else {
    lines.push(`_The brief produced no thesis._`);
  }
  if (b.weak) {
    lines.push("");
    lines.push(`> ⚠ Weak brief — coverage_notes below name the gaps.`);
  }
  lines.push("");

  // ── Key surfaces ─────────────────────────────────────────
  lines.push(`## Key surfaces`);
  lines.push("");
  if (b.key_surfaces.length === 0) {
    lines.push(`_None identified._`);
  } else {
    for (const s of b.key_surfaces) {
      const refs = s.evidence_refs.length > 0 ? ` — see ${s.evidence_refs.join(", ")}` : "";
      const why = s.why.trim().length > 0 ? ` — _${s.why}_` : "";
      lines.push(`- **${s.surface}**${why}${refs}`);
    }
  }
  lines.push("");

  // ── Architecture shape ───────────────────────────────────
  lines.push(`## Architecture shape`);
  lines.push("");
  if (b.architecture_shape.trim().length > 0) {
    lines.push(b.architecture_shape.trim());
  } else {
    lines.push(`_The brief produced no architecture shape._`);
  }
  lines.push("");

  // ── Risk areas ───────────────────────────────────────────
  lines.push(`## Risk areas`);
  lines.push("");
  if (b.risk_areas.length === 0) {
    lines.push(`_None identified._`);
  } else {
    for (const r of b.risk_areas) {
      const refs = r.evidence_refs.length > 0 ? ` — see ${r.evidence_refs.join(", ")}` : "";
      lines.push(`- ${r.risk}${refs}`);
    }
  }
  lines.push("");

  // ── Read next ────────────────────────────────────────────
  lines.push(`## Read next`);
  lines.push("");
  if (b.read_next.length === 0) {
    lines.push(`_No read-next recommendations._`);
  } else {
    b.read_next.forEach((r, i) => {
      const why = r.why.trim().length > 0 ? ` — _${r.why}_` : "";
      lines.push(`${i + 1}. \`${r.file}\`${why}`);
    });
  }
  lines.push("");

  // ── Extracted facts ──────────────────────────────────────
  lines.push(`## Extracted facts`);
  lines.push("");
  for (const line of renderFactsBlock(args.facts)) lines.push(line);
  lines.push("");

  // ── Evidence ─────────────────────────────────────────────
  lines.push(`## Evidence`);
  lines.push("");
  if (b.evidence.length === 0) {
    lines.push(`_No evidence items._`);
  } else {
    // Clip at the item's own per-kind cap (and mark the clip) rather than a
    // flat display literal — keeps this half of the pair in step with the
    // .json sibling. See briefs/evidence.ts renderEvidenceMarkdown.
    for (const e of b.evidence) {
      for (const line of renderEvidenceMarkdown(e)) lines.push(line);
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

export async function handleRepoPack(
  input: RepoPackInput,
  ctx: RunContext,
): Promise<Envelope<RepoPackResult>> {
  // FT-010: inherit run_id from backend-core's ALS (MCP wrap path mints
  // it) or mint one defensively for test invocations. Pack-level
  // call_id is the parent_call_id for every emitted pack_step event;
  // nested runTool calls enter their own call scopes so their call_id
  // mutations don't leak back.
  const existingRun = getRunCorrelation();
  if (existingRun) {
    return withCallContext({ call_id: mintCallId() }, () => handleRepoPackInner(input, ctx));
  }
  const run_id = mintRunId();
  return withRunCorrelation({ run_id, started_at: new Date().toISOString() }, () =>
    withCallContext({ call_id: mintCallId() }, () => handleRepoPackInner(input, ctx)),
  );
}

async function handleRepoPackInner(
  input: RepoPackInput,
  ctx: RunContext,
): Promise<Envelope<RepoPackResult>> {
  const packStartedAt = Date.now();
  const steps: StepEntry[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  // Fixed repo-pack pipeline: assemble → brief → extract → artifact_write.
  const TOTAL_STEPS = 4;

  // Step 1 — assemble evidence (source_paths + corpus if given).
  await ctx.logger.log(packStepEvent({ pack: "repo", step: "assemble_evidence", step_index: 1, total_steps: TOTAL_STEPS }));
  const sanitizedUserQuery = normalizeCorpusQuery(input.corpus_query);
  const corpusQuery = sanitizedUserQuery ?? "repo architecture and surfaces";
  const assembleStart = Date.now();
  const assembled = await assembleEvidence(
    {
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

  // Step 2 — repo_brief synthesis, reusing the evidence.
  await ctx.logger.log(packStepEvent({ pack: "repo", step: "brief", step_index: 2, total_steps: TOTAL_STEPS }));
  const briefInput: RepoBriefInput = {
    source_paths: input.source_paths,
    corpus: input.corpus,
    corpus_query: corpusQuery,
    per_file_max_chars: input.per_file_max_chars,
    max_key_surfaces: input.max_key_surfaces,
    max_risk_areas: input.max_risk_areas,
    max_read_next: input.max_read_next,
  };
  const briefStart = Date.now();
  const briefEnv = await synthesizeRepoBrief(briefInput, ctx, assembled);
  tokensIn += briefEnv.tokens_in;
  tokensOut += briefEnv.tokens_out;
  steps.push({
    tool: "ollama_repo_brief",
    ok: true,
    elapsed_ms: Date.now() - briefStart,
    ...(briefEnv.warnings && briefEnv.warnings.length > 0 ? { warnings: briefEnv.warnings } : {}),
  });
  const brief = briefEnv.result;

  // Step 3 — targeted extract over concatenated source_paths content.
  // Corpus is NOT passed to extract: corpus is doctrine; extract mines
  // the concrete repo. Source_paths are already loaded — re-reading
  // them is cheap at this size, but we use the existing sources loader
  // for the extract input to stay consistent with the shared helper.
  await ctx.logger.log(packStepEvent({ pack: "repo", step: "extract", step_index: 3, total_steps: TOTAL_STEPS }));
  const perFileMax = input.per_file_max_chars ?? 20_000;
  const sources = await loadSources(input.source_paths, perFileMax);
  const extractInputText = formatSourcesBlock(sources);

  let facts: OnboardingFacts | null = null;
  let extractWarning: string | null = null;
  const extractStart = Date.now();
  try {
    const extractEnv = await handleExtract(
      {
        text: extractInputText,
        schema: ONBOARDING_EXTRACT_SCHEMA as unknown as Record<string, unknown>,
        hint: "Extract ONLY concrete onboarding facts from the repo. Leave arrays empty and fields null if not present in the text. Do not invent values.",
      },
      ctx,
    );
    tokensIn += extractEnv.tokens_in;
    tokensOut += extractEnv.tokens_out;
    // Single-mode narrow: result is ExtractResult, not BatchResult.
    const extractResult = extractEnv.result as ExtractResult;
    if (extractResult.ok) {
      // Sanitize untrusted model output before render — string-instead-of-
      // array, null entries, mixed types would otherwise crash renderFactsBlock.
      const coerced = coerceOnboardingFacts(extractResult.data);
      const scrubbed = await scrubOnboardingPaths(coerced, input.source_paths);
      facts = scrubbed.facts;
      if (scrubbed.coverageNote) {
        extractWarning = scrubbed.coverageNote;
        brief.coverage_notes = [...brief.coverage_notes, scrubbed.coverageNote];
      }
    } else {
      extractWarning = "Extract output was unparseable; onboarding facts omitted.";
    }
    steps.push({
      tool: "ollama_extract",
      ok: extractResult.ok,
      elapsed_ms: Date.now() - extractStart,
      ...(extractWarning ? { warnings: [extractWarning] } : {}),
    });
  } catch (err) {
    extractWarning = err instanceof Error ? err.message : String(err);
    steps.push({
      tool: "ollama_extract",
      ok: false,
      elapsed_ms: Date.now() - extractStart,
      warnings: [extractWarning],
    });
  }

  // Step 4 — artifact write.
  await ctx.logger.log(packStepEvent({ pack: "repo", step: "artifact_write", step_index: 4, total_steps: TOTAL_STEPS }));
  const artifactDir = resolvePackArtifactDir({
    artifact_dir: input.artifact_dir,
    allowed_roots: input.allowed_roots,
    defaultDir: defaultArtifactDir(),
  });
  assertPackArtifactWriteAllowed([artifactDir], input.confirm_write);
  const when = new Date();
  const thesisHead = brief.repo_thesis.split(/[.\n]/)[0]?.trim();
  const baseSlug = buildSlug({ title: input.title, thesisHead, when });
  // H6: never silently overwrite an existing artifact pair — a retry after a
  // timed-out response (or two same-minute runs with the same title) yields
  // the same minute-resolution slug. Uniquify (-2, -3, …) BEFORE building the
  // artifact object that embeds slug + paths.
  const { slug, mdPath, jsonPath } = await resolveUniqueArtifactPaths(artifactDir, baseSlug);
  assertPackArtifactWriteAllowed([mdPath, jsonPath], input.confirm_write);

  const writeStart = Date.now();
  const title = input.title ?? (thesisHead && thesisHead.length > 0 ? thesisHead : "repo");
  const generatedAt = when.toISOString();
  const markdown = renderMarkdown({
    title,
    generatedAt,
    hardwareProfile: ctx.hardwareProfile,
    brief,
    facts,
    steps, // snapshot up through extract — markdown omits artifact_write (can't narrate its own write)
  });
  const jsonArtifact: RepoPackArtifact = {
    schema_version: 1,
    pack: "repo_pack",
    generated_at: generatedAt,
    hardware_profile: ctx.hardwareProfile,
    title,
    slug,
    input: {
      source_paths: input.source_paths,
      corpus: input.corpus ?? null,
      corpus_query: input.corpus_query ?? null,
    },
    brief,
    extracted_facts: facts,
    steps, // same snapshot
    artifact: { markdown_path: mdPath, json_path: jsonPath },
  };

  let artifactWritten = true;
  let writeErrorReason: string | null = null;
  try {
    // H6: atomic writes, .json LAST as the commit marker (see artifactWrite.ts).
    await writeArtifactPair(
      artifactDir,
      mdPath,
      markdown,
      jsonPath,
      JSON.stringify(jsonArtifact, null, 2),
    );
  } catch (err) {
    artifactWritten = false;
    writeErrorReason = err instanceof Error ? err.message : String(err);
  }
  steps.push({
    tool: "artifact_write",
    ok: artifactWritten,
    elapsed_ms: Date.now() - writeStart,
    artifact_written: artifactWritten,
    ...(writeErrorReason ? { warnings: [writeErrorReason] } : {}),
  });

  // Paths land in `result.artifact` ONLY after the write succeeded —
  // when the write fails the envelope signals "no artifact on disk"
  // via null paths + an embedded error shape naming the attempted path
  // and filesystem reason. Prevents the write-failure → later-read-
  // failure chain Stage B surfaced.
  const artifactBlock: RepoPackResult["artifact"] = artifactWritten
    ? { markdown_path: mdPath, json_path: jsonPath }
    : {
        markdown_path: null,
        json_path: null,
        error: {
          attempted_markdown_path: mdPath,
          attempted_json_path: jsonPath,
          reason: writeErrorReason ?? "unknown write failure",
        },
      };
  const result: RepoPackResult = {
    artifact: artifactBlock,
    summary: {
      key_surfaces_count: brief.key_surfaces.length,
      risk_areas_count: brief.risk_areas.length,
      read_next_count: brief.read_next.length,
      extracted_facts_present: facts !== null,
      weak: brief.weak,
      corpus_used: brief.corpus_used,
    },
    steps,
  };

  const residency = await ctx.client.residency(briefEnv.model);
  const envelopeWarnings: string[] = artifactWritten
    ? []
    : [
        `ollama_repo_pack: artifact write failed for "${mdPath}" (${writeErrorReason}). Pack ran successfully — see result.summary for the data that would have been persisted, and result.artifact.error for the filesystem reason. Common fixes: check that artifact_dir is writable, or pass an explicit artifact_dir to override the default ~/.ollama-intern/artifacts/repo.`,
      ];
  const envelope = buildEnvelope<RepoPackResult>({
    result,
    tier: "deep",
    model: briefEnv.model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut,
    startedAt: packStartedAt,
    residency,
    ...(envelopeWarnings.length > 0 ? { warnings: envelopeWarnings } : {}),
  });
  // FT-010: echo correlation IDs on the pack envelope (additive cast).
  const runCtx = getRunCorrelation();
  const callCtx = getCallContext();
  if (runCtx?.run_id) {
    (envelope as unknown as Record<string, unknown>).run_id = runCtx.run_id;
  }
  if (callCtx?.call_id) {
    (envelope as unknown as Record<string, unknown>).call_id = callCtx.call_id;
  }
  await ctx.logger.log(callEvent("ollama_repo_pack", envelope));
  return envelope;
}

export interface RepoPackArtifact {
  schema_version: 1;
  pack: "repo_pack";
  generated_at: string;
  hardware_profile: string;
  title: string;
  slug: string;
  input: {
    source_paths: string[];
    corpus: string | null;
    corpus_query: string | null;
  };
  brief: RepoBriefResult;
  extracted_facts: OnboardingFacts | null;
  steps: StepEntry[];
  artifact: { markdown_path: string; json_path: string };
}

// Internal exports used only by tests.
export const __internal = { buildSlug, renderMarkdown, ONBOARDING_EXTRACT_SCHEMA };
