#!/usr/bin/env node

/**
 * Ollama Intern MCP — entrypoint.
 *
 * Registers the labor surface: atoms (classify, triage, summarize, draft,
 * extract, embed, chat), flagships (research, corpus_*, *_brief), packs
 * (incident/repo/change), artifact tools, and the skill layer
 * (skill_list / skill_match / skill_run) that composes all of the above.
 * Tool descriptions encode *when* to reach for them — Claude picks the tier
 * by picking the tool, and the tool implies the model. ollama_chat is
 * visibly last-resort.
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
import { skillListSchema, handleSkillList } from "./tools/skillList.js";
import { skillMatchSchema, handleSkillMatch } from "./tools/skillMatch.js";
import { skillRunSchema, handleSkillRun } from "./tools/skillRun.js";
import { skillProposeSchema, handleSkillPropose } from "./tools/skillPropose.js";
import { skillPromoteSchema, handleSkillPromote } from "./tools/skillPromote.js";
import { memoryRefreshSchema, handleMemoryRefresh } from "./tools/memoryRefresh.js";
import { memorySearchSchema, handleMemorySearch } from "./tools/memorySearch.js";
import { memoryReadSchema, handleMemoryRead } from "./tools/memoryRead.js";
import { memoryExplainSchema, handleMemoryExplain } from "./tools/memoryExplain.js";
import { memoryNeighborsSchema, handleMemoryNeighbors } from "./tools/memoryNeighbors.js";
import { shadowRun } from "./routing/runtime.js";
import { routingAuditSchema, handleRoutingAudit } from "./tools/routingAudit.js";
import { routingCalibrateSchema, handleRoutingCalibrate } from "./tools/routingCalibrate.js";

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

  /**
   * Shadow-wrap an atom/pack/flagship invocation. Non-shadowed tools
   * (skill-layer, memory-layer, artifact & corpus-management, embed
   * primitive) pass through via `shadowRun`'s internal allowlist check —
   * so using `shadow(...)` on every registration is safe and correct.
   *
   * Shadow runtime:
   *   - builds a RoutingContext from the live input BEFORE execution
   *   - runs route() on that context
   *   - invokes the real handler, unchanged
   *   - writes a routing receipt linking suggested → actual → outcome
   */
  const shadow = <T>(tool: string, input: unknown, handler: () => Promise<T>): Promise<T> =>
    shadowRun(tool, input, ctx, handler as () => Promise<import("./envelope.js").Envelope<unknown>>) as Promise<T>;

  // FLAGSHIP — ollama_research
  server.tool(
    "ollama_research",
    "FLAGSHIP. Answer a question grounded in specific files. Takes FILE PATHS (not raw text) — reads and chunks locally, returns a digest with validated citations. Use this to understand a repo/doc without burning Claude context on the full content. Citations outside source_paths are stripped server-side.",
    researchSchema.shape,
    (args) => wrap(shadow("ollama_research", args, () => handleResearch(args, ctx))),
  );

  // FLAGSHIP — ollama_corpus_search (persistent concept search over named corpora)
  server.tool(
    "ollama_corpus_search",
    "FLAGSHIP. Concept search over a persistent named corpus (e.g. 'memory', 'canon', 'handbook'). Pass `corpus` + `query`; returns ranked `[{id, path, score, chunk_index, preview?}]` drawn from the indexed corpus. Use this as your default for semantic recall — the corpus is persistent across sessions so you don't re-embed every call. Build or refresh a corpus with ollama_corpus_index first; see what's available with ollama_corpus_list.",
    corpusSearchSchema.shape,
    (args) => wrap(shadow("ollama_corpus_search", args, () => handleCorpusSearch(args, ctx))),
  );

  // FLAGSHIP — ollama_corpus_answer (grounded synthesis over a named corpus)
  server.tool(
    "ollama_corpus_answer",
    "FLAGSHIP. Answer a question from a NAMED CORPUS with chunk-grounded citations. Retrieves via corpus_search, synthesizes with the Deep tier from the retrieved chunks ONLY, and returns `{answer, citations:[{path, chunk_index, heading_path, title}], covered_sources, omitted_sources, coverage_notes, retrieval:{retrieved, top_score, weak}}`. Distinct from ollama_research: research takes source paths you explicitly hand in; corpus_answer pulls from an already-indexed corpus. Weak retrieval degrades honestly — 0 hits short-circuits without invoking the model; thin retrieval flags `weak: true`.",
    corpusAnswerSchema.shape,
    (args) => wrap(shadow("ollama_corpus_answer", args, () => handleCorpusAnswer(args, ctx))),
  );

  // FLAGSHIP — ollama_incident_brief (structured operator brief)
  server.tool(
    "ollama_incident_brief",
    "FLAGSHIP compound job. Produces a STRUCTURED OPERATOR BRIEF from log_text and/or source_paths, optionally blended with a named corpus for background context. Returns `{root_cause_hypotheses, affected_surfaces, timeline_clues, next_checks, evidence, weak, coverage_notes, corpus_used}`. Every hypothesis/surface/clue carries evidence_refs into the evidence array — refs to unknown ids are stripped server-side. Distinct from ollama_triage_logs (symptoms in one blob) and ollama_research (answer a specific question). Thin evidence degrades to weak=true with coverage_notes — never a smooth fake narrative. next_checks are INVESTIGATIVE, not remediations.",
    incidentBriefSchema.shape,
    (args) => wrap(shadow("ollama_incident_brief", args, () => handleIncidentBrief(args, ctx))),
  );

  // FLAGSHIP — ollama_repo_brief (operator map of a repo)
  server.tool(
    "ollama_repo_brief",
    "FLAGSHIP compound job. Produces an OPERATOR MAP of a repo: `{repo_thesis, key_surfaces, architecture_shape, risk_areas, read_next, evidence, weak, coverage_notes, corpus_used}`. Takes source_paths (typically README + key src entries + manifests + docs) and optionally a corpus for cross-cutting context. Not a research clone — research answers a specific question; repo_brief synthesizes orientation. Every key_surface and risk_area cites evidence. read_next is INVESTIGATIVE (files or sections to look at), never prescriptive fixes or refactors. Thin evidence → weak=true with coverage notes.",
    repoBriefSchema.shape,
    (args) => wrap(shadow("ollama_repo_brief", args, () => handleRepoBrief(args, ctx))),
  );

  // FLAGSHIP — ollama_change_brief (structured impact brief for a change)
  server.tool(
    "ollama_change_brief",
    "FLAGSHIP compound job. Produces a CHANGE IMPACT BRIEF: `{change_summary, affected_surfaces, why_it_matters, likely_breakpoints, validation_checks, release_note_draft, evidence, weak, coverage_notes, corpus_used}`. Accepts diff_text (split per file on `diff --git` markers) and/or source_paths (changed files), with an optional corpus for architecture context. Not a git chat bot — structured and reviewable. likely_breakpoints are INVESTIGATIVE reasoning about what could break; validation_checks are what to verify after the change. Never remedial (no 'apply this fix'). release_note_draft is a draft the operator reviews.",
    changeBriefSchema.shape,
    (args) => wrap(shadow("ollama_change_brief", args, () => handleChangeBrief(args, ctx))),
  );

  // PACK — ollama_incident_pack (deterministic orchestration, durable artifact)
  server.tool(
    "ollama_incident_pack",
    "PACK. Runs the full incident job end-to-end: triage_logs → corpus_search → incident_brief → deterministic markdown+JSON artifact on disk. Single call, single completed job, single pair of files the operator can keep and diff. Response is compact ({artifact:{markdown_path,json_path}, summary, steps}) — the full brief lives in the artifact, not the MCP payload. Fixed pipeline, fixed markdown layout, no prose drift. Use this instead of calling triage_logs + incident_brief manually when you want one deliverable.",
    incidentPackSchema.shape,
    (args) => wrap(shadow("ollama_incident_pack", args, () => handleIncidentPack(args, ctx))),
  );

  // PACK — ollama_repo_pack (onboarding job, corpus-first, durable artifact)
  server.tool(
    "ollama_repo_pack",
    "PACK. Runs the full repo ONBOARDING job: corpus_search (if corpus given) → repo_brief → targeted ollama_extract (narrow onboarding schema: packages, entrypoints, scripts, config_files, exposed_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Corpus-first posture: when a corpus is given, it's the main working surface alongside source_paths. Not repo Q&A — this is `get me onboarded fast with a stable operator artifact`. Response is compact; full brief + extracted facts live in the artifact.",
    repoPackSchema.shape,
    (args) => wrap(shadow("ollama_repo_pack", args, () => handleRepoPack(args, ctx))),
  );

  // PACK — ollama_change_pack (change-centered review job, durable artifact)
  server.tool(
    "ollama_change_pack",
    "PACK. Runs the full change REVIEW job: assemble evidence (diff + paths + corpus if given) → triage_logs ONLY when log_text is provided → change_brief → targeted ollama_extract (narrow review schema: scripts_touched, config_surfaces, runtime_hints) → deterministic markdown+JSON artifact on disk. Change-first, not repo-first — this is about the DELTA, not a tour. Release note draft is a blockquote-wrapped DRAFT (not marketing copy). No VCS integration — caller hands in diff_text / source_paths / optional log_text. Response is compact; full brief + extracted facts live in the artifact.",
    changePackSchema.shape,
    (args) => wrap(shadow("ollama_change_pack", args, () => handleChangePack(args, ctx))),
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

  // ARTIFACT — ollama_artifact_export_to_path (handoff move, narrow writer)
  server.tool(
    "ollama_artifact_export_to_path",
    "ARTIFACT. Writes the artifact's EXISTING markdown to a caller-specified path with a provenance header prepended. No re-render, no model call. Path safety is strict: target_path must be absolute, must end in .md, must live under one of `allowed_roots` (REQUIRED — caller declares intent). Overwrite is opt-in: existing files refuse by default so re-runs never clobber hand-edits. Not a generic file writer — export is the single handoff move.",
    artifactExportToPathSchema.shape,
    (args) => wrap(handleArtifactExportToPath(args, ctx)),
  );

  // ARTIFACT — ollama_artifact_incident_note_snippet (operator note fragment)
  server.tool(
    "ollama_artifact_incident_note_snippet",
    "ARTIFACT. Renders a compact incident-note markdown fragment from an incident_pack artifact — top hypotheses, affected surfaces, next checks, with an evidence-aware operator tone. No model call, no re-render; pure derivation from stored JSON. Returns `{rendered, metadata}`. For the full artifact use artifact_read; for the whole markdown as a reviewable file use artifact_export_to_path.",
    artifactIncidentNoteSnippetSchema.shape,
    (args) => wrap(handleArtifactIncidentNoteSnippet(args, ctx)),
  );

  // ARTIFACT — ollama_artifact_onboarding_section_snippet (handbook fragment)
  server.tool(
    "ollama_artifact_onboarding_section_snippet",
    "ARTIFACT. Renders a handbook-ready `## What this repo is` section from a repo_pack artifact — thesis, key surfaces, read-next, runtime hints. Investigative tone preserved (read-next is LOOK AT, not prescriptive). No model call. Returns `{rendered, metadata}`.",
    artifactOnboardingSectionSnippetSchema.shape,
    (args) => wrap(handleArtifactOnboardingSectionSnippet(args, ctx)),
  );

  // ARTIFACT — ollama_artifact_release_note_snippet (change pack DRAFT fragment)
  server.tool(
    "ollama_artifact_release_note_snippet",
    "ARTIFACT. Renders the release-note draft from a change_pack artifact as a blockquote-wrapped DRAFT fragment with the caveat preserved. No model call, no polishing, no marketing lift. Returns `{rendered, metadata}` — operator reviews before publishing.",
    artifactReleaseNoteSnippetSchema.shape,
    (args) => wrap(handleArtifactReleaseNoteSnippet(args, ctx)),
  );

  // FLAGSHIP — ollama_embed_search (ephemeral concept search on ad-hoc candidates)
  server.tool(
    "ollama_embed_search",
    "FLAGSHIP. Rank AD-HOC candidates by concept similarity to a query. Pass `query` + `candidates: [{id, text}]`; server embeds everything, computes cosine, returns ranked `[{id, score, preview?}]`. Use this when you have in-memory candidates to compare; for persistent recall over memory/canon/doctrine use ollama_corpus_search instead. Does NOT return raw vectors to you.",
    embedSearchSchema.shape,
    (args) => wrap(shadow("ollama_embed_search", args, () => handleEmbedSearch(args, ctx))),
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
    (args) => wrap(shadow("ollama_classify", args, () => handleClassify(args, ctx))),
  );

  // Core — triage_logs (batch-capable)
  server.tool(
    "ollama_triage_logs",
    "Stable-shape log digest: {errors, warnings, suspected_root_cause}. Single: pass `log_text`. BATCH: pass `items:[{id,log_text}]` for triaging many log blobs at once (multiple CI runs, matrix legs, per-service logs) — returns one envelope with per-item entries. Use before grep-storms on long CI/test output.",
    triageLogsSchema.shape,
    (args) => wrap(shadow("ollama_triage_logs", args, () => handleTriageLogs(args, ctx))),
  );

  // Core — summarize_fast
  server.tool(
    "ollama_summarize_fast",
    "Gist of short input (best under ~4k tokens). Use as a decision gate: 'is this file worth reading in full?' Summary carries source_preview so you can spot-check fabrication.",
    summarizeFastSchema.shape,
    (args) => wrap(shadow("ollama_summarize_fast", args, () => handleSummarizeFast(args, ctx))),
  );

  // Core — summarize_deep
  server.tool(
    "ollama_summarize_deep",
    "Digest of long input with optional focus. Pass EITHER `text` (when you already have the content) OR `source_paths[]` (server reads + chunks locally — use this to save Claude context). Exactly one of the two. Carries source_preview for fabrication spot-checks.",
    summarizeDeepSchema.shape,
    (args) => wrap(shadow("ollama_summarize_deep", args, () => handleSummarizeDeep(args, ctx))),
  );

  // Core — draft
  server.tool(
    "ollama_draft",
    "DRAFT code or prose stubs (never autonomous — Claude reviews). Pass language for a server-side compile check: envelope returns {compiles, checker, stderr_tail}. target_path pointing into memory/, .claude/, docs/canon/, games/ requires confirm_write: true.",
    draftSchema.shape,
    (args) => wrap(shadow("ollama_draft", args, () => handleDraft(args, ctx))),
  );

  // Core — extract (batch-capable)
  server.tool(
    "ollama_extract",
    "Schema-constrained JSON extraction using Ollama's JSON mode. Single: pass `text`, returns `{ok: true, data}` or `{ok: false, error: 'unparseable'}` — never partial. BATCH: pass `items:[{id,text}]` with a shared schema — returns one envelope with per-item `{id, ok, result|error}`. Use the batch shape for any 10+-similar-inputs workload (frontmatter, package.json, release metadata) so you hand over the whole job, not N calls.",
    extractSchema.shape,
    (args) => wrap(shadow("ollama_extract", args, () => handleExtract(args, ctx))),
  );

  // Last resort — chat
  server.tool(
    "ollama_chat",
    "LAST RESORT catch-all. Prefer a specialty tool above when one fits. If you reach for this often, a specialty tool is missing and should be added.",
    chatSchema.shape,
    (args) => wrap(shadow("ollama_chat", args, () => handleChat(args, ctx))),
  );

  // SKILL LAYER — hand-authored (and, in Phase 2, captured) pipelines over the
  // existing tool surface. Skill runs write durable receipts so the learning
  // loop has a trace to revise from.
  server.tool(
    "ollama_skill_list",
    "SKILL LAYER. List available skills from global (~/.ollama-intern/skills/) and project (<cwd>/skills/) dirs — project-scope wins on id collisions. Returns `{skills:[{id,name,description,version,status,scope,source_path,pipeline_tools,runs}], warnings, global_dir, project_dir}`. Warnings surface malformed skill files so the operator can fix them.",
    skillListSchema.shape,
    (args) => wrap(handleSkillList(args, ctx)),
  );

  server.tool(
    "ollama_skill_match",
    "SKILL LAYER. Given a free-text task description, rank candidate skills by fit — v0 uses keyword-overlap scoring with status/scope nudges. Returns `{matches:[{id,name,description,status,scope,score,reasons}], considered}`. Use before a generic atom/pack sequence to check 'do I already know how to do this?'. Draft-status skills are hidden unless include_drafts=true.",
    skillMatchSchema.shape,
    (args) => wrap(handleSkillMatch(args, ctx)),
  );

  server.tool(
    "ollama_skill_run",
    "SKILL LAYER. Execute a skill by id with caller inputs. The runner resolves ${input.name} and ${step_id.result.path} templates, validates against each tool's schema, dispatches to the registered handler, and writes a durable receipt to <cwd>/artifacts/skill-receipts/. Returns `{skill_id, skill_version, ok, result, receipt}` — receipt has per-step envelopes, resolved_inputs, timings, and errors for later revision.",
    skillRunSchema.shape,
    (args) => wrap(handleSkillRun(args, ctx)),
  );

  // SKILL LAYER — learning loop read path: scan skill receipts, surface
  // actionable lifecycle proposals (promote reliable skills, flag dominant
  // step-level failures for revision, deprecate low-success/idle skills).
  server.tool(
    "ollama_skill_propose",
    "SKILL LAYER. Reads skill-run receipts AND the NDJSON call log to surface two kinds of proposals: (1) lifecycle proposals — `{proposals:[{kind:promote|revise|deprecate, skill_id, ...}]}` from receipts; (2) new-skill proposals — `{new_skill_proposals:[{suggested_id, suggested_name, pipeline_tools, first_step_shape, evidence}]}` from recurring ad-hoc chains that have not yet been formalized. Never mutates — each proposal names the next action. Filter lifecycle by since/skill_id/kind; toggle new-skill detection via include_new_skills; override thresholds for both lanes.",
    skillProposeSchema.shape,
    (args) => wrap(handleSkillPropose(args, ctx)),
  );

  server.tool(
    "ollama_skill_promote",
    "SKILL LAYER. Move a skill between lifecycle statuses (draft/candidate/approved/deprecated) with a reason appended to provenance.promotion_history. Rewrites the skill's JSON file in place — only status and promotion_history change. Invalid transitions (e.g. deprecated→deprecated, or skipping states when not allowed) are rejected loudly.",
    skillPromoteSchema.shape,
    (args) => wrap(handleSkillPromote(args, ctx)),
  );

  // MEMORY LAYER — normalize skill receipts, pack artifacts, skills, and
  // candidate proposals into a single operational-memory index on disk.
  // Foundation for Phase 3 retrieval (Commit B) and explain (Commit C).
  server.tool(
    "ollama_memory_refresh",
    "MEMORY LAYER. Scan all four operational sources (skill_receipt, pack_artifact, approved_skill, candidate_proposal) and reconcile into ~/.ollama-intern/memory/index.json AND the sibling embeddings sidecar. Returns `{index_path, total_records, per_kind_counts, drift:{added/updated/unchanged/removed counts + ids}, sources_scanned, embeddings:{added/updated/unchanged/removed counts + ids, embed_calls, elapsed_ms}}`. Idempotent. Pass dry_run to preview without writing; skip_embeddings to reconcile structure only.",
    memoryRefreshSchema.shape,
    (args) => wrap(handleMemoryRefresh(args, ctx)),
  );

  server.tool(
    "ollama_memory_search",
    "MEMORY LAYER. Embedding-backed retrieval over memory records. Metadata pre-filter (kinds/tags/facets/since) then cosine rank against nomic-embed-text vectors with server-side `search_query:` prefix. Returns `{query, filters, considered, candidates_after_prefilter, weak, hits:[{record, score, band: strong|medium|weak, reasons[], matched_tags, matched_facets}]}`. Use `kinds:['skill_receipt']` for similar past runs, `['approved_skill']` for similar skills, `['pack_artifact']` for similar artifacts, `['candidate_proposal']` for similar captured workflows. Degrades honestly — weak top hits flag `weak: true` instead of pretending.",
    memorySearchSchema.shape,
    (args) => wrap(handleMemorySearch(args, ctx)),
  );

  server.tool(
    "ollama_memory_read",
    "MEMORY LAYER (Phase 3C). Typed, provenance-backed view of one memory record. Returns `{record, provenance_resolved:{source_kind, source_path, exists, kind-specific identity fields, read_hint}, age:{age_days, indexed_age_days, stale}, duplicates, source_excerpt?, notes}`. Default is compact + deterministic; pass include_excerpt=true to pull a TYPED STRUCTURED excerpt from the source file (step summaries for receipts, pipeline + promotion_history for skills, section_counts + headline for artifacts) — bounded, never raw envelopes. Use this instead of chaining memory_read → artifact_read when you want one-shot legibility.",
    memoryReadSchema.shape,
    (args) => wrap(handleMemoryRead(args, ctx)),
  );

  server.tool(
    "ollama_memory_explain",
    "MEMORY LAYER (Phase 3C). Legibility for a retrieval result. Deterministic by default — server tokenizes the query (NO model call) and derives `{record_summary, query_tokens, field_matches, total_matched_tokens, filter_effects, notes}`. Opt in with narrate=true to also get a ONE-sentence plain-English 'why this matched' from the Instant tier, grounded in the same deterministic facts (never speculation).",
    memoryExplainSchema.shape,
    (args) => wrap(handleMemoryExplain(args, ctx)),
  );

  server.tool(
    "ollama_memory_neighbors",
    "MEMORY LAYER (Phase 3C). Records near a given record in embedding space. Pure math over stored vectors — no query, no model call. Returns `{source_id, source_kind, filters_applied, considered, neighbors:[{id, kind, title, summary, score, band, provenance}], neighbors_by_kind:{skill_receipt[], pack_artifact[], approved_skill[], candidate_proposal[]}, notes}`. A neighbor is a neighbor — NOT a recommendation. Routing lives in Phase 3D.",
    memoryNeighborsSchema.shape,
    (args) => wrap(handleMemoryNeighbors(args, ctx)),
  );

  // ROUTING CALIBRATE (Phase 3D-D) — propose/replay/approve flow.
  server.tool(
    "ollama_routing_calibrate",
    "ROUTING CALIBRATE (Phase 3D-D). Action-typed: `propose` (generate proposals from current audit findings, optional persist=true), `list` (show stored proposals, optional status_filter), `replay` (dry-run one proposal over stored receipts — shows before/after ranked deltas without applying), `approve` / `reject` / `rollback` (lifecycle transitions with required reason for permanent history). Every approved calibration stamps `calibration_version` on subsequent routing receipts so audits can attribute decisions. Shadow-only — approved calibrations shape suggestions, never take control. Laws: no invisible tuning, no auto-apply, every change is inspectable/attributable/replayable/reversible.",
    routingCalibrateSchema.shape,
    (args) => wrap(handleRoutingCalibrate(args, ctx)),
  );

  // ROUTING AUDIT (Phase 3D-C) — read-only surface over shadow receipts.
  server.tool(
    "ollama_routing_audit",
    "ROUTING AUDIT (Phase 3D-C). Read-only audit over shadow routing receipts joined to skills + memory + candidate proposals. Returns `{summary:{match_breakdown, by_actual_route, top_abstain_shapes, runtime_breakdown, route_family_distribution, time_window}, findings:[{kind, severity, title, detail, evidence:{receipt_paths, artifact_refs?, skill_refs?, proposal_refs?, shape_sig?, success_rate?}, recommended_next_action}]}`. Finding kinds: promotion_gap, override_hotspot, abstain_cluster, missed_abstain, unused_candidate, overconfident_route. Abstains split into legit_abstain (one-off primitives) vs missed_abstain (recurring shape with consistent actual route — router should learn a route). No mutations, no calibration — this tool surfaces truth; Phase 3D-D acts on it.",
    routingAuditSchema.shape,
    (args) => wrap(handleRoutingAudit(args, ctx)),
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
