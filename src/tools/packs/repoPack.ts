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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type { Envelope } from "../../envelope.js";
import { buildEnvelope } from "../../envelope.js";
import { callEvent } from "../../observability.js";
import type { RunContext } from "../../runContext.js";
import { assembleEvidence } from "../briefs/common.js";
import { loadSources, formatSourcesBlock } from "../../sources.js";
import {
  synthesizeRepoBrief,
  type RepoBriefInput,
  type RepoBriefResult,
} from "../repoBrief.js";
import { handleExtract, type ExtractResult } from "../extract.js";

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
  corpus_query: z.string().min(1).optional().describe("Corpus query (defaults to 'repo architecture and surfaces')."),
  title: z.string().min(1).max(120).optional().describe("Short human title — used in the artifact header and filename slug. Defaults to the repo thesis head."),
  artifact_dir: z.string().min(1).optional().describe("Directory to write the repo.md + repo.json artifact pair. Defaults to ~/.ollama-intern/artifacts/repo/."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional(),
  max_key_surfaces: z.number().int().min(1).max(20).optional(),
  max_risk_areas: z.number().int().min(1).max(10).optional(),
  max_read_next: z.number().int().min(1).max(15).optional(),
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
    markdown_path: string;
    json_path: string;
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

export async function handleRepoPack(
  input: RepoPackInput,
  ctx: RunContext,
): Promise<Envelope<RepoPackResult>> {
  const packStartedAt = Date.now();
  const steps: StepEntry[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  // Step 1 — assemble evidence (source_paths + corpus if given).
  const corpusQuery = input.corpus_query ?? "repo architecture and surfaces";
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
      facts = extractResult.data as OnboardingFacts;
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
  const artifactDir = input.artifact_dir ?? defaultArtifactDir();
  const when = new Date();
  const thesisHead = brief.repo_thesis.split(/[.\n]/)[0]?.trim();
  const slug = buildSlug({ title: input.title, thesisHead, when });
  const mdPath = join(artifactDir, `${slug}.md`);
  const jsonPath = join(artifactDir, `${slug}.json`);

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

  const result: RepoPackResult = {
    artifact: { markdown_path: mdPath, json_path: jsonPath },
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
  const envelope = buildEnvelope<RepoPackResult>({
    result,
    tier: "deep",
    model: briefEnv.model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut,
    startedAt: packStartedAt,
    residency,
  });
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
