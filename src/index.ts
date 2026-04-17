#!/usr/bin/env node

/**
 * Ollama Intern MCP — entrypoint.
 *
 * Registers the 8-tool labor surface. Tool descriptions encode *when* to reach
 * for them — Claude picks the tier by picking the tool, and the tool implies
 * the model. ollama_chat is visibly last-resort.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { VERSION } from "./version.js";
import { loadProfile } from "./profiles.js";
import { HttpOllamaClient } from "./ollama.js";
import { NdjsonLogger } from "./observability.js";
import { toErrorShape } from "./errors.js";
import { runPrewarm } from "./prewarm.js";
import type { RunContext } from "./runContext.js";

import { classifySchema, handleClassify } from "./tools/classify.js";
import { triageLogsSchema, handleTriageLogs } from "./tools/triageLogs.js";
import { summarizeFastSchema, handleSummarizeFast } from "./tools/summarizeFast.js";
import { summarizeDeepSchema, handleSummarizeDeep } from "./tools/summarizeDeep.js";
import { draftSchema, handleDraft } from "./tools/draft.js";
import { extractSchema, handleExtract } from "./tools/extract.js";
import { researchSchema, handleResearch } from "./tools/research.js";
import { embedSchema, handleEmbed } from "./tools/embed.js";
import { embedSearchSchema, handleEmbedSearch } from "./tools/embedSearch.js";
import { corpusIndexSchema, handleCorpusIndex } from "./tools/corpusIndex.js";
import { corpusSearchSchema, handleCorpusSearch } from "./tools/corpusSearch.js";
import { corpusAnswerSchema, handleCorpusAnswer } from "./tools/corpusAnswer.js";
import { corpusRefreshSchema, handleCorpusRefresh } from "./tools/corpusRefresh.js";
import { corpusListSchema, handleCorpusList } from "./tools/corpusList.js";
import { incidentBriefSchema, handleIncidentBrief } from "./tools/incidentBrief.js";
import { repoBriefSchema, handleRepoBrief } from "./tools/repoBrief.js";
import { changeBriefSchema, handleChangeBrief } from "./tools/changeBrief.js";
import { incidentPackSchema, handleIncidentPack } from "./tools/packs/incidentPack.js";
import { repoPackSchema, handleRepoPack } from "./tools/packs/repoPack.js";
import { changePackSchema, handleChangePack } from "./tools/packs/changePack.js";
import { artifactListSchema, handleArtifactList } from "./tools/artifactList.js";
import { artifactReadSchema, handleArtifactRead } from "./tools/artifactRead.js";
import { artifactDiffSchema, handleArtifactDiff } from "./tools/artifactDiff.js";
import { chatSchema, handleChat } from "./tools/chat.js";

export function createServer(ctx: RunContext): McpServer {
  const server = new McpServer({ name: "ollama-intern-mcp", version: VERSION });

  const wrap = <T>(p: Promise<T>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> =>
    p.then(
      (value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }),
      (err) => ({
        content: [{ type: "text" as const, text: JSON.stringify(toErrorShape(err), null, 2) }],
        isError: true as const,
      }),
    );

  // FLAGSHIP — ollama_research
  server.tool(
    "ollama_research",
    "FLAGSHIP. Answer a question grounded in specific files. Takes FILE PATHS (not raw text) — reads and chunks locally, returns a digest with validated citations. Use this to understand a repo/doc without burning Claude context on the full content. Citations outside source_paths are stripped server-side.",
    researchSchema.shape,
    (args) => wrap(handleResearch(args, ctx)),
  );

  // FLAGSHIP — ollama_corpus_search (persistent concept search over named corpora)
  server.tool(
    "ollama_corpus_search",
    "FLAGSHIP. Concept search over a persistent named corpus (e.g. 'memory', 'canon', 'handbook'). Pass `corpus` + `query`; returns ranked `[{id, path, score, chunk_index, preview?}]` drawn from the indexed corpus. Use this as your default for semantic recall — the corpus is persistent across sessions so you don't re-embed every call. Build or refresh a corpus with ollama_corpus_index first; see what's available with ollama_corpus_list.",
    corpusSearchSchema.shape,
    (args) => wrap(handleCorpusSearch(args, ctx)),
  );

  // FLAGSHIP — ollama_corpus_answer (grounded synthesis over a named corpus)
  server.tool(
    "ollama_corpus_answer",
    "FLAGSHIP. Answer a question from a NAMED CORPUS with chunk-grounded citations. Retrieves via corpus_search, synthesizes with the Deep tier from the retrieved chunks ONLY, and returns `{answer, citations:[{path, chunk_index, heading_path, title}], covered_sources, omitted_sources, coverage_notes, retrieval:{retrieved, top_score, weak}}`. Distinct from ollama_research: research takes source paths you explicitly hand in; corpus_answer pulls from an already-indexed corpus. Weak retrieval degrades honestly — 0 hits short-circuits without invoking the model; thin retrieval flags `weak: true`.",
    corpusAnswerSchema.shape,
    (args) => wrap(handleCorpusAnswer(args, ctx)),
  );

  // FLAGSHIP — ollama_incident_brief (structured operator brief)
  server.tool(
    "ollama_incident_brief",
    "FLAGSHIP compound job. Produces a STRUCTURED OPERATOR BRIEF from log_text and/or source_paths, optionally blended with a named corpus for background context. Returns `{root_cause_hypotheses, affected_surfaces, timeline_clues, next_checks, evidence, weak, coverage_notes, corpus_used}`. Every hypothesis/surface/clue carries evidence_refs into the evidence array — refs to unknown ids are stripped server-side. Distinct from ollama_triage_logs (symptoms in one blob) and ollama_research (answer a specific question). Thin evidence degrades to weak=true with coverage_notes — never a smooth fake narrative. next_checks are INVESTIGATIVE, not remediations.",
    incidentBriefSchema.shape,
    (args) => wrap(handleIncidentBrief(args, ctx)),
  );

  // FLAGSHIP — ollama_repo_brief (operator map of a repo)
  server.tool(
    "ollama_repo_brief",
    "FLAGSHIP compound job. Produces an OPERATOR MAP of a repo: `{repo_thesis, key_surfaces, architecture_shape, risk_areas, read_next, evidence, weak, coverage_notes, corpus_used}`. Takes source_paths (typically README + key src entries + manifests + docs) and optionally a corpus for cross-cutting context. Not a research clone — research answers a specific question; repo_brief synthesizes orientation. Every key_surface and risk_area cites evidence. read_next is INVESTIGATIVE (files or sections to look at), never prescriptive fixes or refactors. Thin evidence → weak=true with coverage notes.",
    repoBriefSchema.shape,
    (args) => wrap(handleRepoBrief(args, ctx)),
  );

  // FLAGSHIP — ollama_change_brief (structured impact brief for a change)
  server.tool(
    "ollama_change_brief",
    "FLAGSHIP compound job. Produces a CHANGE IMPACT BRIEF: `{change_summary, affected_surfaces, why_it_matters, likely_breakpoints, validation_checks, release_note_draft, evidence, weak, coverage_notes, corpus_used}`. Accepts diff_text (split per file on `diff --git` markers) and/or source_paths (changed files), with an optional corpus for architecture context. Not a git chat bot — structured and reviewable. likely_breakpoints are INVESTIGATIVE reasoning about what could break; validation_checks are what to verify after the change. Never remedial (no 'apply this fix'). release_note_draft is a draft the operator reviews.",
    changeBriefSchema.shape,
    (args) => wrap(handleChangeBrief(args, ctx)),
  );

  // PACK — ollama_incident_pack (deterministic orchestration, durable artifact)
  server.tool(
    "ollama_incident_pack",
    "PACK. Runs the full incident job end-to-end: triage_logs → corpus_search → incident_brief → deterministic markdown+JSON artifact on disk. Single call, single completed job, single pair of files the operator can keep and diff. Response is compact ({artifact:{markdown_path,json_path}, summary, steps}) — the full brief lives in the artifact, not the MCP payload. Fixed pipeline, fixed markdown layout, no prose drift. Use this instead of calling triage_logs + incident_brief manually when you want one deliverable.",
    incidentPackSchema.shape,
    (args) => wrap(handleIncidentPack(args, ctx)),
  );

  // PACK — ollama_repo_pack (onboarding job, corpus-first, durable artifact)
  server.tool(
    "ollama_repo_pack",
    "PACK. Runs the full repo ONBOARDING job: corpus_search (if corpus given) → repo_brief → targeted ollama_extract (narrow onboarding schema: packages, entrypoints, scripts, config_files, exposed_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Corpus-first posture: when a corpus is given, it's the main working surface alongside source_paths. Not repo Q&A — this is `get me onboarded fast with a stable operator artifact`. Response is compact; full brief + extracted facts live in the artifact.",
    repoPackSchema.shape,
    (args) => wrap(handleRepoPack(args, ctx)),
  );

  // PACK — ollama_change_pack (change-centered review job, durable artifact)
  server.tool(
    "ollama_change_pack",
    "PACK. Runs the full change REVIEW job: assemble evidence (diff + paths + corpus if given) → triage_logs ONLY when log_text is provided → change_brief → targeted ollama_extract (narrow review schema: scripts_touched, config_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Change-first, not repo-first — this is about the DELTA, not a tour. Release note draft is a blockquote-wrapped DRAFT (not marketing copy). No VCS integration — caller hands in diff_text / source_paths / optional log_text. Response is compact; full brief + extracted facts live in the artifact.",
    changePackSchema.shape,
    (args) => wrap(handleChangePack(args, ctx)),
  );

  // ARTIFACT — ollama_artifact_list (metadata-only index over pack artifacts)
  server.tool(
    "ollama_artifact_list",
    "ARTIFACT. Metadata-only index of pack artifacts on disk. Returns one compact record per artifact: `{pack, slug, title, created_at, weak, corpus_used, evidence_count, section_counts, md_path, json_path}`. Filter by pack / date_after / date_before / weak_only / strong_only; sort is newest first. Scans ~/.ollama-intern/artifacts/{incident,repo,change} by default; pass extra_artifact_dirs for additional read-only search surfaces. Full payloads belong to ollama_artifact_read — listing stays cheap.",
    artifactListSchema.shape,
    (args) => wrap(handleArtifactList(args, ctx)),
  );

  // ARTIFACT — ollama_artifact_read (typed read by identity or path)
  server.tool(
    "ollama_artifact_read",
    "ARTIFACT. Read a single pack artifact, typed by pack. Primary: `{pack, slug}` — identity-based, collisions fail loud. Secondary: `{json_path}` — absolute path, must live under a recognized artifact dir (canonical roots + extra_artifact_dirs), must end in .json, path-traversal rejected. Returns `{metadata, artifact}` where artifact is a discriminated union on `pack` (incident_pack / repo_pack / change_pack — payloads stay distinct, never flattened).",
    artifactReadSchema.shape,
    (args) => wrap(handleArtifactRead(args, ctx)),
  );

  // ARTIFACT — ollama_artifact_diff (structured same-pack comparison)
  server.tool(
    "ollama_artifact_diff",
    "ARTIFACT. Structured diff of two same-pack artifacts. Input: `{a: {pack, slug}, b: {pack, slug}}` — must share pack; cross-pack diffs refused loudly. Returns `{pack, a, b, weak, diff}` with weak flip surfaced at top level (strong→weak or weak→strong). Lists diff as {added, removed, unchanged} matched on primary key per item kind; narrative fields as {before, after}; release_note_draft also carries a compact LCS line_diff. Evidence is SUMMARIZED (counts + referenced_paths + path_delta), never exploded chunk-by-chunk. Deterministic ordering on every list.",
    artifactDiffSchema.shape,
    (args) => wrap(handleArtifactDiff(args, ctx)),
  );

  // FLAGSHIP — ollama_embed_search (ephemeral concept search on ad-hoc candidates)
  server.tool(
    "ollama_embed_search",
    "FLAGSHIP. Rank AD-HOC candidates by concept similarity to a query. Pass `query` + `candidates: [{id, text}]`; server embeds everything, computes cosine, returns ranked `[{id, score, preview?}]`. Use this when you have in-memory candidates to compare; for persistent recall over memory/canon/doctrine use ollama_corpus_search instead. Does NOT return raw vectors to you.",
    embedSearchSchema.shape,
    (args) => wrap(handleEmbedSearch(args, ctx)),
  );

  // Corpus builder
  server.tool(
    "ollama_corpus_index",
    "Build a persistent named corpus. Pass `name` + `paths: string[]`; the server chunks, embeds, stores the corpus at ~/.ollama-intern/corpora/<name>.json AND writes a manifest at <name>.manifest.json that captures the declared paths + chunk params + embed model. Idempotent — unchanged files are reused by sha256; changed files are re-embedded; paths not in the input are dropped. For day-to-day upkeep once a manifest exists, prefer `ollama_corpus_refresh` — it reconciles corpus vs manifest and reports drift.",
    corpusIndexSchema.shape,
    (args) => wrap(handleCorpusIndex(args, ctx)),
  );

  // Corpus refresh — living-corpus workflow: reconcile against manifest
  server.tool(
    "ollama_corpus_refresh",
    "Reconcile a named corpus against its manifest (intent vs reality). Single arg: `name`. The manifest's declared paths, chunk params, and embed model are the source of truth — refresh doesn't accept them. Returns a drift report: added / changed / unchanged / deleted / missing (per-path lists) plus reused / reembedded / dropped (chunk-level counts) plus no_op. Idempotent: a no-change refresh is fast, boring, and makes zero embed calls.",
    corpusRefreshSchema.shape,
    (args) => wrap(handleCorpusRefresh(args, ctx)),
  );

  // Corpus list
  server.tool(
    "ollama_corpus_list",
    "List named corpora on disk with stats. No Ollama call. Use to discover what's been indexed, check freshness (indexed_at), or verify a corpus exists before searching.",
    corpusListSchema.shape,
    (args) => wrap(handleCorpusList(args, ctx)),
  );

  // LOW-LEVEL — ollama_embed (raw vectors for external index builds)
  server.tool(
    "ollama_embed",
    "LOW-LEVEL primitive. Returns raw 768-dim vectors for one text or a batch. Use `ollama_embed_search` instead for concept-search — this tool is for building external indexes (sqlite-vss, pgvector) where you need the raw geometry. Output can be large.",
    embedSchema.shape,
    (args) => wrap(handleEmbed(args, ctx)),
  );

  // Core — classify (batch-capable)
  server.tool(
    "ollama_classify",
    "Single-label classification with confidence. Single: pass `text`. BATCH: pass `items:[{id,text}]` — returns ONE envelope with `result.items[]` of `{id, ok, result|error}` plus `batch_count/ok_count/error_count`. Use the batch shape to chew through bulk labeling (commit types, PR titles, log severities) in one handoff instead of N round-trips. Set allow_none=true when weak guesses are worse than 'unsure' — label returns null below threshold (default 0.7).",
    classifySchema.shape,
    (args) => wrap(handleClassify(args, ctx)),
  );

  // Core — triage_logs (batch-capable)
  server.tool(
    "ollama_triage_logs",
    "Stable-shape log digest: {errors, warnings, suspected_root_cause}. Single: pass `log_text`. BATCH: pass `items:[{id,log_text}]` for triaging many log blobs at once (multiple CI runs, matrix legs, per-service logs) — returns one envelope with per-item entries. Use before grep-storms on long CI/test output.",
    triageLogsSchema.shape,
    (args) => wrap(handleTriageLogs(args, ctx)),
  );

  // Core — summarize_fast
  server.tool(
    "ollama_summarize_fast",
    "Gist of short input (best under ~4k tokens). Use as a decision gate: 'is this file worth reading in full?' Summary carries source_preview so you can spot-check fabrication.",
    summarizeFastSchema.shape,
    (args) => wrap(handleSummarizeFast(args, ctx)),
  );

  // Core — summarize_deep
  server.tool(
    "ollama_summarize_deep",
    "Digest of long input with optional focus. Pass EITHER `text` (when you already have the content) OR `source_paths[]` (server reads + chunks locally — use this to save Claude context). Exactly one of the two. Carries source_preview for fabrication spot-checks.",
    summarizeDeepSchema.shape,
    (args) => wrap(handleSummarizeDeep(args, ctx)),
  );

  // Core — draft
  server.tool(
    "ollama_draft",
    "DRAFT code or prose stubs (never autonomous — Claude reviews). Pass language for a server-side compile check: envelope returns {compiles, checker, stderr_tail}. target_path pointing into memory/, .claude/, docs/canon/, games/ requires confirm_write: true.",
    draftSchema.shape,
    (args) => wrap(handleDraft(args, ctx)),
  );

  // Core — extract (batch-capable)
  server.tool(
    "ollama_extract",
    "Schema-constrained JSON extraction using Ollama's JSON mode. Single: pass `text`, returns `{ok: true, data}` or `{ok: false, error: 'unparseable'}` — never partial. BATCH: pass `items:[{id,text}]` with a shared schema — returns one envelope with per-item `{id, ok, result|error}`. Use the batch shape for any 10+-similar-inputs workload (frontmatter, package.json, release metadata) so you hand over the whole job, not N calls.",
    extractSchema.shape,
    (args) => wrap(handleExtract(args, ctx)),
  );

  // Last resort — chat
  server.tool(
    "ollama_chat",
    "LAST RESORT catch-all. Prefer a specialty tool above when one fits. If you reach for this often, a specialty tool is missing and should be added.",
    chatSchema.shape,
    (args) => wrap(handleChat(args, ctx)),
  );

  return server;
}

async function main(): Promise<void> {
  const profile = loadProfile();
  const ctx: RunContext = {
    client: new HttpOllamaClient(),
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NdjsonLogger(),
  };

  // Profile-policy prewarm: pulls Instant tier into VRAM on dev profiles
  // before connecting transport, so the first real Claude call doesn't eat
  // cold-load latency. Failures are logged but never throw — server startup
  // must not depend on Ollama being reachable.
  if (profile.prewarm.length > 0) {
    await runPrewarm(ctx, profile.prewarm);
  }

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Run main() only when invoked as a script, not when imported by tests.
 *
 * Robust-on-Windows check: normalize both sides through realpathSync +
 * fileURLToPath so forward/backslash and symlink differences don't cause
 * the script to no-op silently (which is what Claude Code would see as
 * "connected then immediately disconnected").
 */
function isInvokedAsScript(): boolean {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isInvokedAsScript()) {
  main().catch((err) => {
    console.error(JSON.stringify(toErrorShape(err), null, 2));
    process.exit(1);
  });
}
