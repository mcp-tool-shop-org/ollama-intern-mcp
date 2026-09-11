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
import { realpathSync, existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";

import { VERSION } from "./version.js";
import { loadProfile, loadCloudConfig } from "./profiles.js";
import type { CloudConfig } from "./profiles.js";
import {
  HttpOllamaClient,
  setClientLogger,
  setClientProfileName,
  normalizeOllamaHost,
  type OllamaClient,
} from "./ollama.js";
import { RoutingOllamaClient } from "./routing.js";
import { runCloudCheck, formatCloudCheck, shouldGate } from "./cloudCheck.js";
import type { CloudCheckResult } from "./cloudCheck.js";
import { LOG_EVENT_KINDS, NdjsonLogger, timestamp } from "./observability.js";
import { formatBytes } from "./format.js";
import { InternError, toErrorShape } from "./errors.js";
import { runPrewarm, notePrewarmInProgressRequest } from "./prewarm.js";
import { detectEnvOverrides } from "./profiles.js";
// handleDoctor is imported below from "./tools/doctor.js" alongside doctorSchema —
// the CLI doctor command (runCliDoctor) reuses it so the CLI report stays in
// lockstep with the MCP-tool report.
import { NullLogger } from "./observability.js";
import type { RunContext, CorrelationContext } from "./runContext.js";
import { withRunContext, mintRunId } from "./runContext.js";

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
import { corpusHealthSchema, handleCorpusHealth } from "./tools/corpusHealth.js";
import { corpusAmendSchema, handleCorpusAmend } from "./tools/corpusAmend.js";
import { corpusAmendHistorySchema, handleCorpusAmendHistory } from "./tools/corpusAmendHistory.js";
import { corpusRerankSchema, handleCorpusRerank } from "./tools/corpusRerank.js";
import { incidentBriefSchema, handleIncidentBrief } from "./tools/incidentBrief.js";
import { repoBriefSchema, handleRepoBrief } from "./tools/repoBrief.js";
import { changeBriefSchema, handleChangeBrief } from "./tools/changeBrief.js";
import { incidentPackSchema, handleIncidentPack } from "./tools/packs/incidentPack.js";
import { repoPackSchema, handleRepoPack } from "./tools/packs/repoPack.js";
import { changePackSchema, handleChangePack } from "./tools/packs/changePack.js";
import { artifactListSchema, handleArtifactList } from "./tools/artifactList.js";
import { artifactReadSchema, handleArtifactRead } from "./tools/artifactRead.js";
import { artifactDiffSchema, handleArtifactDiff } from "./tools/artifactDiff.js";
import { artifactExportToPathSchema, handleArtifactExportToPath } from "./tools/artifactExportToPath.js";
import {
  artifactIncidentNoteSnippetSchema,
  handleArtifactIncidentNoteSnippet,
  artifactOnboardingSectionSnippetSchema,
  handleArtifactOnboardingSectionSnippet,
  artifactReleaseNoteSnippetSchema,
  handleArtifactReleaseNoteSnippet,
} from "./tools/artifactSnippets.js";
import { chatSchema, handleChat } from "./tools/chat.js";

// ── Feature-pass tools (agent: Tools) — no-LLM ops + instant-tier helpers ──
import { doctorSchema, handleDoctor } from "./tools/doctor.js";
import { artifactPruneSchema, handleArtifactPrune } from "./tools/artifactPrune.js";
import { logTailSchema, handleLogTail } from "./tools/logTail.js";
import { LOG_STATS_MAX_BYTES } from "./tools/logRead.js";
import { logStatsSchema, handleLogStats } from "./tools/logStats.js";
import { codeMapSchema, handleCodeMap } from "./tools/codeMap.js";
// ── Feature-pass tools (agent: Tools-new) — refactor/proof/citation/drill ──
import { multiFileRefactorProposeSchema, handleMultiFileRefactorPropose } from "./tools/multiFileRefactorPropose.js";
import { batchProofCheckSchema, handleBatchProofCheck } from "./tools/batchProofCheck.js";
import { refactorPlanSchema, handleRefactorPlan } from "./tools/refactorPlan.js";
import { codeCitationSchema, handleCodeCitation } from "./tools/codeCitation.js";
import { codeReviewSchema, handleCodeReview } from "./tools/codeReview.js";
import { hypothesisDrillSchema, handleHypothesisDrill } from "./tools/hypothesisDrill.js";
import { verifyClaimsSchema, handleVerifyClaims } from "./tools/verifyClaims.js";

/**
 * Rendered `filter_kind` roster for the ollama_log_tail description,
 * derived from LOG_EVENT_KINDS (src/observability.ts) rather than typed
 * out by hand. The hand-maintained list read as exhaustive — a
 * pipe-separated set with no "e.g." — while omitting `backend_fallback`
 * and `cloud_egress`, the latter being the event that records data
 * leaving the machine. `filter_kind` matches by exact equality, so an
 * undocumented kind is undiscoverable and a guessed one returns an empty
 * result rather than an error.
 */
/**
 * The filter_kind roster as it must appear in ollama_log_tail's description.
 * The description is a plain string literal on purpose — scripts/gen-tool-docs.mjs
 * parses it statically and cannot evaluate a template literal — so the
 * no-drift guarantee lives in tests/logTailRoster.test.ts instead of in codegen.
 */
export const LOG_FILTER_KIND_ROSTER = LOG_EVENT_KINDS.map((k) => `'${k}'`).join(" | ");

export function createServer(ctx: RunContext): McpServer {
  const server = new McpServer({ name: "ollama-intern-mcp", version: VERSION });

  /**
   * Minimal duck-typed view of the MCP SDK's `RequestHandlerExtra` argument
   * (Phase 7 / FT-001). We only read `_meta.progressToken` (per the MCP
   * spec, the only client-supplied correlation handle at tool entry) and
   * don't import the SDK's `RequestHandlerExtra` type to avoid coupling
   * the wrap helper to the SDK's generic Request/Notification parameters.
   * If the SDK reshapes `_meta` in a future version the worst outcome here
   * is `progress_token` going absent — never a server crash.
   */
  type ToolExtraLike = { _meta?: { progressToken?: string | number } };

  // The `tool` label is attached in createServer below — we use "mcp" as a
  // coarse bucket on the in-progress event because emitting one event per
  // tool name would bloat the log during prewarm. An operator reading the
  // log can see "calls arrived during prewarm" without per-tool granularity.
  //
  // Phase 7 / FT-001 — `wrap` now opens a `CorrelationContext` for the
  // duration of the handler. The contract is:
  //   - One `run_id` per MCP tool call (mint inside wrap, not at module
  //     load — that would give every tool the same id).
  //   - `progress_token` is read from MCP's `_meta.progressToken` if the
  //     client supplied one; never invented by the server.
  //   - `started_at` is captured once so the elapsed-time computation in
  //     the envelope and any downstream timing math agree.
  // The `extra` parameter is optional so wrap remains usable from tests
  // that don't construct a synthetic RequestHandlerExtra.
  const wrap = <T>(
    build: () => Promise<T>,
    tool = "mcp",
    extra?: ToolExtraLike,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> => {
    notePrewarmInProgressRequest(ctx.logger, tool);
    const correlation: CorrelationContext = {
      run_id: mintRunId(),
      ...(extra?._meta?.progressToken !== undefined
        ? { progress_token: extra._meta.progressToken }
        : {}),
      started_at: new Date().toISOString(),
    };
    // The handler invocation itself MUST be inside withRunContext so that
    // every async descendant (semaphore wait, Ollama HTTP, retry sleep,
    // envelope build, NDJSON write) sees the same correlation context
    // via getRunContext(). withRunContext forwards the function's return
    // value/promise through unchanged.
    return Promise.resolve(
      withRunContext(correlation, () =>
        build().then(
          (value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }),
          (err) => ({
            content: [{ type: "text" as const, text: JSON.stringify(toErrorShape(err), null, 2) }],
            isError: true as const,
          }),
        ),
      ),
    );
  };

  // FLAGSHIP — ollama_research
  server.tool(
    "ollama_research",
    "FLAGSHIP. Answer a question grounded in specific files. Takes FILE PATHS (not raw text) — reads and chunks locally, returns a digest with validated citations. Use this to understand a repo/doc without burning Claude context on the full content. Citations outside source_paths are stripped server-side; cited line_ranges that point past EOF have the range dropped (path is kept) with a warning. Returns honest grounding signals: `weak: true` when an answer has zero validated citations (likely ungrounded); `abstained: true` when the model explicitly refused (citations cleared); `sources_address_question` is tri-state (null when unknown).",
    researchSchema.shape,
    { title: "Research over files", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleResearch(args, ctx), "ollama_research", extra),
  );

  // FLAGSHIP — ollama_corpus_search (persistent concept search over named corpora)
  server.tool(
    "ollama_corpus_search",
    "FLAGSHIP. Concept search over a persistent named corpus (e.g. 'memory', 'canon', 'handbook'). Pass `corpus` + `query`; returns ranked `[{id, path, score, chunk_index, preview?}]` drawn from the indexed corpus. Use this as your default for semantic recall — the corpus is persistent across sessions so you don't re-embed every call. Build or refresh a corpus with ollama_corpus_index first; see what's available with ollama_corpus_list.",
    corpusSearchSchema.shape,
    { title: "Corpus search", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusSearch(args, ctx), "ollama_corpus_search", extra),
  );

  // FLAGSHIP — ollama_corpus_answer (grounded synthesis over a named corpus)
  server.tool(
    "ollama_corpus_answer",
    "FLAGSHIP. Answer a question from a NAMED CORPUS with chunk-grounded citations. Retrieves via corpus_search, synthesizes with the Deep tier from the retrieved chunks ONLY, and returns `{answer, citations:[{path, chunk_index, heading_path, title, score}], covered_sources, omitted_sources, coverage_notes, retrieval:{retrieved, top_score, weak}, abstained}`. Per-citation `score` carries the retrieval relevance through. Distinct from ollama_research: research takes source paths you explicitly hand in; corpus_answer pulls from an already-indexed corpus. Weak retrieval degrades honestly — 0 hits short-circuits without invoking the model. New `min_top_score` floor: when supplied, top hits below the threshold also short-circuit with `abstained: true` instead of driving ungrounded synthesis (e.g. 5 hits @ 0.21 cosine on a 0.5 floor).",
    corpusAnswerSchema.shape,
    { title: "Corpus answer (grounded)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusAnswer(args, ctx), "ollama_corpus_answer", extra),
  );

  // FLAGSHIP — ollama_incident_brief (structured operator brief)
  server.tool(
    "ollama_incident_brief",
    "FLAGSHIP compound job. Produces a STRUCTURED OPERATOR BRIEF from log_text and/or source_paths, optionally blended with a named corpus for background context. Returns `{root_cause_hypotheses, affected_surfaces, timeline_clues, next_checks, evidence, weak, coverage_notes, corpus_used}`. Every hypothesis/surface/clue carries evidence_refs into the evidence array — refs to unknown ids are stripped server-side. Corpus-sourced evidence items carry retrieval `score` (and optionally `why_matched`). Optional `corpus_min_evidence_score` drops corpus chunks below the relevance floor before the model sees them, with a counted note in coverage_notes. Distinct from ollama_triage_logs (symptoms in one blob) and ollama_research (answer a specific question). Thin evidence degrades to weak=true with coverage_notes — never a smooth fake narrative. next_checks are INVESTIGATIVE, not remediations. If you pre-extracted claims via ollama_extract with a frame argument, drop off-topic items before assembling source_paths for this brief — there's no in-brief topicality gate for path/log inputs.",
    incidentBriefSchema.shape,
    { title: "Incident brief", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleIncidentBrief(args, ctx), "ollama_incident_brief", extra),
  );

  // FLAGSHIP — ollama_repo_brief (operator map of a repo)
  server.tool(
    "ollama_repo_brief",
    "FLAGSHIP compound job. Produces an OPERATOR MAP of a repo: `{repo_thesis, key_surfaces, architecture_shape, risk_areas, read_next, evidence, weak, coverage_notes, corpus_used}`. Takes source_paths (typically README + key src entries + manifests + docs) and optionally a corpus for cross-cutting context. Corpus-sourced evidence items carry retrieval `score`. Optional `corpus_min_evidence_score` drops corpus chunks below the relevance floor before the model sees them. Not a research clone — research answers a specific question; repo_brief synthesizes orientation. Every key_surface and risk_area cites evidence. read_next is INVESTIGATIVE (files or sections to look at), never prescriptive fixes or refactors. Thin evidence → weak=true with coverage notes. If you pre-extracted claims via ollama_extract with a frame argument, drop off-topic items before assembling source_paths — there's no in-brief topicality gate for path inputs.",
    repoBriefSchema.shape,
    { title: "Repo brief", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleRepoBrief(args, ctx), "ollama_repo_brief", extra),
  );

  // FLAGSHIP — ollama_change_brief (structured impact brief for a change)
  server.tool(
    "ollama_change_brief",
    "FLAGSHIP compound job. Produces a CHANGE IMPACT BRIEF: `{change_summary, affected_surfaces, why_it_matters, likely_breakpoints, validation_checks, release_note_draft, evidence, weak, coverage_notes, corpus_used}`. Accepts diff_text (split per file on `diff --git` markers) and/or source_paths (changed files), with an optional corpus for architecture context. Corpus-sourced evidence items carry retrieval `score`. Optional `corpus_min_evidence_score` drops corpus chunks below the relevance floor before the model sees them. Not a git chat bot — structured and reviewable. likely_breakpoints are INVESTIGATIVE reasoning about what could break; validation_checks are what to verify after the change. Never remedial (no 'apply this fix'). release_note_draft is a draft the operator reviews. If you pre-extracted claims via ollama_extract with a frame argument, drop off-topic items before assembling source_paths/diff_text — there's no in-brief topicality gate for diff/path inputs.",
    changeBriefSchema.shape,
    { title: "Change brief", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleChangeBrief(args, ctx), "ollama_change_brief", extra),
  );

  // PACK — ollama_incident_pack (deterministic orchestration, durable artifact)
  server.tool(
    "ollama_incident_pack",
    "PACK. Runs the full incident job end-to-end: triage_logs → corpus_search → incident_brief → deterministic markdown+JSON artifact on disk. Single call, single completed job, single pair of files the operator can keep and diff. Response is compact ({artifact:{markdown_path,json_path}, summary, steps}) — the full brief lives in the artifact, not the MCP payload. Fixed pipeline, fixed markdown layout, no prose drift. Use this instead of calling triage_logs + incident_brief manually when you want one deliverable.",
    incidentPackSchema.shape,
    { title: "Incident pack (writes artifact)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleIncidentPack(args, ctx), "ollama_incident_pack", extra),
  );

  // PACK — ollama_repo_pack (onboarding job, corpus-first, durable artifact)
  server.tool(
    "ollama_repo_pack",
    "PACK. Runs the full repo ONBOARDING job: corpus_search (if corpus given) → repo_brief → targeted ollama_extract (narrow onboarding schema: packages, entrypoints, scripts, config_files, exposed_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Corpus-first posture: when a corpus is given, it's the main working surface alongside source_paths. Not repo Q&A — this is `get me onboarded fast with a stable operator artifact`. Response is compact; full brief + extracted facts live in the artifact.",
    repoPackSchema.shape,
    { title: "Repo pack (writes artifact)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleRepoPack(args, ctx), "ollama_repo_pack", extra),
  );

  // PACK — ollama_change_pack (change-centered review job, durable artifact)
  server.tool(
    "ollama_change_pack",
    "PACK. Runs the full change REVIEW job: assemble evidence (diff + paths + corpus if given) → triage_logs ONLY when log_text is provided → change_brief → targeted ollama_extract (narrow review schema: scripts_touched, config_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Change-first, not repo-first — this is about the DELTA, not a tour. Release note draft is a blockquote-wrapped DRAFT (not marketing copy). No VCS integration — caller hands in diff_text / source_paths / optional log_text. Response is compact; full brief + extracted facts live in the artifact.",
    changePackSchema.shape,
    { title: "Change pack (writes artifact)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleChangePack(args, ctx), "ollama_change_pack", extra),
  );

  // ARTIFACT — ollama_artifact_list (metadata-only index over pack artifacts)
  server.tool(
    "ollama_artifact_list",
    "ARTIFACT. Metadata-only index of pack artifacts on disk. Returns one compact record per artifact: `{pack, slug, title, created_at, weak, corpus_used, evidence_count, section_counts, md_path, json_path}`. Filter by pack / date_after / date_before / weak_only / strong_only; sort is newest first. Scans ~/.ollama-intern/artifacts/{incident,repo,change} by default; pass extra_artifact_dirs for additional read-only search surfaces. Full payloads belong to ollama_artifact_read — listing stays cheap.",
    artifactListSchema.shape,
    { title: "List artifacts", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleArtifactList(args, ctx), "ollama_artifact_list", extra),
  );

  // ARTIFACT — ollama_artifact_read (typed read by identity or path)
  server.tool(
    "ollama_artifact_read",
    "ARTIFACT. Read a single pack artifact, typed by pack. Primary: `{pack, slug}` — identity-based, collisions fail loud. Secondary: `{json_path}` — absolute path, must live under a recognized artifact dir (canonical roots + extra_artifact_dirs), must end in .json, path-traversal rejected. Returns `{metadata, artifact}` where artifact is a discriminated union on `pack` (incident_pack / repo_pack / change_pack — payloads stay distinct, never flattened).",
    artifactReadSchema.shape,
    { title: "Read artifact", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleArtifactRead(args, ctx), "ollama_artifact_read", extra),
  );

  // ARTIFACT — ollama_artifact_diff (structured same-pack comparison)
  server.tool(
    "ollama_artifact_diff",
    "ARTIFACT. Structured diff of two same-pack artifacts. Input: `{a: {pack, slug}, b: {pack, slug}}` — must share pack; cross-pack diffs refused loudly. Returns `{pack, a, b, weak, diff}` with weak flip surfaced at top level (strong→weak or weak→strong). Lists diff as {added, removed, unchanged} matched on primary key per item kind; narrative fields as {before, after}; release_note_draft also carries a compact LCS line_diff. Evidence is SUMMARIZED (counts + referenced_paths + path_delta), never exploded chunk-by-chunk. Deterministic ordering on every list.",
    artifactDiffSchema.shape,
    { title: "Diff artifacts", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleArtifactDiff(args, ctx), "ollama_artifact_diff", extra),
  );

  // ARTIFACT — ollama_artifact_export_to_path (handoff move, narrow writer)
  server.tool(
    "ollama_artifact_export_to_path",
    "ARTIFACT. Writes the artifact's EXISTING markdown to a caller-specified path with a provenance header prepended. No re-render, no model call. Path safety is strict: target_path must be absolute, must end in .md, must live under one of `allowed_roots` (REQUIRED — caller declares intent). Overwrite is opt-in: existing files refuse by default so re-runs never clobber hand-edits. Not a generic file writer — export is the single handoff move.",
    artifactExportToPathSchema.shape,
    { title: "Export artifact to path", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleArtifactExportToPath(args, ctx), "ollama_artifact_export_to_path", extra),
  );

  // ARTIFACT — ollama_artifact_incident_note_snippet (operator note fragment)
  server.tool(
    "ollama_artifact_incident_note_snippet",
    "ARTIFACT. Renders a compact incident-note markdown fragment from an incident_pack artifact — top hypotheses, affected surfaces, next checks, with an evidence-aware operator tone. No model call, no re-render; pure derivation from stored JSON. Returns `{rendered, metadata}`. For the full artifact use artifact_read; for the whole markdown as a reviewable file use artifact_export_to_path.",
    artifactIncidentNoteSnippetSchema.shape,
    { title: "Incident-note snippet", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleArtifactIncidentNoteSnippet(args, ctx), "ollama_artifact_incident_note_snippet", extra),
  );

  // ARTIFACT — ollama_artifact_onboarding_section_snippet (handbook fragment)
  server.tool(
    "ollama_artifact_onboarding_section_snippet",
    "ARTIFACT. Renders a handbook-ready `## What this repo is` section from a repo_pack artifact — thesis, key surfaces, read-next, runtime hints. Investigative tone preserved (read-next is LOOK AT, not prescriptive). No model call. Returns `{rendered, metadata}`.",
    artifactOnboardingSectionSnippetSchema.shape,
    { title: "Onboarding-section snippet", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleArtifactOnboardingSectionSnippet(args, ctx), "ollama_artifact_onboarding_section_snippet", extra),
  );

  // ARTIFACT — ollama_artifact_release_note_snippet (change pack DRAFT fragment)
  server.tool(
    "ollama_artifact_release_note_snippet",
    "ARTIFACT. Renders the release-note draft from a change_pack artifact as a blockquote-wrapped DRAFT fragment with the caveat preserved. No model call, no polishing, no marketing lift. Returns `{rendered, metadata}` — operator reviews before publishing.",
    artifactReleaseNoteSnippetSchema.shape,
    { title: "Release-note snippet", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleArtifactReleaseNoteSnippet(args, ctx), "ollama_artifact_release_note_snippet", extra),
  );

  // FLAGSHIP — ollama_embed_search (ephemeral concept search on ad-hoc candidates)
  server.tool(
    "ollama_embed_search",
    "FLAGSHIP. Rank AD-HOC candidates by concept similarity to a query. Pass `query` + `candidates: [{id, text}]`; server embeds everything, computes cosine, returns ranked `[{id, score, preview?}]`. Use this when you have in-memory candidates to compare; for persistent recall over memory/canon/doctrine use ollama_corpus_search instead. Does NOT return raw vectors to you.",
    embedSearchSchema.shape,
    { title: "Embed search (ad-hoc)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleEmbedSearch(args, ctx), "ollama_embed_search", extra),
  );

  // Corpus builder
  server.tool(
    "ollama_corpus_index",
    "CORPUS. Build a persistent named corpus. Pass `name` + `paths: string[]`; the server chunks, embeds, stores the corpus at ~/.ollama-intern/corpora/<name>.json AND writes a manifest at <name>.manifest.json that captures the declared paths + chunk params + embed model. Idempotent — unchanged files are reused by sha256; changed files are re-embedded; paths not in the input are dropped. For day-to-day upkeep once a manifest exists, prefer `ollama_corpus_refresh` — it reconciles corpus vs manifest and reports drift.",
    corpusIndexSchema.shape,
    { title: "Index corpus", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusIndex(args, ctx), "ollama_corpus_index", extra),
  );

  // Corpus refresh — living-corpus workflow: reconcile against manifest
  server.tool(
    "ollama_corpus_refresh",
    "CORPUS. Reconcile a named corpus against its manifest (intent vs reality). Single arg: `name`. The manifest's declared paths, chunk params, and embed model are the source of truth — refresh doesn't accept them. Returns a drift report: added / changed / unchanged / deleted / missing (per-path lists) plus reused / reembedded / dropped (chunk-level counts) plus no_op. Idempotent: a no-change refresh is fast, boring, and makes zero embed calls.",
    corpusRefreshSchema.shape,
    { title: "Refresh corpus", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusRefresh(args, ctx), "ollama_corpus_refresh", extra),
  );

  // Corpus list
  server.tool(
    "ollama_corpus_list",
    "CORPUS. List named corpora on disk with stats. No Ollama call. Use to discover what's been indexed, check freshness (indexed_at), or verify a corpus exists before searching.",
    corpusListSchema.shape,
    { title: "List corpora", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusList(args, ctx), "ollama_corpus_list", extra),
  );

  // Corpus health — dedicated superset of corpus_list with drift + staleness surfaced.
  server.tool(
    "ollama_corpus_health",
    "CORPUS. Health summary for indexed corpora. No Ollama call. A true superset of ollama_corpus_list (every list key, same spelling, compiler-enforced) plus: staleness_days, embed_model_resolved, within-refresh :latest drift, failed_path_count, write_complete, and per-corpus warnings[]. Optional `name` narrows to a single corpus (typos fail loud). Optional `detailed: true` adds a per-file list with mtime + stale_days. Use this as your go-to 'is anything broken?' check before search or refresh.",
    corpusHealthSchema.shape,
    { title: "Corpus health", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusHealth(args, ctx), "ollama_corpus_health", extra),
  );

  // Corpus amend — single-file mutation, breaks snapshot invariant (warned).
  server.tool(
    "ollama_corpus_amend",
    "CORPUS. Update one file's chunks in a corpus without running a full refresh. INVARIANT CAVEAT: the corpus is normally a snapshot of disk — amend bypasses that. new_content doesn't have to match (or even exist on) disk. The manifest records has_amended_content: true so corpus_list / corpus_health surface the break; a subsequent clean index/refresh re-establishes the invariant. Takes the per-corpus lock. Re-chunks + re-embeds the new_content using the manifest's chunk params (unless explicitly overridden). Returns `{corpus, file_path, chunks_removed, chunks_added, embed_model_resolved}`.",
    corpusAmendSchema.shape,
    { title: "Amend corpus", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusAmend(args, ctx), "ollama_corpus_amend", extra),
  );

  // Corpus amend history — read-only companion to corpus_amend (no LLM).
  server.tool(
    "ollama_corpus_amend_history",
    "CORPUS. Read-only companion to ollama_corpus_amend. Lists which paths have been amended on top of the disk snapshot, when each amendment happened, and the chunk-count delta. Use this before deciding whether to re-index — a clean ollama_corpus_index or ollama_corpus_refresh re-establishes the snapshot invariant and clears the history. No LLM call; pure manifest read.",
    corpusAmendHistorySchema.shape,
    { title: "Corpus amend history", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusAmendHistory(args, ctx), "ollama_corpus_amend_history", extra),
  );

  // Corpus rerank — post-retrieval re-sort (no LLM).
  server.tool(
    "ollama_corpus_rerank",
    "CORPUS. Post-retrieval re-sort of hits from a prior ollama_corpus_search. No Ollama call (no embed, no generate). Three modes: 'recency' (newer file mtime wins; stats the file), 'path_specificity' (deeper paths win), 'lexical_boost' (boosts hits whose preview/heading_path/title contains any lexical_terms — case-insensitive, word-boundary; lexical_terms REQUIRED for this mode). Preserves each hit's original score + original_rank; appends rerank_score + rank. Use after corpus_search when you need a different ordering heuristic than semantic similarity.",
    corpusRerankSchema.shape,
    { title: "Rerank hits", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleCorpusRerank(args, ctx), "ollama_corpus_rerank", extra),
  );

  // LOW-LEVEL — ollama_embed (raw vectors for external index builds)
  server.tool(
    "ollama_embed",
    "LOW-LEVEL primitive. Returns raw 768-dim vectors for one text or a batch. WARNING: raw vectors can overflow MCP tool-output limits on large batches — for concept search prefer `ollama_embed_search` (ephemeral candidates) or `ollama_corpus_search` (persistent corpora); both return ranked hits, not raw geometry. Use this only for building external vector indexes (sqlite-vss, pgvector) where you need the vectors themselves. Envelope emits a warnings[] entry when the serialized payload crosses ~500KB.",
    embedSchema.shape,
    { title: "Embed texts", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleEmbed(args, ctx), "ollama_embed", extra),
  );

  // Core — classify (batch-capable)
  server.tool(
    "ollama_classify",
    "EXTRACT. Single-label classification with confidence. Single: pass `text`. BATCH: pass `items:[{id,text}]` — returns ONE envelope with `result.items[]` of `{id, ok, result|error}` plus `batch_count/ok_count/error_count`. Use the batch shape to chew through bulk labeling (commit types, PR titles, log severities) in one handoff instead of N round-trips. Set allow_none=true when weak guesses are worse than 'unsure' — label returns null below threshold (default 0.7). FRAME CONTRACT (optional): pass `frame` (the question / section purpose this label set is FOR) and the model first decides whether the input is on-topic. Off-topic inputs return label=null with `off_topic: true` + `off_topic_reason` regardless of label fit — distinct from below_threshold (weak fit within the right frame). Omitting `frame` preserves the legacy result shape.",
    classifySchema.shape,
    { title: "Classify", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleClassify(args, ctx), "ollama_classify", extra),
  );

  // Core — triage_logs (batch-capable)
  server.tool(
    "ollama_triage_logs",
    "DIGEST. Stable-shape log digest: {errors, warnings, suspected_root_cause}. Single: pass `log_text`. BATCH: pass `items:[{id,log_text}]` for triaging many log blobs at once (multiple CI runs, matrix legs, per-service logs) — returns one envelope with per-item entries. Use before grep-storms on long CI/test output.",
    triageLogsSchema.shape,
    { title: "Triage logs", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleTriageLogs(args, ctx), "ollama_triage_logs", extra),
  );

  // Core — summarize_fast
  server.tool(
    "ollama_summarize_fast",
    "DIGEST. Gist of short input (best under ~4k tokens). Use as a decision gate: 'is this file worth reading in full?' Summary carries source_preview so you can spot-check fabrication. FRAME CONTRACT (optional): pass `frame` (the question / section purpose this summary is FOR) and the model first decides whether the input addresses it. Off-topic inputs return summary='(off-topic for frame: ...)' with `on_topic: false` instead of paraphrasing unrelated content. Omitting `frame` preserves the legacy result shape.",
    summarizeFastSchema.shape,
    { title: "Summarize (fast)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleSummarizeFast(args, ctx), "ollama_summarize_fast", extra),
  );

  // Core — summarize_deep
  server.tool(
    "ollama_summarize_deep",
    "DIGEST. Digest of long input with optional focus. Pass EXACTLY ONE of: `text` (raw content in hand), `source_path` (single file — server reads + chunks, Claude never pre-reads), or `source_paths[]` (multiple files). The path-based shapes save Claude context — the whole point of delegating summarization. Carries source_preview for fabrication spot-checks. FRAME CONTRACT (optional): pass `frame` (the question / section purpose this digest is FOR — distinct from `focus`, which is emphasis WITHIN an in-frame source). Sources that don't address the frame are dropped from the digest and listed under `unaddressed_sources`; if NO source addresses it, summary='' and `frame_addressed: false`. Omitting `frame` preserves the legacy result shape.",
    summarizeDeepSchema.shape,
    { title: "Summarize (deep)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleSummarizeDeep(args, ctx), "ollama_summarize_deep", extra),
  );

  // Core — draft
  server.tool(
    "ollama_draft",
    "DRAFT code or prose stubs (never autonomous — Claude reviews). Pass language for a server-side compile check: envelope returns {compiles, checker, stderr_tail}. target_path pointing into memory/, .claude/, docs/canon/, games/ requires confirm_write: true.",
    draftSchema.shape,
    { title: "Draft text", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleDraft(args, ctx), "ollama_draft", extra),
  );

  // Core — extract (batch-capable)
  server.tool(
    "ollama_extract",
    "EXTRACT. Schema-constrained JSON extraction using Ollama's JSON mode. Single: pass `text`, returns `{ok: true, data}` or `{ok: false, error: 'unparseable'}` — never partial. BATCH: pass `items:[{id,text}]` with a shared schema — returns one envelope with per-item `{id, ok, result|error}`. Use the batch shape for any 10+-similar-inputs workload (frontmatter, package.json, release metadata) so you hand over the whole job, not N calls. FRAME CONTRACT (optional): pass `frame` (the question / section purpose this extraction is FOR). The model first judges on-topic vs off-topic; result lifts a top-level `frame_alignment: { on_topic, reason, unaddressed_aspects? }`. Off-topic sources return an empty data shape rather than paraphrasing unrelated content into the schema. Omitting `frame` preserves the legacy result shape.",
    extractSchema.shape,
    { title: "Extract structured data", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleExtract(args, ctx), "ollama_extract", extra),
  );

  // ── Feature-pass tools (agent: Tools) — no-LLM ops + instant-tier helpers ──
  // This block is intentionally isolated so the Tools-refactor agent can
  // register alongside without conflicts. Do not interleave with tiered tools.

  // OPS — ollama_doctor (first-run prerequisites + status snapshot)
  server.tool(
    "ollama_doctor",
    "OPS. First-run prerequisites + status snapshot for this MCP. No model call. Probes Ollama reachability (/api/ps + /api/tags), lists loaded vs pulled models, flags missing models against the active profile's tiers, and reports profile, tiers, OLLAMA_HOST, allowed_roots, artifact_root, log_path, plus the last 10 errors from ~/.ollama-intern/log.ndjson. Returns `{ollama, models:{required, pulled, loaded, missing, suggested_pulls}, profile, paths, recent_errors, healthy}`. Use this BEFORE the first real delegation to decide whether the operator needs to pull a model or start Ollama. Safe to call on every session start.",
    doctorSchema.shape,
    { title: "Doctor (health snapshot)", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleDoctor(args, ctx), "ollama_doctor", extra),
  );

  // OPS — ollama_artifact_prune (dry-run-by-default cleanup of pack artifacts)
  server.tool(
    "ollama_artifact_prune",
    "OPS. Clean up ~/.ollama-intern/artifacts/. No model call. DRY-RUN BY DEFAULT — pass `dry_run: false` to actually delete. Filter by `older_than_days` (file mtime) and/or `pack` ('incident_pack' | 'repo_pack' | 'change_pack' | 'all') — the same spelling artifact_list / artifact_read / artifact_diff use, so an identity round-trips. The pre-v2.9.2 `pack_type` ('incident' | 'change' | 'repo') is still accepted so an existing filter is never silently widened to every pack. Deletes matched files in .md + .json pairs. Returns `{matched:[{pack, slug, age_days, bytes}], total_matched, total_bytes, dry_run, deleted, artifact_root}`. Use this when disk is creeping or the artifact dir has stale handoffs you don't need.",
    artifactPruneSchema.shape,
    { title: "Prune artifacts (deletes)", readOnlyHint: false, destructiveHint: true },
    (args, extra) => wrap(() => handleArtifactPrune(args, ctx), "ollama_artifact_prune", extra),
  );

  // OPS — ollama_log_tail (structured NDJSON log tail)
  server.tool(
    "ollama_log_tail",
    "OPS. Structured tail of the NDJSON observability log at ~/.ollama-intern/log.ndjson (override via INTERN_LOG_PATH). No model call. Optional filters: `limit` (default 50, max 500), `filter_kind` (the COMPLETE roster, matched by EXACT equality — 'call' | 'timeout' | 'fallback' | 'backend_fallback' | 'cloud_egress' | 'guardrail' | 'prewarm' | 'prewarm:in_progress_request' | 'semaphore:wait' | 'pack_step' — so mind the colon forms, and note that 'cloud_egress' is the data-left-the-machine event), `filter_tool`, `since` (ISO-8601). Truncated final lines are skipped silently. Missing log file is a soft-empty case, not an error. Returns `{events, total_returned, log_path, log_present}`. Use this to debug why a call was slow / what timed out / what the last failures were.",
    logTailSchema.shape,
    { title: "Tail NDJSON log", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleLogTail(args, ctx), "ollama_log_tail", extra),
  );

  // OPS — ollama_log_stats (aggregate the NDJSON receipts — measured economics)
  server.tool(
    "ollama_log_stats",
    "OPS. Aggregate the NDJSON receipts into measured economics — no model call, no egress, instant. Optional `since` (ISO-8601) bounds the window ('tokens this week'). Returns `{totals:{calls, tokens_in, tokens_out}, by_tool:{calls, tokens, cloud_calls, degraded_calls, elapsed_ms:{p50, p95}}, by_tier, backend:{cloud_calls, local_calls, degraded_calls, unrouted_calls, backend_fallback_events, fallback_rate}, tier_events:{timeouts, fallbacks}, elapsed_ms:{p50, p95}, events_scanned, log_path, log_present}`. fallback_rate = degraded/(cloud-intended) — the early-warning that cloud is degrading; null when nothing intended cloud. Answers 'cloud vs local split', 'fallback rate', 'p95 per tool' without jq. Empty/absent log → zeros, never an error. Use ollama_log_tail for the raw events behind any number here.",
    logStatsSchema.shape,
    { title: "Log stats (measured economics)", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleLogStats(args, ctx), "ollama_log_stats", extra),
  );

  // ORIENT — ollama_code_map (fast structural repo summary, deterministic)
  server.tool(
    "ollama_code_map",
    "ORIENT. Fast structural summary of a repo — deterministic, no model call. Pass `source_paths: string[]` (files OR directories; directories are walked recursively, skipping node_modules/dist/target/.git/.venv) and optional `max_files` (default 500). Reads package.json / pyproject.toml / Cargo.toml / go.mod for framework hints; tallies files by extension; classifies entrypoints (cli/lib/web/test/config) by filename + manifest bin field; collects build_commands from package.json scripts. Returns `{languages, frameworks, entrypoints, build_commands, notable_files, total_files_scanned, max_files_hit}`. Cheap first pass before ollama_repo_pack or ollama_research. When the pass is partial (max_files_hit), the warning says so.",
    codeMapSchema.shape,
    { title: "Code map (deterministic)", readOnlyHint: true, destructiveHint: false },
    (args, extra) => wrap(() => handleCodeMap(args, ctx), "ollama_code_map", extra),
  );

  // ── Feature-pass tools (agent: Tools-new) — refactor/proof/citation/drill ──
  // This block is intentionally isolated so the Tools-new agent can
  // register alongside without conflicts. Do not interleave with tiered tools.

  // REFACTOR — ollama_multi_file_refactor_propose (Workhorse tier)
  server.tool(
    "ollama_multi_file_refactor_propose",
    "REFACTOR. Coordinated multi-file refactor PLAN — NO WRITES. Server reads each file in `files` (1-20 paths, path validation via SOURCE_PATH_NOT_FOUND), hands the bodies + `change_description` to the Workhorse tier, and returns `{per_file_changes:[{file, before_summary, after_summary, risk_level, change_kinds[]}], cross_file_impact, affected_imports:[{from, to, files[]}], verification_steps, weak}`. change_kinds are normalized from {rename, signature-change, import-update, move, delete, new}. Files the model invents (not in input) are stripped. Thin output → weak=true. Use BEFORE touching files so Claude can see a coordinated plan. Pair with ollama_refactor_plan for sequencing and ollama_batch_proof_check for verification.",
    multiFileRefactorProposeSchema.shape,
    { title: "Propose multi-file refactor", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleMultiFileRefactorPropose(args, ctx), "ollama_multi_file_refactor_propose", extra),
  );

  // OPS — ollama_batch_proof_check (no-LLM, parallel CLI proof aggregation)
  server.tool(
    "ollama_batch_proof_check",
    "OPS. Parallel typecheck/lint/test across a file list. NO MODEL CALL. Pass `checks: ['typescript' | 'eslint' | 'pytest' | 'ruff' | 'cargo-check'][]` (min 1), optional `files[]` (scope filter for lint/test tools that accept it), optional `cwd` (default process.cwd()), optional `timeout_ms` (default 60_000 per check). Each check runs in parallel under its own timeout. Missing tools (ENOENT / exit 127) report as status:'missing' — NOT a fail. Timeouts are status:'timeout'. Returns `{checks:[{check, status:'pass'|'fail'|'timeout'|'missing', exit_code, stderr_tail, stdout_tail, elapsed_ms, failures?:[{file?, line?, message}]}], all_passed, any_missing}`. Use AFTER ollama_multi_file_refactor_propose to verify the refactor landed green.",
    batchProofCheckSchema.shape,
    { title: "Batch proof check (runs linters/tests)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleBatchProofCheck(args, ctx), "ollama_batch_proof_check", extra),
  );

  // REFACTOR — ollama_refactor_plan (Workhorse tier — phased sequencing)
  server.tool(
    "ollama_refactor_plan",
    "REFACTOR. Phased SEQUENCING plan for a multi-file refactor — complement to multi_file_refactor_propose. Same inputs (`files`, `change_description`, optional `per_file_max_chars`) plus `priority: 'safety' | 'speed' | 'parallelism'` (default 'safety'). Server reads the files and asks the Workhorse tier for a phased plan: `{phases:[{phase, files_involved, reason, tests_to_write, parallelizable}], sequencing_notes, rollback_strategy, estimated_phases, weak}`. Phases are renumbered 1..N in arrival order. files_involved is strictly intersected with the input set. Missing rollback_strategy or empty tests with no sequencing notes → weak=true. Use this when you know WHAT to change (multi_file_refactor_propose covers that) but need HOW to land it safely.",
    refactorPlanSchema.shape,
    { title: "Refactor plan", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleRefactorPlan(args, ctx), "ollama_refactor_plan", extra),
  );

  // RESEARCH — ollama_code_citation (Deep tier — per-claim line-range citations)
  server.tool(
    "ollama_code_citation",
    "RESEARCH. Answer a code question with PER-CLAIM CITATIONS (file + line range). Distinct from ollama_research: research cites files, code_citation cites LINES. Pass `question` (10-1000 chars), `source_paths[]`, optional `per_file_max_chars` (default 100_000). Server numbers each line 1-based in the prompt so the Deep tier can anchor claims exactly. Returns `{answer, citations:[{claim_fragment, file, start_line, end_line, excerpt}], uncited_fragments[], weak}`. Citations to files outside source_paths are stripped (same rule as ollama_research). Citations with line ranges outside the loaded file bounds are also stripped — each stripping reason lands in warnings[]. Empty answer or answer-without-citations flips weak=true.",
    codeCitationSchema.shape,
    { title: "Code citations", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleCodeCitation(args, ctx), "ollama_code_citation", extra),
  );

  // REVIEW — ollama_code_review (Workhorse default — structured PR review findings)
  server.tool(
    "ollama_code_review",
    "REVIEW. Given a unified diff (and optional source_paths for context), returns STRUCTURED FINDINGS: `{findings:[{severity, category, file, line?, symbol?, description, recommendation}], summary, diff_size_bytes, total_findings, max_findings_hit}`. `total_findings` counts what survived the severity floor BEFORE `max_findings` trimmed, and `max_findings_hit` says the list was cut — so a capped review never reads as a complete one. Severity enum critical|high|medium|low; category enum bug|security|performance|style|maintainability. Distinct from ollama_multi_file_refactor_propose (proposes refactors) — code_review flags issues to fix on the diff as-is. Optional `severity_floor` filters out below-floor findings; `max_findings` caps result. Diff capped at 2MB; source_paths max 50. Tier defaults to workhorse; pass `tier:'deep'` for high-stakes review. coerceReview drops malformed entries instead of throwing.",
    codeReviewSchema.shape,
    { title: "Code review", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleCodeReview(args, ctx), "ollama_code_review", extra),
  );

  // DRILL — ollama_hypothesis_drill (Deep tier — zoom into one incident hypothesis)
  server.tool(
    "ollama_hypothesis_drill",
    "DRILL. Zoom into ONE hypothesis from an existing incident_pack artifact. No re-running triage + brief. Pass `artifact_slug` (from ollama_artifact_list), `hypothesis_index` (0-based into that artifact's root_cause_hypotheses), optional `extra_artifact_dirs[]`. Server loads the artifact, extracts the targeted hypothesis + its linked evidence, and runs a Deep-tier focused sub-brief. Returns `{parent_artifact_slug, drilled_hypothesis:{statement, confidence, evidence_cited:[{id, preview}], supporting_reasoning, ruled_out_reasons?}, other_hypotheses_summary:[{index, summary}], weak}`. Invalid index → HYPOTHESIS_INDEX_INVALID with the valid range. Non-incident or missing slug → ARTIFACT_NOT_FOUND with a next-step hint.",
    hypothesisDrillSchema.shape,
    { title: "Hypothesis drill", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleHypothesisDrill(args, ctx), "ollama_hypothesis_drill", extra),
  );

  // Cross-family verification — the verify muscle for external orchestrators
  // (role-os EXTERNAL_VERIFIER, advisor-loop cross-checks). CLOUD tool.
  server.tool(
    "ollama_verify_claims",
    "VERIFY. Adjudicate claims with a cross-family Ollama Cloud flagship panel — the counterpart to ollama_code_review (which GENERATES findings; this ADJUDICATES them). CLOUD-REQUIRED: refuses with CLOUD_NOT_CONFIGURED unless OLLAMA_API_KEY is set; the juror calls are the only egress, and claims + source_paths + reference ARE sent to Ollama Cloud. Pass `claims:[{id, statement}]` (1-20, unique ids, falsifiable statements; extra fields like the author's reasoning are REJECTED by schema — jurors judge evidence, not arguments), optional `source_paths[]` (server-loaded shared evidence), optional `reference` (ground truth — test/lint/measured output; supply it whenever you have it, it sharply raises juror reliability), optional `panel[]` (default is a 3-model disjoint-family flagship trio: deepseek-v4-pro:cloud / kimi-k2.7-code:cloud / glm-5.2:cloud; cloud ids rotate server-side — re-check ollama.com/search?c=cloud, or run `ollama-intern-mcp doctor --cloud-check`, which reports each configured cloud id as present / NOT IN CATALOG with a nearest-live-id suggestion, when a juror 404s), optional `min_refute_votes` (default 2). Aggregation is lone-dissent-never-decides: REFUTED needs >=min_refute_votes refutes, CONFIRMED needs >=2 confirms, else NEEDS_REVIEW. A juror served by local fallback or whose served model mismatches the request is EXCLUDED from the vote and flagged in result.panel — never silently counted. Returns `{claims:[{id, statement, verdict, confidence, refute_votes, confirm_votes, uncertain_votes, jurors:[{model, verdict, severity, rationale}]}], panel:[{model, served_model, included, exclude_reason?, verdicts_returned}], summary, min_refute_votes, weak}`. HONEST CEILING: a CONFIRMED on frontier-model-authored claims is weak evidence, not proof — the panel reliably flags gross errors and is weaker on a strong generator's subtle ones; `confidence` reflects juror agreement, and `weak:true` means fewer than 2 jurors served.",
    verifyClaimsSchema.shape,
    { title: "Verify claims (cross-family cloud jury)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleVerifyClaims(args, ctx), "ollama_verify_claims", extra),
  );

  // Last resort — chat
  server.tool(
    "ollama_chat",
    "LAST RESORT catch-all. Prefer a specialty tool above when one fits. If you reach for this often, a specialty tool is missing and should be added.",
    chatSchema.shape,
    { title: "Chat (last resort)", readOnlyHint: false, destructiveHint: false },
    (args, extra) => wrap(() => handleChat(args, ctx), "ollama_chat", extra),
  );

  return server;
}

async function main(): Promise<void> {
  // Profile resolution can now throw CONFIG_INVALID (unknown INTERN_PROFILE).
  // Catch here so the operator sees a human-readable one-liner on stderr
  // instead of a stack. Hint includes the available names.
  let profile: ReturnType<typeof loadProfile>;
  try {
    profile = loadProfile();
  } catch (err) {
    if (err instanceof InternError) {
      // eslint-disable-next-line no-console
      console.error(`ollama-intern: ${err.message}\n  hint: ${err.hint}`);
      process.exit(1);
    }
    throw err;
  }

  // Cloud is opt-in. loadCloudConfig returns null when neither
  // OLLAMA_CLOUD_PRIMARY nor OLLAMA_API_KEY is set, a STANDBY config when
  // only the key is set (F2a — local-primary, per-call escalation), a
  // primary config when both are, and throws CONFIG_INVALID (fail-fast) if
  // PRIMARY is enabled without a key. Catch here so the operator sees a
  // one-liner, not a stack.
  let cloud: CloudConfig | null;
  try {
    cloud = loadCloudConfig();
  } catch (err) {
    if (err instanceof InternError) {
      // eslint-disable-next-line no-console
      console.error(`ollama-intern: ${err.message}\n  hint: ${err.hint}`);
      process.exit(1);
    }
    throw err;
  }

  const logger = new NdjsonLogger();
  const local = new HttpOllamaClient();
  // The cloud HTTP client (Bearer auth, cloud host) — only built when opted in.
  const cloudClient = cloud
    ? new HttpOllamaClient({ baseUrl: cloud.host, apiKey: cloud.apiKey, kind: "cloud" })
    : null;
  // When cloud is configured, every tool talks to a RoutingOllamaClient —
  // cloud-primary tries cloud first with local fallback; STANDBY (F2a) stays
  // local-primary and serves cloud only on per-call backend:'cloud'
  // escalations. Otherwise ctx.client is the plain local client —
  // byte-identical to pre-cloud behavior.
  const client: OllamaClient =
    cloud && cloudClient
      ? new RoutingOllamaClient({
          cloud: cloudClient,
          local,
          cloudTiers: cloud.tiers,
          localTiers: profile.tiers,
          cloudTimeouts: cloud.timeouts,
          cloudNumCtx: cloud.numCtx,
          logger,
          standby: cloud.standby,
          cloudHost: cloud.host,
          // F-ef444c5d — the declared standby escalation policy. Empty by
          // default, which keeps a key-alone install at zero egress.
          standbyEscalateTiers: cloud.standbyEscalateTiers,
        })
      : local;

  const ctx: RunContext = {
    client,
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger,
    cloud,
  };

  if (cloud && !cloud.standby) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: cloud-primary ON — ${cloud.tiers.instant} (deep: ${cloud.tiers.deep}) via ${cloud.host}; local fallback profile=${profile.name}. Embeddings stay local.`,
    );
    // A knob that silently does nothing is the FT-002 anti-pattern. Under
    // cloud-primary every tier already serves from cloud, so the standby
    // policy is inert — say so rather than letting the operator believe
    // they narrowed their egress.
    if (cloud.standbyEscalateTiers.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `ollama-intern: INTERN_CLOUD_STANDBY_TIERS=${cloud.standbyEscalateTiers.join(",")} has NO EFFECT under cloud-primary — every tier already routes to cloud. Unset OLLAMA_CLOUD_PRIMARY to run standby with that escalation policy.`,
      );
    }
  } else if (cloud) {
    // F-ef444c5d — the startup line must name WHICH tiers leave the box.
    // "Zero egress until a call requests it" is only true with an empty
    // policy; with one set, this line is where the operator is told what
    // they turned on, before anything is sent.
    const policy =
      cloud.standbyEscalateTiers.length > 0
        ? `Escalation policy INTERN_CLOUD_STANDBY_TIERS=${cloud.standbyEscalateTiers.join(",")} — calls on ${cloud.standbyEscalateTiers.length === 1 ? "that tier" : "those tiers"} GO TO CLOUD by default (a per-call backend:'local' still pins one local); every other tier stays local.`
        : `Zero egress until a call requests it.`;
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: cloud STANDBY — local-primary (profile=${profile.name}); per-call backend:'cloud' escalation available → ${cloud.host} (${cloud.tiers.instant}; deep: ${cloud.tiers.deep}). ${policy} Embeddings stay local.`,
    );
  }

  // Surface env-var tier overrides at startup instead of silently applying
  // them. Operator sees one stderr line per override (key, tier, from → to)
  // so a pinned model never goes unnoticed through a benchmark run.
  const overrides = detectEnvOverrides();
  for (const o of overrides) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: ${o.key} overrides ${o.tier}: ${o.from} → ${o.to} (profile=${profile.name})`,
    );
  }

  // Wire the HTTP client's side-observability hook (semaphore waits,
  // residency probe failures) to the same NDJSON logger the tools use.
  setClientLogger(ctx.logger);
  setClientProfileName(profile.name);

  // Startup probe: check Ollama reachability but NEVER crash the server.
  // MCP clients routinely start this server before Ollama is ready, so a
  // fail-fast probe would break the common case. Instead we log + warn
  // once so the failure is visible, then continue into normal startup.
  // Skippable for tests / CI via INTERN_SKIP_STARTUP_PROBE=1.
  if (process.env.INTERN_SKIP_STARTUP_PROBE !== "1") {
    const host = normalizeOllamaHost(process.env.OLLAMA_HOST);
    const probe = await ctx.client.probe(5_000);
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.error(
        `ollama-intern: Ollama unreachable at OLLAMA_HOST=${host} (${probe.reason ?? "unknown"}). Set OLLAMA_HOST correctly or start Ollama. See https://ollama.com/download.`,
      );
      void ctx.logger.log({
        kind: "guardrail",
        ts: timestamp(),
        tool: "startup",
        rule: "startup_probe",
        action: "warn",
        detail: { host, reason: probe.reason ?? "unknown" },
        // FT-001 — `op:'startup'` lets operators filter lifecycle events
        // apart from per-call guardrails. run_id intentionally absent —
        // startup happens outside any tool-call ALS scope.
        op: "startup",
      });
    }
    // Cloud reachability + auth probe (cloud-primary ONLY). Never crashes
    // startup — a down/misconfigured cloud just means calls fall back to
    // local. Surfaces the auth status immediately so a bad key is obvious.
    // STANDBY skips this deliberately: a startup probe would itself be
    // egress before any call opted in — a globally-exported OLLAMA_API_KEY
    // must not make the server phone home on boot (the zero-egress
    // guarantee covers startup, not just tool calls).
    if (cloudClient && cloud && !cloud.standby) {
      const cloudProbe = await cloudClient.probe(5_000);
      if (!cloudProbe.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `ollama-intern: Ollama Cloud unreachable/auth-failed at ${cloud.host} (${cloudProbe.reason ?? "unknown"}). Calls fall back to the local profile until cloud recovers — check OLLAMA_API_KEY.`,
        );
      } else {
        // /api/tags proves reachability, not key validity (it lists public
        // models). The key is validated on the first real call.
        // eslint-disable-next-line no-console
        console.error(`ollama-intern: Ollama Cloud reachable at ${cloud.host} (key validated on first call).`);
      }
    }
  }

  // Profile-policy prewarm: warms the Instant tier into VRAM on dev profiles
  // before connecting transport, so the first real Claude call doesn't eat
  // cold-load latency. The warm is a bounded window (PREWARM_KEEP_ALIVE),
  // and INTERN_PREWARM=off empties profile.prewarm for shared-GPU rigs.
  // Failures are logged but never throw — server startup must not depend
  // on Ollama being reachable.
  // Prewarm warms the LOCAL fallback model into VRAM — never cloud (cloud has
  // no residency and keep_alive is meaningless there). Pass the local client
  // explicitly so prewarm bypasses the routing layer in cloud-primary mode.
  if (profile.prewarm.length > 0) {
    await runPrewarm({ ...ctx, client: local }, profile.prewarm);
  }

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Install graceful-shutdown handlers (Stage C / F-001). The MCP server
  // runs under stdio transport; without these, SIGTERM/SIGINT tears the
  // process down immediately — leaving NDJSON log writes mid-append and
  // any in-flight corpus mutations unfinished. Operators reading the
  // log_tail after a kill should see a clear breadcrumb explaining what
  // stopped the server, not just an abrupt end-of-file.
  //
  // The corpus lock module (src/corpus/lock.ts) is in-process only and
  // does not expose a hasLock() / isLocked() predicate today. We log
  // best-effort and document the gap as a follow-up — adding a predicate
  // is corpus-guards' domain, not ours.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // Re-entrancy guard: a second SIGINT (^C twice impatient operator)
    // must not race a half-completed first shutdown. The first invocation
    // owns the cleanup; subsequent ones are no-ops.
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      // 1. Structured breadcrumb FIRST so log_tail shows what happened
      //    even if later steps wedge.
      await ctx.logger.log({
        kind: "guardrail",
        ts: timestamp(),
        tool: "shutdown",
        rule: "signal_received",
        action: "graceful_shutdown",
        detail: {
          signal,
          // lock_held is best-effort — corpus/lock.ts owns the predicate
          // and does not export one yet. Surface "unknown" honestly so an
          // operator reading the event knows it wasn't asserted clean.
          lock_held: "unknown",
          note: "corpus lock state not introspected; release on process exit",
        },
        // FT-001 — `op:'shutdown'` lets operators filter lifecycle events
        // apart from per-call guardrails. run_id intentionally absent —
        // shutdown happens outside any tool-call ALS scope.
        op: "shutdown",
      });
      // 2. Close the MCP server so transport flushes any pending response.
      //    server.close() is provided by @modelcontextprotocol/sdk; guarded
      //    with optional-chaining in case a future SDK rev removes it.
      await server.close?.();
    } catch {
      // Shutdown path must never throw — if logging or close() fails the
      // operator already pressed Ctrl-C; just continue to exit.
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  // Unhandled promise / exception: log a breadcrumb so log_tail shows
  // why the session died or wobbled. Do not rethrow. SIGTERM/SIGINT
  // remain the only process.exit(0) path; uncaughtException exits 1
  // AFTER the breadcrumb because Node's default is already fatal.
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: unhandledRejection — ${message}. MCP session stays up. Filter log_tail for rule=unhandled_rejection. If this repeats, restart the server and file a bug with the stack.`,
    );
    void ctx.logger.log({
      kind: "guardrail",
      ts: timestamp(),
      tool: "runtime",
      rule: "unhandled_rejection",
      action: "logged",
      detail: { message },
    });
  });
  process.on("uncaughtException", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: uncaughtException — ${message}. Logging breadcrumb then exiting; restart the MCP server.`,
    );
    void ctx.logger
      .log({
        kind: "guardrail",
        ts: timestamp(),
        tool: "runtime",
        rule: "uncaught_exception",
        action: "logged_then_exit",
        detail: { message },
      })
      .finally(() => {
        process.exit(1);
      });
  });
}

/**
 * CLI surface (Phase 7 / FT-003).
 *
 * `npm install -g ollama-intern-mcp` used to give an empty CLI: running
 * the bin with `--version`, `--help`, or any subcommand fell through to
 * `main()` and connected to stdio expecting an MCP client on the other
 * end. Operators couldn't even check whether the install succeeded
 * without standing up the MCP wiring first.
 *
 * This function intercepts known CLI verbs BEFORE the stdio handshake
 * and exits cleanly. When no recognized verb is present, we fall through
 * to `main()` (existing MCP-server behavior) so adding the CLI doesn't
 * regress the published MCP integration.
 *
 * No external CLI library is added — the four verbs the audit identified
 * (`--version`, `--help`, `doctor`, `init`) fit cleanly inside a hand-
 * rolled switch. Unknown args exit 1 with the help pointer so a typo
 * never silently becomes a hung stdio handshake.
 *
 * Returns `true` when a CLI verb was handled (caller skips main()),
 * `false` when no CLI verb matched and the caller should proceed with
 * the MCP-server startup path.
 */
async function runCli(argv: string[]): Promise<boolean> {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args.
  const args = argv.slice(2);
  if (args.length === 0) return false; // default: MCP stdio

  const first = args[0];

  // --version / -V — print and exit. Matches `npm --version` UX.
  if (first === "--version" || first === "-V") {
    // eslint-disable-next-line no-console
    console.log(VERSION);
    process.exit(0);
  }

  // --help / -h — print usage + tool roster + exit. Kept short; the
  // README is the long-form reference, this is the orientation snippet.
  if (first === "--help" || first === "-h") {
    printHelp();
    process.exit(0);
  }

  if (first === "doctor") {
    // F5: doctor owns its exit code now — 0 by default (report, don't gate),
    // 1 under --fail-unhealthy when the box isn't set up.
    process.exit(await runCliDoctor(args.slice(1)));
  }

  if (first === "init") {
    process.exit(await runCliInit(args.slice(1)));
  }

  // Unknown verb — exit 1 with the help pointer so a typo never silently
  // becomes a hung stdio handshake. Future verbs (e.g. `intern logs`)
  // land in the switch above before this fall-through fires.
  // eslint-disable-next-line no-console
  console.error(`ollama-intern: unknown command '${first}'. See --help for usage.`);
  process.exit(1);
}

function printHelp(): void {
  // Kept short so it fits in a terminal scroll-back. The exhaustive
  // 44-tool list belongs in the README/handbook; here we describe
  // what the CLI does, not what every MCP tool does.
  const lines = [
    `ollama-intern-mcp v${VERSION}`,
    ``,
    `MCP control plane for local cognitive labor — Ollama-backed tool tier`,
    `for Claude delegation. Default mode is the MCP stdio server; the CLI`,
    `verbs below run without starting the MCP transport.`,
    ``,
    `USAGE`,
    `  ollama-intern-mcp [command]`,
    ``,
    `COMMANDS`,
    `  (no args)        Start the MCP stdio server (default — used by MCP clients).`,
    `  doctor           Run ollama_doctor logic and print the report to stdout.`,
    `                   --json emits the structured DoctorResult plus warnings[]`,
    `                   and cloud_config_error (pipeable to jq);`,
    `                   --fail-unhealthy exits 1 when unhealthy (CI gate — a bad`,
    `                   cloud key counts as unhealthy; a cloud outage does not);`,
    `                   --cloud-check PROVES the cloud key with one 8-token`,
    `                   generate + a model-catalog read. Explicit egress: it runs`,
    `                   only when you type the flag, discloses before it sends,`,
    `                   and logs a cloud_egress receipt. Without it, auth can`,
    `                   only ever read 'unverified' — /api/tags returns 200 for`,
    `                   an invalid key. Also flags configured cloud model ids`,
    `                   that are no longer in the backend's catalog.`,
    `  init             Scaffold hermes.config.yaml in the current directory.`,
    `                   --claude prints a paste-ready Claude Code .mcp.json fragment`,
    `                   (nothing written) with the optional cloud lines + standby note.`,
    `  --version, -V    Print package version and exit.`,
    `  --help, -h       Print this help and exit.`,
    ``,
    `ENVIRONMENT`,
    `  INTERN_PROFILE         dev-rtx5080 | dev-rtx5080-qwen3 | m5-max (default: dev-rtx5080)`,
    `  INTERN_TIER_INSTANT    Override the instant-tier model (e.g. hermes3:8b).`,
    `  INTERN_TIER_WORKHORSE  Override the workhorse-tier model.`,
    `  INTERN_TIER_DEEP       Override the deep-tier model.`,
    `  INTERN_EMBED_MODEL     Override the embed-tier model (e.g. nomic-embed-text).`,
    `  OLLAMA_HOST            Ollama base URL (default: http://127.0.0.1:11434).`,
    `  INTERN_LOG_PATH        Override NDJSON log path (default: ~/.ollama-intern/log.ndjson).`,
    // INTERN_PREWARM and INTERN_MAX_CONCURRENT are both fail-fast
    // CONFIG_INVALID vars: an operator could previously only discover them
    // by already knowing the name, or by crashing the server with a typo
    // of one. A knob that refuses to start has to be documented where the
    // product itself can show it.
    `  INTERN_PREWARM         off|0|false|no|none disables the startup prewarm`,
    `                         (on|1|true|yes or unset = the profile's default).`,
    `  INTERN_MAX_CONCURRENT  Max concurrent Ollama calls, positive integer (default: 2).`,
    ``,
    `  Ollama Cloud (optional — no key = zero egress; key alone = STANDBY, per-call`,
    `  backend:'cloud' escalation only; key + PRIMARY = cloud-primary routing):`,
    `  OLLAMA_CLOUD_PRIMARY   Enable cloud-primary routing (1/true/yes/on).`,
    `  OLLAMA_API_KEY         Bearer key for Ollama Cloud (alone it arms standby;`,
    `                         required when OLLAMA_CLOUD_PRIMARY is set).`,
    `  OLLAMA_CLOUD_HOST      Cloud base URL (default: https://ollama.com).`,
    `  INTERN_CLOUD_MODEL     Cloud model for instant+workhorse+deep (default: qwen3-coder-next:cloud).`,
    `  INTERN_CLOUD_DEEP_MODEL  Deep-tier-only cloud override (e.g. deepseek-v3.1:671b).`,
    `  INTERN_CLOUD_TIMEOUT_INSTANT_MS    Cloud instant-tier budget (default: 30000).`,
    `  INTERN_CLOUD_TIMEOUT_WORKHORSE_MS  Cloud workhorse-tier budget (default: 120000).`,
    `  INTERN_CLOUD_TIMEOUT_DEEP_MS       Cloud deep-tier budget (default: 300000).`,
    `  INTERN_CLOUD_NUM_CTX   Cloud context window (default: 32768).`,
    `  INTERN_CLOUD_STANDBY_TIERS  STANDBY escalation policy — comma list of`,
    `                         instant|workhorse|deep whose calls go to cloud`,
    `                         WITHOUT a per-call backend:'cloud' flag (e.g.`,
    `                         'deep' = escalate deep work, keep everything else`,
    `                         local). Default empty/none = zero egress on a key`,
    `                         alone. A per-call backend:'local' still pins one`,
    `                         call local; escalation is never inferred from`,
    `                         prompt size, model quality, or a local failure.`,
    ``,
    `  Partial list — see the README (Hardware profiles / Cloud env vars) for the rest.`,
    ``,
    `DOCS`,
    `  https://github.com/mcp-tool-shop-org/ollama-intern-mcp#readme`,
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

/**
 * Run `ollama_doctor` outside the MCP transport and print the result
 * to stdout. Reuses `handleDoctor` so the CLI output stays in lockstep
 * with the MCP tool — no parallel implementation to keep aligned.
 *
 * Flags (F5, v2.9 — the CI persona):
 *   --json            emit the structured DoctorResult as JSON, plus the
 *                     envelope's `warnings[]` and (when the cloud config
 *                     itself failed to load) `cloud_config_error` (stdout
 *                     is ONLY the JSON — pipeable to jq; the old comment
 *                     suggested `doctor | jq .` against the prose report,
 *                     which never worked).
 *   --fail-unhealthy  exit 1 when `healthy` is false OR the cloud config
 *                     itself failed to load (e.g. PRIMARY without a key) OR
 *                     an explicit --cloud-check returned a definitive
 *                     operator-config verdict — the machine gate the old
 *                     "grep the report" advice pretended existed.
 *   --cloud-check     (F-34227a72) EXPLICIT EGRESS. Reads the cloud model
 *                     catalog and sends ONE 8-token generate with a fixed
 *                     non-sensitive prompt, to answer the question the
 *                     ordinary probe structurally cannot: does this key
 *                     work? (/api/tags returns 200 for an invalid key, so
 *                     `auth` could only ever read 'unverified'.) Discloses
 *                     on stderr before the first byte and writes a
 *                     cloud_egress receipt. Never implied — no flag, no
 *                     egress, exactly as with no key at all.
 *
 * Default (no flags): the human prose report, exit 0 regardless of health —
 * doctor's job is to REPORT; gating is the explicit flag's job. Returns the
 * exit code; the runCli dispatcher owns process.exit.
 *
 * Both modes render the envelope's `warnings[]`, not just `envelope.result`.
 * handleDoctor composes the actual remediation sentences there ("Start it
 * with 'ollama serve' or set OLLAMA_HOST", "check OLLAMA_API_KEY …"), and
 * this CLI used to drop every one of them: the prose showed the raw facts
 * (`reachable: no`) with no fix instruction, and the --json branch
 * serialized `result` rather than the envelope, so a CI consumer got none
 * either. The MCP client was being told strictly more than the operator
 * standing at the terminal that `init` points at.
 */
async function runCliDoctor(flags: string[] = []): Promise<number> {
  const unknown = flags.filter(
    (f) => f !== "--json" && f !== "--fail-unhealthy" && f !== "--cloud-check",
  );
  if (unknown.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: unknown doctor flag(s): ${unknown.join(", ")}. Supported: --json, --fail-unhealthy, --cloud-check.`,
    );
    return 1;
  }
  const asJson = flags.includes("--json");
  const failUnhealthy = flags.includes("--fail-unhealthy");
  const cloudCheck = flags.includes("--cloud-check");
  // Resolve profile fail-fast so doctor surfaces a CONFIG_INVALID before
  // it has a chance to hit the Ollama probe.
  let profile: ReturnType<typeof loadProfile>;
  try {
    profile = loadProfile();
  } catch (err) {
    if (err instanceof InternError) {
      // eslint-disable-next-line no-console
      console.error(`ollama-intern: ${err.message}\n  hint: ${err.hint}`);
      return 1;
    }
    throw err;
  }
  // Cloud config for the doctor report. A CONFIG_INVALID (e.g. PRIMARY set
  // without a key) is REPORTED, not fatal — doctor's job is to surface broken
  // config, so we print the hint and continue with cloud disabled. The
  // brokenness is REMEMBERED so --fail-unhealthy gates on it, and it is also
  // CARRIED into both renderings: a box with OLLAMA_CLOUD_PRIMARY set and no
  // key produces no `cloud` block at all, which was byte-identical to a box
  // with cloud deliberately not configured. Without the field below, the only
  // trace was a stderr line the machine payload never saw.
  let cloud: CloudConfig | null = null;
  let cloudConfigError: string | null = null;
  try {
    cloud = loadCloudConfig();
  } catch (err) {
    if (err instanceof InternError) {
      // eslint-disable-next-line no-console
      console.error(`ollama-intern: cloud config error — ${err.message}\n  hint: ${err.hint}`);
      cloudConfigError = `${err.message} — ${err.hint}`;
    } else {
      throw err;
    }
  }
  const cloudConfigBroken = cloudConfigError !== null;
  // Doctor needs a RunContext but we don't want the NDJSON logger to
  // append a `call` event for a CLI invocation — that would pollute
  // tool-call histograms. NullLogger captures events in memory and is
  // discarded when the CLI process exits.
  const ctx: RunContext = {
    client: new HttpOllamaClient(),
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NullLogger(),
    cloud,
  };
  const env = await handleDoctor({}, ctx);
  const r = env.result;
  // F-34227a72 — the explicit cloud check. ONLY when the operator typed the
  // flag: it is real egress (one tiny generate + the catalog read), so it is
  // never implied by plain `doctor`, and never by startup. A key with no flag
  // still sends nothing. runCloudCheck discloses on stderr before the first
  // byte and writes its own cloud_egress receipt.
  //
  // The receipt goes to the REAL NdjsonLogger, not the NullLogger `ctx` uses:
  // ctx's NullLogger exists so a CLI invocation doesn't append a `call` event
  // and skew tool-call histograms, but an egress receipt is an audit record
  // of data leaving the machine and has to survive the process.
  let cloudCheckResult: CloudCheckResult | null = null;
  let cloudCheckSkipped: string | null = null;
  if (cloudCheck) {
    if (!cloud) {
      cloudCheckSkipped = cloudConfigError
        ? "cloud config failed to load (see the error above) — nothing to check."
        : "cloud is not configured (no OLLAMA_API_KEY), so there is nothing to check and nothing was sent.";
    } else {
      cloudCheckResult = await runCloudCheck({ cloud, logger: new NdjsonLogger() });
    }
  }
  // The envelope's warnings carry the remediation sentences; a broken cloud
  // config is not one of them (handleDoctor never saw the config that failed
  // to load), so it is prepended as a synthetic warning and leads the list —
  // it is operator config that must be fixed, not an outage to wait out.
  const warnings: string[] = [
    ...(cloudConfigError ? [`Cloud config error — ${cloudConfigError}`] : []),
    ...(env.warnings ?? []),
  ];
  // A MEASURED cloud verdict outranks the probe-derived `auth: unverified`
  // that handleDoctor produces, so its remediation joins the same warnings
  // list both renderings already read. Catalog misses warn too — loudly,
  // without gating (see shouldGate).
  if (cloudCheckSkipped) warnings.push(`Cloud check skipped — ${cloudCheckSkipped}`);
  if (cloudCheckResult) {
    if (cloudCheckResult.hint) {
      warnings.push(`Cloud check (${cloudCheckResult.auth}) — ${cloudCheckResult.hint}`);
    }
    if (cloudCheckResult.model_substituted) {
      warnings.push(
        `Ollama Cloud served '${cloudCheckResult.served_model}' when '${cloudCheckResult.model_requested}' was requested — the backend substituted a model. Verify INTERN_CLOUD_MODEL against https://ollama.com/search?c=cloud.`,
      );
    }
    for (const e of cloudCheckResult.catalog.entries) {
      if (e.status === "missing") {
        warnings.push(
          `Cloud model '${e.id}' (${e.source}) is NOT in the backend's catalog${e.suggestion ? ` — nearest live id: '${e.suggestion}'` : ""}. Cloud ids rotate server-side; re-pin from https://ollama.com/search?c=cloud. Calls using it degrade to the local profile (degrade_reason: cloud_model_missing).`,
        );
      }
    }
  }
  const cloudCheckGates = cloudCheckResult !== null && shouldGate(cloudCheckResult);
  if (asJson) {
    // Machine mode: stdout is ONLY the JSON (config hints also go to stderr).
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ...r,
          warnings,
          ...(cloudConfigError ? { cloud_config_error: cloudConfigError } : {}),
          // F-34227a72 — the CI-consumable cloud gate. Present only when the
          // operator asked for it, so `doctor --json` is byte-identical to
          // before without the flag.
          ...(cloudCheckResult ? { cloud_check: cloudCheckResult } : {}),
          ...(cloudCheckSkipped ? { cloud_check_skipped: cloudCheckSkipped } : {}),
        },
        null,
        2,
      ),
    );
    return failUnhealthy && (!r.healthy || cloudConfigBroken || cloudCheckGates) ? 1 : 0;
  }
  // Compact, human-readable rendering for stdout (unchanged default path).
  // Machine consumers use --json above — the prose was never jq-able.
  const out: string[] = [];
  out.push(`ollama-intern-mcp v${VERSION} — doctor`);
  out.push(``);
  out.push(`Profile:  ${r.profile.name}`);
  out.push(`Tiers:`);
  out.push(`  instant:   ${r.profile.tiers.instant}`);
  out.push(`  workhorse: ${r.profile.tiers.workhorse}`);
  out.push(`  deep:      ${r.profile.tiers.deep}`);
  out.push(`  embed:     ${r.profile.tiers.embed}`);
  out.push(``);
  out.push(`Ollama:`);
  out.push(`  host:      ${r.ollama.host}`);
  out.push(`  reachable: ${r.ollama.reachable ? "yes" : "no"}`);
  if (r.ollama.error) out.push(`  error:     ${r.ollama.error}`);
  out.push(``);
  if (r.cloud) {
    out.push(`Cloud (${r.cloud.mode}):`);
    out.push(`  host:      ${r.cloud.host}`);
    out.push(`  reachable: ${r.cloud.reachable ? "yes" : "no"}`);
    out.push(
      `  auth:      ${r.cloud.auth === "failed" ? "FAILED (bad key)" : "unverified (checked on first call)"}`,
    );
    // 'unverified' is a limit of the PROBE, not a symptom: /api/tags returns
    // 200 for an invalid key, so this line can never say 'ok' no matter how
    // good the key is. Sitting directly under the verdict it qualifies,
    // point at the command that CAN answer — otherwise the operator's read
    // of "unverified" is a dead end. Suppressed when a 401/403 already gave
    // a definitive answer, and when --cloud-check is about to print one.
    if (r.cloud.auth !== "failed" && !cloudCheck) {
      out.push(
        `             ('unverified' is the probe's ceiling — /api/tags returns 200 even for a bad key. Run 'doctor --cloud-check' to prove it with one tiny generate: explicit egress, disclosed before it sends.)`,
      );
    }
    out.push(
      `  models:    instant=${r.cloud.models.instant}  workhorse=${r.cloud.models.workhorse}  deep=${r.cloud.models.deep}`,
    );
    if (r.cloud.circuit_state) out.push(`  circuit:   ${r.cloud.circuit_state}`);
    // An honest absence beats a silently missing line. The breaker is
    // per-process state inside the MCP SERVER; this CLI builds its own plain
    // HttpOllamaClient (never a RoutingOllamaClient), so `circuit_state` is
    // structurally unreachable here — and even if it were rendered, it would
    // describe this short-lived CLI process, not the server your MCP client
    // is actually talking to. Say so, and point at the one surface that does
    // carry the server's degradation history.
    else {
      out.push(
        `  circuit:   not observable from the CLI — the breaker is in-process state inside the running MCP server.`,
      );
      out.push(
        `             For that server's degradation history: ollama_log_tail --filter_kind backend_fallback`,
      );
    }
    if (r.cloud.error) out.push(`  error:     ${r.cloud.error}`);
    out.push(``);
  }
  if (cloudCheckSkipped) {
    out.push(`Cloud check: skipped — ${cloudCheckSkipped}`);
    out.push(``);
  }
  if (cloudCheckResult) {
    out.push(...formatCloudCheck(cloudCheckResult));
    out.push(``);
  }
  out.push(`Models:`);
  out.push(`  required:  ${r.models.required.join(", ") || "(none)"}`);
  out.push(`  pulled:    ${r.models.pulled.length} present`);
  out.push(`  loaded:    ${r.models.loaded.length} resident`);
  out.push(`  missing:   ${r.models.missing.join(", ") || "(none)"}`);
  if (r.models.suggested_pulls.length > 0) {
    out.push(`  fix:       ${r.models.suggested_pulls.join(" && ")}`);
  }
  out.push(``);
  out.push(`Paths:`);
  out.push(`  log:       ${r.paths.log_path}`);
  // log_bytes / log_over_stats_cap exist on DoctorResult but never reached
  // this report, so the operator running plain `doctor` got no warning that
  // log_stats was about to refuse to read the log it just pointed them at.
  if (r.paths.log_bytes !== undefined) {
    out.push(`  log size:  ${formatBytes(r.paths.log_bytes)}`);
    if (r.paths.log_over_stats_cap) {
      out.push(
        `             over the ${formatBytes(LOG_STATS_MAX_BYTES)} log_stats cap — log_stats will refuse; rotate or truncate the log.`,
      );
    }
  }
  out.push(`  artifacts: ${r.paths.artifact_root}`);
  if (r.paths.allowed_roots.length > 0) {
    out.push(`  allowed:   ${r.paths.allowed_roots.join(", ")}`);
  }
  out.push(``);
  if (r.recent_errors.length > 0) {
    out.push(`Recent errors (last ${r.recent_errors.length}):`);
    for (const e of r.recent_errors) {
      out.push(`  ${e.ts}  ${e.code}  ${e.tool}`);
    }
    out.push(``);
  }
  // Immediately before Healthy: the facts above say WHAT is wrong, these say
  // what to do about it. Rendered last so the fix is the final thing on
  // screen next to the verdict it explains.
  if (warnings.length > 0) {
    out.push(`Warnings:`);
    for (const w of warnings) out.push(`  - ${w}`);
    out.push(``);
  }
  out.push(`Healthy: ${r.healthy ? "yes" : "no"}`);
  // eslint-disable-next-line no-console
  console.log(out.join("\n"));
  return failUnhealthy && (!r.healthy || cloudConfigBroken || cloudCheckGates) ? 1 : 0;
}

/**
 * `init` subcommand — scaffold a starter `hermes.config.yaml` in the
 * caller's CWD by copying `hermes.config.example.yaml` from the package
 * install location. Refuses to overwrite an existing file so re-running
 * `init` after manual edits is safe.
 *
 * Locating the example: the bin file ships under `dist/index.js` and the
 * example lives at the package root, so `<bin-dir>/../hermes.config.example.yaml`
 * resolves correctly for both local `npm link` and global install layouts.
 *
 * `--claude` (F3, v2.9): print a paste-ready Claude Code `.mcp.json`
 * fragment instead — PRINTED, never written (pasting into an existing
 * .mcp.json beats clobbering one), with the optional cloud env lines as
 * commented guidance (JSON carries no comments) + the standby semantics.
 * Returns the exit code; the runCli dispatcher owns process.exit.
 */
async function runCliInit(flags: string[] = []): Promise<number> {
  const unknown = flags.filter((f) => f !== "--claude");
  if (unknown.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: unknown init flag(s): ${unknown.join(", ")}. Supported: --claude.`,
    );
    return 1;
  }
  if (flags.includes("--claude")) {
    const fragment = {
      mcpServers: {
        "ollama-intern": {
          command: "npx",
          args: ["-y", "ollama-intern-mcp"],
          env: { INTERN_PROFILE: "dev-rtx5080" },
        },
      },
    };
    // eslint-disable-next-line no-console
    console.log("Paste into your project's .mcp.json — or merge the server entry into an existing mcpServers block:");
    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(fragment, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      [
        ``,
        `Optional Ollama Cloud — add either/both lines to the env block above:`,
        `  "OLLAMA_API_KEY": "sk-...your-key..."   <- key alone arms STANDBY: everything stays local`,
        `                                             with zero egress until a call requests backend:'cloud'`,
        `                                             (first escalation is disclosed loudly on stderr).`,
        `  "OLLAMA_CLOUD_PRIMARY": "1"             <- add this too and the generative tiers route to cloud`,
        `                                             (default qwen3-coder-next:cloud) with local fallback.`,
        ``,
        `Next steps:`,
        `  1. Restart your MCP client so it picks up the new server.`,
        `  2. Run \`ollama-intern-mcp doctor\` to verify the Ollama setup.`,
        `  3. Profiles: dev-rtx5080 (default) | dev-rtx5080-qwen3 | m5-max.`,
      ].join("\n"),
    );
    return 0;
  }
  const target = resolvePath(process.cwd(), "hermes.config.yaml");
  if (existsSync(target)) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: ${target} already exists — refusing to overwrite. Move or delete it first if you want a fresh scaffold.`,
    );
    return 1;
  }
  // dist/index.js lives at <pkg>/dist/index.js → join("..", "..") from the
  // bin's directory yields the package root. The example file lives at
  // the package root per the npm tarball layout.
  const binDir = dirname(fileURLToPath(import.meta.url));
  const example = join(binDir, "..", "hermes.config.example.yaml");
  if (!existsSync(example)) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: example config not found at ${example}. This is a packaging bug — please report at https://github.com/mcp-tool-shop-org/ollama-intern-mcp/issues.`,
    );
    return 1;
  }
  try {
    await copyFile(example, target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`ollama-intern: failed to write ${target}: ${msg}`);
    return 1;
  }
  // eslint-disable-next-line no-console
  console.log(
    [
      `Wrote ${target}.`,
      ``,
      `Next steps:`,
      `  1. Review and edit the file for your install path / model preferences.`,
      `  2. Point your Hermes agent at it (see Hermes docs).`,
      `  3. Run \`ollama-intern-mcp doctor\` to verify the Ollama setup.`,
    ].join("\n"),
  );
  return 0;
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
  // FT-003 — CLI verbs intercept BEFORE the MCP stdio handshake. When
  // runCli returns true it has already process.exited; when it returns
  // false the user passed no args and we fall through to the MCP
  // server path that's existed since v1.0.0.
  runCli(process.argv)
    .then((handled) => {
      if (handled) return; // runCli already exited
      return main();
    })
    .catch((err) => {
      console.error(JSON.stringify(toErrorShape(err), null, 2));
      process.exit(1);
    });
}

// Test seam — export the CLI helpers so tests can verify dispatcher
// behavior without spawning child processes. Production code paths
// (the script entry above) continue to call them directly.
export const __cliInternals = {
  runCli,
  printHelp,
  runCliDoctor,
  runCliInit,
};
