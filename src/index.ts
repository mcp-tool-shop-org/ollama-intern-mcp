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
import { NdjsonLogger, timestamp } from "./observability.js";
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
import { codeMapSchema, handleCodeMap } from "./tools/codeMap.js";
// ── Feature-pass tools (agent: Tools-new) — refactor/proof/citation/drill ──
import { multiFileRefactorProposeSchema, handleMultiFileRefactorPropose } from "./tools/multiFileRefactorPropose.js";
import { batchProofCheckSchema, handleBatchProofCheck } from "./tools/batchProofCheck.js";
import { refactorPlanSchema, handleRefactorPlan } from "./tools/refactorPlan.js";
import { codeCitationSchema, handleCodeCitation } from "./tools/codeCitation.js";
import { codeReviewSchema, handleCodeReview } from "./tools/codeReview.js";
import { hypothesisDrillSchema, handleHypothesisDrill } from "./tools/hypothesisDrill.js";

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
    (args, extra) => wrap(() => handleResearch(args, ctx), "ollama_research", extra),
  );

  // FLAGSHIP — ollama_corpus_search (persistent concept search over named corpora)
  server.tool(
    "ollama_corpus_search",
    "FLAGSHIP. Concept search over a persistent named corpus (e.g. 'memory', 'canon', 'handbook'). Pass `corpus` + `query`; returns ranked `[{id, path, score, chunk_index, preview?}]` drawn from the indexed corpus. Use this as your default for semantic recall — the corpus is persistent across sessions so you don't re-embed every call. Build or refresh a corpus with ollama_corpus_index first; see what's available with ollama_corpus_list.",
    corpusSearchSchema.shape,
    (args, extra) => wrap(() => handleCorpusSearch(args, ctx), "ollama_corpus_search", extra),
  );

  // FLAGSHIP — ollama_corpus_answer (grounded synthesis over a named corpus)
  server.tool(
    "ollama_corpus_answer",
    "FLAGSHIP. Answer a question from a NAMED CORPUS with chunk-grounded citations. Retrieves via corpus_search, synthesizes with the Deep tier from the retrieved chunks ONLY, and returns `{answer, citations:[{path, chunk_index, heading_path, title, score}], covered_sources, omitted_sources, coverage_notes, retrieval:{retrieved, top_score, weak}, abstained}`. Per-citation `score` carries the retrieval relevance through. Distinct from ollama_research: research takes source paths you explicitly hand in; corpus_answer pulls from an already-indexed corpus. Weak retrieval degrades honestly — 0 hits short-circuits without invoking the model. New `min_top_score` floor: when supplied, top hits below the threshold also short-circuit with `abstained: true` instead of driving ungrounded synthesis (e.g. 5 hits @ 0.21 cosine on a 0.5 floor).",
    corpusAnswerSchema.shape,
    (args, extra) => wrap(() => handleCorpusAnswer(args, ctx), "ollama_corpus_answer", extra),
  );

  // FLAGSHIP — ollama_incident_brief (structured operator brief)
  server.tool(
    "ollama_incident_brief",
    "FLAGSHIP compound job. Produces a STRUCTURED OPERATOR BRIEF from log_text and/or source_paths, optionally blended with a named corpus for background context. Returns `{root_cause_hypotheses, affected_surfaces, timeline_clues, next_checks, evidence, weak, coverage_notes, corpus_used}`. Every hypothesis/surface/clue carries evidence_refs into the evidence array — refs to unknown ids are stripped server-side. Corpus-sourced evidence items carry retrieval `score` (and optionally `why_matched`). Optional `corpus_min_evidence_score` drops corpus chunks below the relevance floor before the model sees them, with a counted note in coverage_notes. Distinct from ollama_triage_logs (symptoms in one blob) and ollama_research (answer a specific question). Thin evidence degrades to weak=true with coverage_notes — never a smooth fake narrative. next_checks are INVESTIGATIVE, not remediations. If you pre-extracted claims via ollama_extract with a frame argument, drop off-topic items before assembling source_paths for this brief — there's no in-brief topicality gate for path/log inputs.",
    incidentBriefSchema.shape,
    (args, extra) => wrap(() => handleIncidentBrief(args, ctx), "ollama_incident_brief", extra),
  );

  // FLAGSHIP — ollama_repo_brief (operator map of a repo)
  server.tool(
    "ollama_repo_brief",
    "FLAGSHIP compound job. Produces an OPERATOR MAP of a repo: `{repo_thesis, key_surfaces, architecture_shape, risk_areas, read_next, evidence, weak, coverage_notes, corpus_used}`. Takes source_paths (typically README + key src entries + manifests + docs) and optionally a corpus for cross-cutting context. Corpus-sourced evidence items carry retrieval `score`. Optional `corpus_min_evidence_score` drops corpus chunks below the relevance floor before the model sees them. Not a research clone — research answers a specific question; repo_brief synthesizes orientation. Every key_surface and risk_area cites evidence. read_next is INVESTIGATIVE (files or sections to look at), never prescriptive fixes or refactors. Thin evidence → weak=true with coverage notes. If you pre-extracted claims via ollama_extract with a frame argument, drop off-topic items before assembling source_paths — there's no in-brief topicality gate for path inputs.",
    repoBriefSchema.shape,
    (args, extra) => wrap(() => handleRepoBrief(args, ctx), "ollama_repo_brief", extra),
  );

  // FLAGSHIP — ollama_change_brief (structured impact brief for a change)
  server.tool(
    "ollama_change_brief",
    "FLAGSHIP compound job. Produces a CHANGE IMPACT BRIEF: `{change_summary, affected_surfaces, why_it_matters, likely_breakpoints, validation_checks, release_note_draft, evidence, weak, coverage_notes, corpus_used}`. Accepts diff_text (split per file on `diff --git` markers) and/or source_paths (changed files), with an optional corpus for architecture context. Corpus-sourced evidence items carry retrieval `score`. Optional `corpus_min_evidence_score` drops corpus chunks below the relevance floor before the model sees them. Not a git chat bot — structured and reviewable. likely_breakpoints are INVESTIGATIVE reasoning about what could break; validation_checks are what to verify after the change. Never remedial (no 'apply this fix'). release_note_draft is a draft the operator reviews. If you pre-extracted claims via ollama_extract with a frame argument, drop off-topic items before assembling source_paths/diff_text — there's no in-brief topicality gate for diff/path inputs.",
    changeBriefSchema.shape,
    (args, extra) => wrap(() => handleChangeBrief(args, ctx), "ollama_change_brief", extra),
  );

  // PACK — ollama_incident_pack (deterministic orchestration, durable artifact)
  server.tool(
    "ollama_incident_pack",
    "PACK. Runs the full incident job end-to-end: triage_logs → corpus_search → incident_brief → deterministic markdown+JSON artifact on disk. Single call, single completed job, single pair of files the operator can keep and diff. Response is compact ({artifact:{markdown_path,json_path}, summary, steps}) — the full brief lives in the artifact, not the MCP payload. Fixed pipeline, fixed markdown layout, no prose drift. Use this instead of calling triage_logs + incident_brief manually when you want one deliverable.",
    incidentPackSchema.shape,
    (args, extra) => wrap(() => handleIncidentPack(args, ctx), "ollama_incident_pack", extra),
  );

  // PACK — ollama_repo_pack (onboarding job, corpus-first, durable artifact)
  server.tool(
    "ollama_repo_pack",
    "PACK. Runs the full repo ONBOARDING job: corpus_search (if corpus given) → repo_brief → targeted ollama_extract (narrow onboarding schema: packages, entrypoints, scripts, config_files, exposed_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Corpus-first posture: when a corpus is given, it's the main working surface alongside source_paths. Not repo Q&A — this is `get me onboarded fast with a stable operator artifact`. Response is compact; full brief + extracted facts live in the artifact.",
    repoPackSchema.shape,
    (args, extra) => wrap(() => handleRepoPack(args, ctx), "ollama_repo_pack", extra),
  );

  // PACK — ollama_change_pack (change-centered review job, durable artifact)
  server.tool(
    "ollama_change_pack",
    "PACK. Runs the full change REVIEW job: assemble evidence (diff + paths + corpus if given) → triage_logs ONLY when log_text is provided → change_brief → targeted ollama_extract (narrow review schema: scripts_touched, config_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Change-first, not repo-first — this is about the DELTA, not a tour. Release note draft is a blockquote-wrapped DRAFT (not marketing copy). No VCS integration — caller hands in diff_text / source_paths / optional log_text. Response is compact; full brief + extracted facts live in the artifact.",
    changePackSchema.shape,
    (args, extra) => wrap(() => handleChangePack(args, ctx), "ollama_change_pack", extra),
  );

  // ARTIFACT — ollama_artifact_list (metadata-only index over pack artifacts)
  server.tool(
    "ollama_artifact_list",
    "ARTIFACT. Metadata-only index of pack artifacts on disk. Returns one compact record per artifact: `{pack, slug, title, created_at, weak, corpus_used, evidence_count, section_counts, md_path, json_path}`. Filter by pack / date_after / date_before / weak_only / strong_only; sort is newest first. Scans ~/.ollama-intern/artifacts/{incident,repo,change} by default; pass extra_artifact_dirs for additional read-only search surfaces. Full payloads belong to ollama_artifact_read — listing stays cheap.",
    artifactListSchema.shape,
    (args, extra) => wrap(() => handleArtifactList(args, ctx), "ollama_artifact_list", extra),
  );

  // ARTIFACT — ollama_artifact_read (typed read by identity or path)
  server.tool(
    "ollama_artifact_read",
    "ARTIFACT. Read a single pack artifact, typed by pack. Primary: `{pack, slug}` — identity-based, collisions fail loud. Secondary: `{json_path}` — absolute path, must live under a recognized artifact dir (canonical roots + extra_artifact_dirs), must end in .json, path-traversal rejected. Returns `{metadata, artifact}` where artifact is a discriminated union on `pack` (incident_pack / repo_pack / change_pack — payloads stay distinct, never flattened).",
    artifactReadSchema.shape,
    (args, extra) => wrap(() => handleArtifactRead(args, ctx), "ollama_artifact_read", extra),
  );

  // ARTIFACT — ollama_artifact_diff (structured same-pack comparison)
  server.tool(
    "ollama_artifact_diff",
    "ARTIFACT. Structured diff of two same-pack artifacts. Input: `{a: {pack, slug}, b: {pack, slug}}` — must share pack; cross-pack diffs refused loudly. Returns `{pack, a, b, weak, diff}` with weak flip surfaced at top level (strong→weak or weak→strong). Lists diff as {added, removed, unchanged} matched on primary key per item kind; narrative fields as {before, after}; release_note_draft also carries a compact LCS line_diff. Evidence is SUMMARIZED (counts + referenced_paths + path_delta), never exploded chunk-by-chunk. Deterministic ordering on every list.",
    artifactDiffSchema.shape,
    (args, extra) => wrap(() => handleArtifactDiff(args, ctx), "ollama_artifact_diff", extra),
  );

  // ARTIFACT — ollama_artifact_export_to_path (handoff move, narrow writer)
  server.tool(
    "ollama_artifact_export_to_path",
    "ARTIFACT. Writes the artifact's EXISTING markdown to a caller-specified path with a provenance header prepended. No re-render, no model call. Path safety is strict: target_path must be absolute, must end in .md, must live under one of `allowed_roots` (REQUIRED — caller declares intent). Overwrite is opt-in: existing files refuse by default so re-runs never clobber hand-edits. Not a generic file writer — export is the single handoff move.",
    artifactExportToPathSchema.shape,
    (args, extra) => wrap(() => handleArtifactExportToPath(args, ctx), "ollama_artifact_export_to_path", extra),
  );

  // ARTIFACT — ollama_artifact_incident_note_snippet (operator note fragment)
  server.tool(
    "ollama_artifact_incident_note_snippet",
    "ARTIFACT. Renders a compact incident-note markdown fragment from an incident_pack artifact — top hypotheses, affected surfaces, next checks, with an evidence-aware operator tone. No model call, no re-render; pure derivation from stored JSON. Returns `{rendered, metadata}`. For the full artifact use artifact_read; for the whole markdown as a reviewable file use artifact_export_to_path.",
    artifactIncidentNoteSnippetSchema.shape,
    (args, extra) => wrap(() => handleArtifactIncidentNoteSnippet(args, ctx), "ollama_artifact_incident_note_snippet", extra),
  );

  // ARTIFACT — ollama_artifact_onboarding_section_snippet (handbook fragment)
  server.tool(
    "ollama_artifact_onboarding_section_snippet",
    "ARTIFACT. Renders a handbook-ready `## What this repo is` section from a repo_pack artifact — thesis, key surfaces, read-next, runtime hints. Investigative tone preserved (read-next is LOOK AT, not prescriptive). No model call. Returns `{rendered, metadata}`.",
    artifactOnboardingSectionSnippetSchema.shape,
    (args, extra) => wrap(() => handleArtifactOnboardingSectionSnippet(args, ctx), "ollama_artifact_onboarding_section_snippet", extra),
  );

  // ARTIFACT — ollama_artifact_release_note_snippet (change pack DRAFT fragment)
  server.tool(
    "ollama_artifact_release_note_snippet",
    "ARTIFACT. Renders the release-note draft from a change_pack artifact as a blockquote-wrapped DRAFT fragment with the caveat preserved. No model call, no polishing, no marketing lift. Returns `{rendered, metadata}` — operator reviews before publishing.",
    artifactReleaseNoteSnippetSchema.shape,
    (args, extra) => wrap(() => handleArtifactReleaseNoteSnippet(args, ctx), "ollama_artifact_release_note_snippet", extra),
  );

  // FLAGSHIP — ollama_embed_search (ephemeral concept search on ad-hoc candidates)
  server.tool(
    "ollama_embed_search",
    "FLAGSHIP. Rank AD-HOC candidates by concept similarity to a query. Pass `query` + `candidates: [{id, text}]`; server embeds everything, computes cosine, returns ranked `[{id, score, preview?}]`. Use this when you have in-memory candidates to compare; for persistent recall over memory/canon/doctrine use ollama_corpus_search instead. Does NOT return raw vectors to you.",
    embedSearchSchema.shape,
    (args, extra) => wrap(() => handleEmbedSearch(args, ctx), "ollama_embed_search", extra),
  );

  // Corpus builder
  server.tool(
    "ollama_corpus_index",
    "Build a persistent named corpus. Pass `name` + `paths: string[]`; the server chunks, embeds, stores the corpus at ~/.ollama-intern/corpora/<name>.json AND writes a manifest at <name>.manifest.json that captures the declared paths + chunk params + embed model. Idempotent — unchanged files are reused by sha256; changed files are re-embedded; paths not in the input are dropped. For day-to-day upkeep once a manifest exists, prefer `ollama_corpus_refresh` — it reconciles corpus vs manifest and reports drift.",
    corpusIndexSchema.shape,
    (args, extra) => wrap(() => handleCorpusIndex(args, ctx), "ollama_corpus_index", extra),
  );

  // Corpus refresh — living-corpus workflow: reconcile against manifest
  server.tool(
    "ollama_corpus_refresh",
    "Reconcile a named corpus against its manifest (intent vs reality). Single arg: `name`. The manifest's declared paths, chunk params, and embed model are the source of truth — refresh doesn't accept them. Returns a drift report: added / changed / unchanged / deleted / missing (per-path lists) plus reused / reembedded / dropped (chunk-level counts) plus no_op. Idempotent: a no-change refresh is fast, boring, and makes zero embed calls.",
    corpusRefreshSchema.shape,
    (args, extra) => wrap(() => handleCorpusRefresh(args, ctx), "ollama_corpus_refresh", extra),
  );

  // Corpus list
  server.tool(
    "ollama_corpus_list",
    "List named corpora on disk with stats. No Ollama call. Use to discover what's been indexed, check freshness (indexed_at), or verify a corpus exists before searching.",
    corpusListSchema.shape,
    (args, extra) => wrap(() => handleCorpusList(args, ctx), "ollama_corpus_list", extra),
  );

  // Corpus health — dedicated superset of corpus_list with drift + staleness surfaced.
  server.tool(
    "ollama_corpus_health",
    "Health summary for indexed corpora. No Ollama call. Superset of ollama_corpus_list: staleness_days, embed_model_resolved, within-refresh :latest drift, failed_paths_count, write_complete, and per-corpus warnings[]. Optional `name` narrows to a single corpus (typos fail loud). Optional `detailed: true` adds a per-file list with mtime + stale_days. Use this as your go-to 'is anything broken?' check before search or refresh.",
    corpusHealthSchema.shape,
    (args, extra) => wrap(() => handleCorpusHealth(args, ctx), "ollama_corpus_health", extra),
  );

  // Corpus amend — single-file mutation, breaks snapshot invariant (warned).
  server.tool(
    "ollama_corpus_amend",
    "Update one file's chunks in a corpus without running a full refresh. INVARIANT CAVEAT: the corpus is normally a snapshot of disk — amend bypasses that. new_content doesn't have to match (or even exist on) disk. The manifest records has_amended_content: true so corpus_list / corpus_health surface the break; a subsequent clean index/refresh re-establishes the invariant. Takes the per-corpus lock. Re-chunks + re-embeds the new_content using the manifest's chunk params (unless explicitly overridden). Returns `{corpus, file_path, chunks_removed, chunks_added, embed_model_resolved}`.",
    corpusAmendSchema.shape,
    (args, extra) => wrap(() => handleCorpusAmend(args, ctx), "ollama_corpus_amend", extra),
  );

  // Corpus amend history — read-only companion to corpus_amend (no LLM).
  server.tool(
    "ollama_corpus_amend_history",
    "Read-only companion to ollama_corpus_amend. Lists which paths have been amended on top of the disk snapshot, when each amendment happened, and the chunk-count delta. Use this before deciding whether to re-index — a clean ollama_corpus_index or ollama_corpus_refresh re-establishes the snapshot invariant and clears the history. No LLM call; pure manifest read.",
    corpusAmendHistorySchema.shape,
    (args, extra) => wrap(() => handleCorpusAmendHistory(args, ctx), "ollama_corpus_amend_history", extra),
  );

  // Corpus rerank — post-retrieval re-sort (no LLM).
  server.tool(
    "ollama_corpus_rerank",
    "Post-retrieval re-sort of hits from a prior ollama_corpus_search. No Ollama call (no embed, no generate). Three modes: 'recency' (newer file mtime wins; stats the file), 'path_specificity' (deeper paths win), 'lexical_boost' (boosts hits whose preview/heading_path/title contains any lexical_terms — case-insensitive, word-boundary; lexical_terms REQUIRED for this mode). Preserves each hit's original score + original_rank; appends rerank_score + rank. Use after corpus_search when you need a different ordering heuristic than semantic similarity.",
    corpusRerankSchema.shape,
    (args, extra) => wrap(() => handleCorpusRerank(args, ctx), "ollama_corpus_rerank", extra),
  );

  // LOW-LEVEL — ollama_embed (raw vectors for external index builds)
  server.tool(
    "ollama_embed",
    "LOW-LEVEL primitive. Returns raw 768-dim vectors for one text or a batch. WARNING: raw vectors can overflow MCP tool-output limits on large batches — for concept search prefer `ollama_embed_search` (ephemeral candidates) or `ollama_corpus_search` (persistent corpora); both return ranked hits, not raw geometry. Use this only for building external vector indexes (sqlite-vss, pgvector) where you need the vectors themselves. Envelope emits a warnings[] entry when the serialized payload crosses ~500KB.",
    embedSchema.shape,
    (args, extra) => wrap(() => handleEmbed(args, ctx), "ollama_embed", extra),
  );

  // Core — classify (batch-capable)
  server.tool(
    "ollama_classify",
    "Single-label classification with confidence. Single: pass `text`. BATCH: pass `items:[{id,text}]` — returns ONE envelope with `result.items[]` of `{id, ok, result|error}` plus `batch_count/ok_count/error_count`. Use the batch shape to chew through bulk labeling (commit types, PR titles, log severities) in one handoff instead of N round-trips. Set allow_none=true when weak guesses are worse than 'unsure' — label returns null below threshold (default 0.7). FRAME CONTRACT (optional): pass `frame` (the question / section purpose this label set is FOR) and the model first decides whether the input is on-topic. Off-topic inputs return label=null with `off_topic: true` + `off_topic_reason` regardless of label fit — distinct from below_threshold (weak fit within the right frame). Omitting `frame` preserves the legacy result shape.",
    classifySchema.shape,
    (args, extra) => wrap(() => handleClassify(args, ctx), "ollama_classify", extra),
  );

  // Core — triage_logs (batch-capable)
  server.tool(
    "ollama_triage_logs",
    "Stable-shape log digest: {errors, warnings, suspected_root_cause}. Single: pass `log_text`. BATCH: pass `items:[{id,log_text}]` for triaging many log blobs at once (multiple CI runs, matrix legs, per-service logs) — returns one envelope with per-item entries. Use before grep-storms on long CI/test output.",
    triageLogsSchema.shape,
    (args, extra) => wrap(() => handleTriageLogs(args, ctx), "ollama_triage_logs", extra),
  );

  // Core — summarize_fast
  server.tool(
    "ollama_summarize_fast",
    "Gist of short input (best under ~4k tokens). Use as a decision gate: 'is this file worth reading in full?' Summary carries source_preview so you can spot-check fabrication. FRAME CONTRACT (optional): pass `frame` (the question / section purpose this summary is FOR) and the model first decides whether the input addresses it. Off-topic inputs return summary='(off-topic for frame: ...)' with `on_topic: false` instead of paraphrasing unrelated content. Omitting `frame` preserves the legacy result shape.",
    summarizeFastSchema.shape,
    (args, extra) => wrap(() => handleSummarizeFast(args, ctx), "ollama_summarize_fast", extra),
  );

  // Core — summarize_deep
  server.tool(
    "ollama_summarize_deep",
    "Digest of long input with optional focus. Pass EXACTLY ONE of: `text` (raw content in hand), `source_path` (single file — server reads + chunks, Claude never pre-reads), or `source_paths[]` (multiple files). The path-based shapes save Claude context — the whole point of delegating summarization. Carries source_preview for fabrication spot-checks. FRAME CONTRACT (optional): pass `frame` (the question / section purpose this digest is FOR — distinct from `focus`, which is emphasis WITHIN an in-frame source). Sources that don't address the frame are dropped from the digest and listed under `unaddressed_sources`; if NO source addresses it, summary='' and `frame_addressed: false`. Omitting `frame` preserves the legacy result shape.",
    summarizeDeepSchema.shape,
    (args, extra) => wrap(() => handleSummarizeDeep(args, ctx), "ollama_summarize_deep", extra),
  );

  // Core — draft
  server.tool(
    "ollama_draft",
    "DRAFT code or prose stubs (never autonomous — Claude reviews). Pass language for a server-side compile check: envelope returns {compiles, checker, stderr_tail}. target_path pointing into memory/, .claude/, docs/canon/, games/ requires confirm_write: true.",
    draftSchema.shape,
    (args, extra) => wrap(() => handleDraft(args, ctx), "ollama_draft", extra),
  );

  // Core — extract (batch-capable)
  server.tool(
    "ollama_extract",
    "Schema-constrained JSON extraction using Ollama's JSON mode. Single: pass `text`, returns `{ok: true, data}` or `{ok: false, error: 'unparseable'}` — never partial. BATCH: pass `items:[{id,text}]` with a shared schema — returns one envelope with per-item `{id, ok, result|error}`. Use the batch shape for any 10+-similar-inputs workload (frontmatter, package.json, release metadata) so you hand over the whole job, not N calls. FRAME CONTRACT (optional): pass `frame` (the question / section purpose this extraction is FOR). The model first judges on-topic vs off-topic; result lifts a top-level `frame_alignment: { on_topic, reason, unaddressed_aspects? }`. Off-topic sources return an empty data shape rather than paraphrasing unrelated content into the schema. Omitting `frame` preserves the legacy result shape.",
    extractSchema.shape,
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
    (args, extra) => wrap(() => handleDoctor(args, ctx), "ollama_doctor", extra),
  );

  // OPS — ollama_artifact_prune (dry-run-by-default cleanup of pack artifacts)
  server.tool(
    "ollama_artifact_prune",
    "OPS. Clean up ~/.ollama-intern/artifacts/. No model call. DRY-RUN BY DEFAULT — pass `dry_run: false` to actually delete. Filter by `older_than_days` (file mtime) and/or `pack_type` ('incident' | 'change' | 'repo' | 'all'). Deletes matched files in .md + .json pairs. Returns `{matched:[{pack, slug, age_days, bytes}], total_matched, total_bytes, dry_run, deleted, artifact_root}`. Use this when disk is creeping or the artifact dir has stale handoffs you don't need.",
    artifactPruneSchema.shape,
    (args, extra) => wrap(() => handleArtifactPrune(args, ctx), "ollama_artifact_prune", extra),
  );

  // OPS — ollama_log_tail (structured NDJSON log tail)
  server.tool(
    "ollama_log_tail",
    "OPS. Structured tail of the NDJSON observability log at ~/.ollama-intern/log.ndjson (override via INTERN_LOG_PATH). No model call. Optional filters: `limit` (default 50, max 500), `filter_kind` ('call' | 'timeout' | 'fallback' | 'guardrail' | 'pack_step' | 'semaphore:wait' | 'prewarm' | 'prewarm:in_progress_request'), `filter_tool`, `since` (ISO-8601). Truncated final lines are skipped silently. Missing log file is a soft-empty case, not an error. Returns `{events, total_returned, log_path, log_present}`. Use this to debug why a call was slow / what timed out / what the last failures were.",
    logTailSchema.shape,
    (args, extra) => wrap(() => handleLogTail(args, ctx), "ollama_log_tail", extra),
  );

  // ORIENT — ollama_code_map (fast structural repo summary, deterministic)
  server.tool(
    "ollama_code_map",
    "ORIENT. Fast structural summary of a repo — deterministic, no model call. Pass `source_paths: string[]` (files OR directories; directories are walked recursively, skipping node_modules/dist/target/.git/.venv) and optional `max_files` (default 500). Reads package.json / pyproject.toml / Cargo.toml / go.mod for framework hints; tallies files by extension; classifies entrypoints (cli/lib/web/test/config) by filename + manifest bin field; collects build_commands from package.json scripts. Returns `{languages, frameworks, entrypoints, build_commands, notable_files, total_files_scanned, max_files_hit}`. Cheap first pass before ollama_repo_pack or ollama_research. When the pass is partial (max_files_hit), the warning says so.",
    codeMapSchema.shape,
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
    (args, extra) => wrap(() => handleMultiFileRefactorPropose(args, ctx), "ollama_multi_file_refactor_propose", extra),
  );

  // OPS — ollama_batch_proof_check (no-LLM, parallel CLI proof aggregation)
  server.tool(
    "ollama_batch_proof_check",
    "OPS. Parallel typecheck/lint/test across a file list. NO MODEL CALL. Pass `checks: ['typescript' | 'eslint' | 'pytest' | 'ruff' | 'cargo-check'][]` (min 1), optional `files[]` (scope filter for lint/test tools that accept it), optional `cwd` (default process.cwd()), optional `timeout_ms` (default 60_000 per check). Each check runs in parallel under its own timeout. Missing tools (ENOENT / exit 127) report as status:'missing' — NOT a fail. Timeouts are status:'timeout'. Returns `{checks:[{check, status:'pass'|'fail'|'timeout'|'missing', exit_code, stderr_tail, stdout_tail, elapsed_ms, failures?:[{file?, line?, message}]}], all_passed, any_missing}`. Use AFTER ollama_multi_file_refactor_propose to verify the refactor landed green.",
    batchProofCheckSchema.shape,
    (args, extra) => wrap(() => handleBatchProofCheck(args, ctx), "ollama_batch_proof_check", extra),
  );

  // REFACTOR — ollama_refactor_plan (Workhorse tier — phased sequencing)
  server.tool(
    "ollama_refactor_plan",
    "REFACTOR. Phased SEQUENCING plan for a multi-file refactor — complement to multi_file_refactor_propose. Same inputs (`files`, `change_description`, optional `per_file_max_chars`) plus `priority: 'safety' | 'speed' | 'parallelism'` (default 'safety'). Server reads the files and asks the Workhorse tier for a phased plan: `{phases:[{phase, files_involved, reason, tests_to_write, parallelizable}], sequencing_notes, rollback_strategy, estimated_phases, weak}`. Phases are renumbered 1..N in arrival order. files_involved is strictly intersected with the input set. Missing rollback_strategy or empty tests with no sequencing notes → weak=true. Use this when you know WHAT to change (multi_file_refactor_propose covers that) but need HOW to land it safely.",
    refactorPlanSchema.shape,
    (args, extra) => wrap(() => handleRefactorPlan(args, ctx), "ollama_refactor_plan", extra),
  );

  // RESEARCH — ollama_code_citation (Deep tier — per-claim line-range citations)
  server.tool(
    "ollama_code_citation",
    "RESEARCH. Answer a code question with PER-CLAIM CITATIONS (file + line range). Distinct from ollama_research: research cites files, code_citation cites LINES. Pass `question` (10-1000 chars), `source_paths[]`, optional `per_file_max_chars` (default 100_000). Server numbers each line 1-based in the prompt so the Deep tier can anchor claims exactly. Returns `{answer, citations:[{claim_fragment, file, start_line, end_line, excerpt}], uncited_fragments[], weak}`. Citations to files outside source_paths are stripped (same rule as ollama_research). Citations with line ranges outside the loaded file bounds are also stripped — each stripping reason lands in warnings[]. Empty answer or answer-without-citations flips weak=true.",
    codeCitationSchema.shape,
    (args, extra) => wrap(() => handleCodeCitation(args, ctx), "ollama_code_citation", extra),
  );

  // REVIEW — ollama_code_review (Workhorse default — structured PR review findings)
  server.tool(
    "ollama_code_review",
    "REVIEW. Given a unified diff (and optional source_paths for context), returns STRUCTURED FINDINGS: `{findings:[{severity, category, file, line?, symbol?, description, recommendation}], summary, diff_size_bytes}`. Severity enum critical|high|medium|low; category enum bug|security|performance|style|maintainability. Distinct from ollama_multi_file_refactor_propose (proposes refactors) — code_review flags issues to fix on the diff as-is. Optional `severity_floor` filters out below-floor findings; `max_findings` caps result. Diff capped at 2MB; source_paths max 50. Tier defaults to workhorse; pass `tier:'deep'` for high-stakes review. coerceReview drops malformed entries instead of throwing.",
    codeReviewSchema.shape,
    (args, extra) => wrap(() => handleCodeReview(args, ctx), "ollama_code_review", extra),
  );

  // DRILL — ollama_hypothesis_drill (Deep tier — zoom into one incident hypothesis)
  server.tool(
    "ollama_hypothesis_drill",
    "DRILL. Zoom into ONE hypothesis from an existing incident_pack artifact. No re-running triage + brief. Pass `artifact_slug` (from ollama_artifact_list), `hypothesis_index` (0-based into that artifact's root_cause_hypotheses), optional `extra_artifact_dirs[]`. Server loads the artifact, extracts the targeted hypothesis + its linked evidence, and runs a Deep-tier focused sub-brief. Returns `{parent_artifact_slug, drilled_hypothesis:{statement, confidence, evidence_cited:[{id, preview}], supporting_reasoning, ruled_out_reasons?}, other_hypotheses_summary:[{index, summary}], weak}`. Invalid index → HYPOTHESIS_INDEX_INVALID with the valid range. Non-incident or missing slug → ARTIFACT_NOT_FOUND with a next-step hint.",
    hypothesisDrillSchema.shape,
    (args, extra) => wrap(() => handleHypothesisDrill(args, ctx), "ollama_hypothesis_drill", extra),
  );

  // Last resort — chat
  server.tool(
    "ollama_chat",
    "LAST RESORT catch-all. Prefer a specialty tool above when one fits. If you reach for this often, a specialty tool is missing and should be added.",
    chatSchema.shape,
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

  // Cloud is opt-in. loadCloudConfig returns null unless OLLAMA_CLOUD_PRIMARY
  // is enabled, and throws CONFIG_INVALID (fail-fast) if it's enabled without
  // a key. Catch here so the operator sees a one-liner, not a stack.
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
  // When cloud is on, every tool talks to a RoutingOllamaClient that tries
  // cloud first and falls back to the local profile. Otherwise ctx.client is
  // the plain local client — byte-identical to pre-cloud behavior.
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

  if (cloud) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern: cloud-primary ON — ${cloud.tiers.instant} (deep: ${cloud.tiers.deep}) via ${cloud.host}; local fallback profile=${profile.name}. Embeddings stay local.`,
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
    // Cloud reachability + auth probe (cloud-primary mode). Never crashes
    // startup — a down/misconfigured cloud just means calls fall back to
    // local. Surfaces the auth status immediately so a bad key is obvious.
    if (cloudClient && cloud) {
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

  // Profile-policy prewarm: pulls Instant tier into VRAM on dev profiles
  // before connecting transport, so the first real Claude call doesn't eat
  // cold-load latency. Failures are logged but never throw — server startup
  // must not depend on Ollama being reachable.
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
    await runCliDoctor();
    process.exit(0);
  }

  if (first === "init") {
    await runCliInit();
    process.exit(0);
  }

  // Unknown verb — exit 1 with the help pointer so a typo never silently
  // becomes a hung stdio handshake. Future verbs (e.g. `intern logs`)
  // land in the switch above before this fall-through fires.
  // eslint-disable-next-line no-console
  console.error(`ollama-intern-mcp: unknown command '${first}'. See --help for usage.`);
  process.exit(1);
}

function printHelp(): void {
  // Kept under 30 lines so it fits in a terminal scroll-back. The
  // exhaustive 33-tool list belongs in the README; here we describe
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
    `  init             Scaffold hermes.config.yaml in the current directory.`,
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
    ``,
    `  Ollama Cloud (optional — off by default, zero egress until both are set):`,
    `  OLLAMA_CLOUD_PRIMARY   Enable cloud-primary routing (1/true/yes/on).`,
    `  OLLAMA_API_KEY         Bearer key for Ollama Cloud (required when cloud is on).`,
    `  OLLAMA_CLOUD_HOST      Cloud base URL (default: https://ollama.com).`,
    `  INTERN_CLOUD_MODEL     Cloud model for instant+workhorse+deep (default: minimax-m3:cloud).`,
    `  INTERN_CLOUD_DEEP_MODEL  Deep-tier-only cloud override (e.g. deepseek-v3.1:671b).`,
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
 * Exit code is 0 unless the doctor itself errors; an "unhealthy" report
 * (Ollama unreachable, models not pulled) is still exit 0 because the
 * doctor's job is to REPORT, not to gate. Operators who want a gate
 * can grep the report for `healthy: true` themselves.
 */
async function runCliDoctor(): Promise<void> {
  // Resolve profile fail-fast so doctor surfaces a CONFIG_INVALID before
  // it has a chance to hit the Ollama probe.
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
  // Cloud config for the doctor report. A CONFIG_INVALID (e.g. PRIMARY set
  // without a key) is REPORTED, not fatal — doctor's job is to surface broken
  // config, so we print the hint and continue with cloud disabled.
  let cloud: CloudConfig | null = null;
  try {
    cloud = loadCloudConfig();
  } catch (err) {
    if (err instanceof InternError) {
      // eslint-disable-next-line no-console
      console.error(`ollama-intern: cloud config error — ${err.message}\n  hint: ${err.hint}`);
    } else {
      throw err;
    }
  }
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
  // Compact, human-readable rendering for stdout. JSON dump is available
  // via `ollama-intern-mcp doctor | jq .` because the underlying tool
  // result is structured — we just pretty-print the high-signal fields.
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
    out.push(`Cloud (primary):`);
    out.push(`  host:      ${r.cloud.host}`);
    out.push(`  reachable: ${r.cloud.reachable ? "yes" : "no"}`);
    out.push(
      `  auth:      ${r.cloud.auth === "failed" ? "FAILED (bad key)" : "unverified (checked on first call)"}`,
    );
    out.push(
      `  models:    instant=${r.cloud.models.instant}  workhorse=${r.cloud.models.workhorse}  deep=${r.cloud.models.deep}`,
    );
    if (r.cloud.circuit_state) out.push(`  circuit:   ${r.cloud.circuit_state}`);
    if (r.cloud.error) out.push(`  error:     ${r.cloud.error}`);
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
  out.push(`Healthy: ${r.healthy ? "yes" : "no"}`);
  // eslint-disable-next-line no-console
  console.log(out.join("\n"));
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
 */
async function runCliInit(): Promise<void> {
  const target = resolvePath(process.cwd(), "hermes.config.yaml");
  if (existsSync(target)) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern-mcp: ${target} already exists — refusing to overwrite. Move or delete it first if you want a fresh scaffold.`,
    );
    process.exit(1);
  }
  // dist/index.js lives at <pkg>/dist/index.js → join("..", "..") from the
  // bin's directory yields the package root. The example file lives at
  // the package root per the npm tarball layout.
  const binDir = dirname(fileURLToPath(import.meta.url));
  const example = join(binDir, "..", "hermes.config.example.yaml");
  if (!existsSync(example)) {
    // eslint-disable-next-line no-console
    console.error(
      `ollama-intern-mcp: example config not found at ${example}. This is a packaging bug — please report at https://github.com/mcp-tool-shop-org/ollama-intern-mcp/issues.`,
    );
    process.exit(1);
  }
  try {
    await copyFile(example, target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`ollama-intern-mcp: failed to write ${target}: ${msg}`);
    process.exit(1);
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
