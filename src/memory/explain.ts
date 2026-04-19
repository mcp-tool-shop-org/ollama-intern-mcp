/**
 * Memory explain/read/neighbors — the Phase 3C legibility surface.
 *
 * Three primitives, each deterministic and grounded in the stored record,
 * its provenance, or its already-computed stored embedding. NO fresh model
 * calls. NO source-file content dumping. The tools that wrap these are
 * typed all the way down — a skill_receipt read never looks like a
 * pack_artifact read.
 *
 * This module intentionally does NOT recommend. A neighbor is a neighbor.
 * Phase 3D shadow routing sits on top.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { cosine } from "../embedMath.js";
import type { OllamaClient } from "../ollama.js";
import type { EmbeddingsStore } from "./embeddings.js";
import { loadEmbeddings } from "./embeddings.js";
import { prefilter, type MemoryFilters } from "./retrieval.js";
import { loadIndex, type StoreOptions } from "./store.js";
import type { MemoryIndex, MemoryKind, MemoryRecord } from "./types.js";
import type { SkillReceipt } from "../skills/types.js";

// ── Shared tokenizer (deterministic; no model) ────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "at",
  "with", "from", "by", "is", "are", "was", "were", "be", "been", "it",
  "this", "that", "these", "those", "i", "you", "we", "they", "my", "our",
  "your", "me", "do", "did", "does", "can", "could", "should", "would",
  "as", "if", "so", "but", "than", "then", "over", "under", "about",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function intersect(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of a) {
    if (setB.has(t) && !seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return out;
}

// ── Typed resolved-provenance blocks — NO source body reads ──

export interface ResolvedProvenanceSkillReceipt {
  source_kind: "skill_receipt";
  source_path: string;
  exists: boolean;
  filename: string;
  receipt_ref: string; // skill_id|started_at
  /** Pointer for the operator — the read path for the underlying file is NOT memory's job. */
  read_hint: string;
}

export interface ResolvedProvenancePackArtifact {
  source_kind: "pack_artifact";
  source_path: string;
  exists: boolean;
  filename: string;
  pack: string;
  slug: string;
  md_path: string;
  md_exists: boolean;
  read_hint: string; // -> ollama_artifact_read
}

export interface ResolvedProvenanceApprovedSkill {
  source_kind: "approved_skill";
  source_path: string;
  exists: boolean;
  filename: string;
  skill_id: string;
  scope: string;
  read_hint: string; // -> ollama_skill_list / direct file read
}

export interface ResolvedProvenanceCandidateProposal {
  source_kind: "candidate_proposal";
  source_path: string; // the NDJSON log
  exists: boolean;
  filename: string;
  pipeline_ref: string; // "tool_a→tool_b→..." signature
  read_hint: string; // -> ollama_skill_propose include_new_skills=true
}

export type ResolvedProvenance =
  | ResolvedProvenanceSkillReceipt
  | ResolvedProvenancePackArtifact
  | ResolvedProvenanceApprovedSkill
  | ResolvedProvenanceCandidateProposal;

export function resolveProvenance(record: MemoryRecord): ResolvedProvenance {
  const source_path = record.provenance.source_path;
  const filename = source_path ? path.basename(source_path) : "";
  const exists = source_path ? existsSync(source_path) : false;

  switch (record.kind) {
    case "skill_receipt":
      return {
        source_kind: "skill_receipt",
        source_path,
        exists,
        filename,
        receipt_ref: record.provenance.ref,
        read_hint: `Read the receipt JSON directly at source_path (it's operator-owned, not the memory layer's job).`,
      };
    case "pack_artifact": {
      const md_path = source_path.replace(/\.json$/, ".md");
      return {
        source_kind: "pack_artifact",
        source_path,
        exists,
        filename,
        pack: String(record.facets.pack ?? ""),
        slug: String(record.facets.slug ?? ""),
        md_path,
        md_exists: md_path ? existsSync(md_path) : false,
        read_hint: `ollama_artifact_read pack=${record.facets.pack} slug=${record.facets.slug}`,
      };
    }
    case "approved_skill":
      return {
        source_kind: "approved_skill",
        source_path,
        exists,
        filename,
        skill_id: String(record.facets.skill_id ?? record.provenance.ref),
        scope: String(record.facets.scope ?? "unknown"),
        read_hint: `ollama_skill_list (filter by id) or read the JSON at source_path directly.`,
      };
    case "candidate_proposal":
      return {
        source_kind: "candidate_proposal",
        source_path,
        exists,
        filename,
        pipeline_ref: record.provenance.ref,
        read_hint: `ollama_skill_propose include_new_skills=true — proposer re-derives from the NDJSON log.`,
      };
  }
}

// ── Age ──────────────────────────────────────────────────────

export interface AgeInfo {
  age_days: number | null;
  indexed_age_days: number | null;
  stale: boolean;
}

const STALE_THRESHOLD_DAYS = 30;

function daysBetween(a: string, b: string): number | null {
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) return null;
  return Math.round((mb - ma) / (1000 * 60 * 60 * 24));
}

export function computeAge(record: MemoryRecord, now: string): AgeInfo {
  const age = daysBetween(record.created_at, now);
  const indexed = daysBetween(record.indexed_at, now);
  return {
    age_days: age,
    indexed_age_days: indexed,
    stale: age !== null && age >= STALE_THRESHOLD_DAYS,
  };
}

// ── Duplicates ───────────────────────────────────────────────

export interface DuplicateHit {
  id: string;
  kind: MemoryKind;
  source_path: string;
}

export function findDuplicates(record: MemoryRecord, index: MemoryIndex): DuplicateHit[] {
  return index.records
    .filter((r) => r.id !== record.id && r.content_digest === record.content_digest)
    .map((r) => ({ id: r.id, kind: r.kind, source_path: r.provenance.source_path }));
}

// ── Typed source excerpts (opt-in only; NEVER dump raw blobs) ─
//
// Default `memory_read` stays compact + deterministic. When the caller
// opts in via `include_excerpt`, we pull a STRUCTURED extract from the
// source file — step summaries, pipeline shapes, section counts. Not
// envelopes, not raw artifact bodies, not log blobs. Bounded and typed
// per kind so the excerpt shape a caller sees is predictable.

export interface SkillReceiptExcerpt {
  kind: "skill_receipt";
  step_count: number;
  steps: Array<{ step_id: string; tool: string; ok: boolean; elapsed_ms: number; error_code?: string; skipped?: boolean; tier_used?: string; model?: string }>;
  total_elapsed_ms: number;
}

export interface PackArtifactExcerpt {
  kind: "pack_artifact";
  pack: string;
  slug: string;
  section_counts: Record<string, number>;
  headline: string | null;
}

export interface ApprovedSkillExcerpt {
  kind: "approved_skill";
  skill_id: string;
  version: number;
  status: string;
  pipeline: Array<{ id: string; tool: string }>;
  trigger_keywords: string[];
  runs: number;
  promotion_history: Array<{ from?: string; to: string; at: string; reason: string }>;
}

export interface CandidateProposalExcerpt {
  kind: "candidate_proposal";
  pipeline_tools: string[];
  support: number;
  success_rate: number;
  shape_agreement: number;
  avg_duration_ms: number;
}

export type SourceExcerpt =
  | SkillReceiptExcerpt
  | PackArtifactExcerpt
  | ApprovedSkillExcerpt
  | CandidateProposalExcerpt
  | { kind: "unavailable"; reason: string };

async function readJson<T>(file: string): Promise<T | null> {
  if (!file || !existsSync(file)) return null;
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return null; }
}

export async function buildSourceExcerpt(record: MemoryRecord): Promise<SourceExcerpt> {
  switch (record.kind) {
    case "skill_receipt": {
      const r = await readJson<SkillReceipt>(record.provenance.source_path);
      if (!r) return { kind: "unavailable", reason: `receipt not readable: ${record.provenance.source_path}` };
      return {
        kind: "skill_receipt",
        step_count: r.steps.length,
        steps: r.steps.map((s) => {
          const env = s.envelope as { tier_used?: string; model?: string } | undefined;
          return {
            step_id: s.step_id,
            tool: s.tool,
            ok: s.ok,
            elapsed_ms: s.elapsed_ms,
            ...(s.error ? { error_code: s.error.code } : {}),
            ...(s.skipped ? { skipped: true } : {}),
            ...(env?.tier_used ? { tier_used: env.tier_used } : {}),
            ...(env?.model ? { model: env.model } : {}),
          };
        }),
        total_elapsed_ms: r.elapsed_ms,
      };
    }
    case "pack_artifact": {
      const raw = await readJson<Record<string, unknown>>(record.provenance.source_path);
      if (!raw) return { kind: "unavailable", reason: `artifact not readable: ${record.provenance.source_path}` };
      const section_counts: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) section_counts[k] = v.length;
      const headline = typeof raw.title === "string" ? raw.title : null;
      return {
        kind: "pack_artifact",
        pack: String(record.facets.pack ?? ""),
        slug: String(record.facets.slug ?? ""),
        section_counts,
        headline,
      };
    }
    case "approved_skill": {
      const skill = await readJson<{
        version: number;
        status: string;
        pipeline: Array<{ id: string; tool: string }>;
        trigger: { keywords: string[] };
        provenance: { runs: number; promotion_history: Array<{ from?: string; to: string; at: string; reason: string }> };
      }>(record.provenance.source_path);
      if (!skill) return { kind: "unavailable", reason: `skill not readable: ${record.provenance.source_path}` };
      return {
        kind: "approved_skill",
        skill_id: String(record.facets.skill_id ?? record.provenance.ref),
        version: skill.version,
        status: skill.status,
        pipeline: skill.pipeline.map((p) => ({ id: p.id, tool: p.tool })),
        trigger_keywords: skill.trigger.keywords,
        runs: skill.provenance.runs,
        promotion_history: skill.provenance.promotion_history ?? [],
      };
    }
    case "candidate_proposal":
      return {
        kind: "candidate_proposal",
        pipeline_tools: record.provenance.ref.split("→"),
        support: Number(record.facets.support ?? 0),
        success_rate: Number(record.facets.success_rate ?? 0),
        shape_agreement: Number(record.facets.shape_agreement ?? 0),
        avg_duration_ms: Number(record.facets.avg_duration_ms ?? 0),
      };
  }
}

// ── memory_read ──────────────────────────────────────────────

export interface MemoryReadResult {
  record: MemoryRecord;
  provenance_resolved: ResolvedProvenance;
  age: AgeInfo;
  duplicates: DuplicateHit[];
  /** Populated only when include_excerpt=true. Typed per kind, bounded. */
  source_excerpt: SourceExcerpt | null;
  notes: string[];
}

export interface MemoryReadOptions extends StoreOptions {
  include_excerpt?: boolean;
  preloaded?: { index: MemoryIndex };
}

export async function readMemory(id: string, opts: MemoryReadOptions = {}): Promise<MemoryReadResult> {
  const index = opts.preloaded?.index ?? (await loadIndex(opts));
  const record = index.records.find((r) => r.id === id);
  if (!record) throw new Error(`Unknown memory_id: ${id}`);

  const provenance_resolved = resolveProvenance(record);
  const age = computeAge(record, new Date().toISOString());
  const duplicates = findDuplicates(record, index);
  const notes: string[] = [];
  if (!provenance_resolved.exists) notes.push(`Source file not found on disk at ${record.provenance.source_path}.`);
  if (duplicates.length > 0) notes.push(`${duplicates.length} other record(s) share this content_digest.`);
  if (age.stale) notes.push(`Record is ${age.age_days} days old — treat as historical.`);

  let source_excerpt: SourceExcerpt | null = null;
  if (opts.include_excerpt) {
    source_excerpt = await buildSourceExcerpt(record);
    if ("kind" in source_excerpt && source_excerpt.kind === "unavailable") {
      notes.push(`Excerpt unavailable: ${source_excerpt.reason}`);
    }
  }

  return { record, provenance_resolved, age, duplicates, source_excerpt, notes };
}

// ── memory_explain ───────────────────────────────────────────
//
// Pure deterministic explanation of why (or why not) a record matches a
// query, given the current index state and optional filter predicates.
// The tool does NOT embed the query, does NOT call a model, does NOT
// compute a cosine. The caller knows the score from memory_search; this
// surface explains the WHAT in human terms.

export interface FieldMatches {
  title: string[];
  summary: string[];
  tags: string[];
  facets: string[];
}

export interface FilterEffects {
  filters_applied: MemoryFilters;
  passed_prefilter: boolean;
  /** Ordered, per-filter: kind / each required tag / each facet predicate. */
  predicate_results: Array<{ predicate: string; passed: boolean; detail?: string }>;
}

export interface MemoryExplainResult {
  record_summary: { id: string; kind: MemoryKind; title: string; summary: string };
  query: string;
  query_tokens: string[];
  field_matches: FieldMatches;
  total_matched_tokens: number;
  filter_effects: FilterEffects;
  /** Populated only when narrate=true AND a client is provided. 1–2 sentence plain-English "why this matched" on Instant tier. */
  narration?: string;
  notes: string[];
}

export interface MemoryExplainOptions extends StoreOptions {
  query: string;
  filters?: MemoryFilters;
  preloaded?: { index: MemoryIndex };
  /** Opt-in: produce a short natural-language explanation via the Instant tier. Default false (deterministic only). */
  narrate?: boolean;
  client?: OllamaClient;
  instantModel?: string;
}

function buildNarrationPrompt(result: MemoryExplainResult): string {
  const fm = result.field_matches;
  const summary = {
    query: result.query,
    record_kind: result.record_summary.kind,
    record_title: result.record_summary.title,
    matched_title_tokens: fm.title,
    matched_summary_tokens: fm.summary,
    matched_tags: fm.tags,
    matched_facets: fm.facets,
    passed_prefilter: result.filter_effects.passed_prefilter,
    predicates: result.filter_effects.predicate_results,
  };
  return [
    "You are explaining why a memory record matched a retrieval query.",
    "Produce exactly ONE plain-English sentence (≤ 30 words).",
    "Ground every claim in the facts provided — do not invent tokens, predicates, or relationships.",
    "If the record failed prefilter, lead with that.",
    "If total matched tokens is 0, say the match would be purely semantic.",
    "",
    "Facts:",
    JSON.stringify(summary, null, 2),
  ].join("\n");
}

export async function explainRecord(id: string, opts: MemoryExplainOptions): Promise<MemoryExplainResult> {
  const index = opts.preloaded?.index ?? (await loadIndex(opts));
  const record = index.records.find((r) => r.id === id);
  if (!record) throw new Error(`Unknown memory_id: ${id}`);

  const queryTokens = tokenize(opts.query);
  const titleTokens = tokenize(record.title);
  const summaryTokens = tokenize(record.summary);
  // Tag / facet matching is EXACT, not token-split — they are already
  // keyword-shaped (e.g. "skill:triage", "outcome:ok").
  const tagHits = (opts.filters?.tags ?? []).filter((t) => record.tags.includes(t));
  const facetHits: string[] = [];
  for (const [k, pred] of Object.entries(opts.filters?.facets ?? {})) {
    if (pred.equals !== undefined && record.facets[k] === pred.equals) {
      facetHits.push(`${k}==${JSON.stringify(pred.equals)}`);
    }
  }

  const field_matches: FieldMatches = {
    title: intersect(queryTokens, titleTokens),
    summary: intersect(queryTokens, summaryTokens),
    tags: record.tags.filter((t) =>
      queryTokens.some((q) => t.toLowerCase().includes(q)),
    ),
    facets: facetHits,
  };
  const total_matched_tokens =
    field_matches.title.length + field_matches.summary.length + field_matches.tags.length;

  // Filter effects — run the live prefilter to see whether this record survives.
  const filters = opts.filters ?? {};
  const { survivors } = prefilter(index.records, filters);
  const passedPrefilter = survivors.some((r) => r.id === record.id);
  const predicateResults: FilterEffects["predicate_results"] = [];
  if (filters.kinds && filters.kinds.length > 0) {
    predicateResults.push({
      predicate: `kind ∈ [${filters.kinds.join(", ")}]`,
      passed: filters.kinds.includes(record.kind),
      detail: `record.kind = ${record.kind}`,
    });
  }
  if (filters.tags && filters.tags.length > 0) {
    for (const t of filters.tags) {
      predicateResults.push({
        predicate: `tag "${t}" present`,
        passed: record.tags.includes(t),
      });
    }
  }
  if (filters.facets) {
    for (const [k, pred] of Object.entries(filters.facets)) {
      if (pred.equals !== undefined) {
        predicateResults.push({
          predicate: `facet ${k} == ${JSON.stringify(pred.equals)}`,
          passed: record.facets[k] === pred.equals,
          detail: `record.facets.${k} = ${JSON.stringify(record.facets[k] ?? null)}`,
        });
      }
    }
  }
  if (filters.since) {
    const passed = Date.parse(record.created_at) >= Date.parse(filters.since);
    predicateResults.push({
      predicate: `created_at >= ${filters.since}`,
      passed,
      detail: `record.created_at = ${record.created_at}`,
    });
  }

  const notes: string[] = [];
  if (total_matched_tokens === 0 && predicateResults.every((p) => p.passed)) {
    notes.push(
      "No token overlap with title/summary/tags. If this record still matched by cosine, the match is semantic (embedding space), not lexical — legibility here is limited.",
    );
  }
  if (!passedPrefilter) notes.push("This record does NOT pass the given filters — a search with these filters would exclude it.");

  const result: MemoryExplainResult = {
    record_summary: { id: record.id, kind: record.kind, title: record.title, summary: record.summary },
    query: opts.query,
    query_tokens: queryTokens,
    field_matches,
    total_matched_tokens,
    filter_effects: {
      filters_applied: filters,
      passed_prefilter: passedPrefilter,
      predicate_results: predicateResults,
    },
    notes,
  };

  // Opt-in narration — Instant tier, grounded in the deterministic facts.
  // think:false is LOAD-BEARING on Qwen 3. Without it the model spends the
  // 80-token budget on internal CoT and returns an empty `response`.
  if (opts.narrate && opts.client && opts.instantModel) {
    try {
      const resp = await opts.client.generate({
        model: opts.instantModel,
        prompt: buildNarrationPrompt(result),
        think: false,
        options: { temperature: 0.2, num_predict: 80 },
      });
      result.narration = resp.response.trim().replace(/\s+/g, " ");
    } catch (err) {
      notes.push(`Narration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// ── memory_neighbors ─────────────────────────────────────────
//
// Given a record id, return records similar to it by the record's own
// stored embedding vs other records' stored embeddings. Pure math, no
// model call. A neighbor is a neighbor — NOT a recommendation.

import type { ScoreBand } from "./retrieval.js";

function scoreBand(score: number): ScoreBand {
  if (score >= 0.55) return "strong";
  if (score >= 0.35) return "medium";
  return "weak";
}

export interface MemoryNeighbor {
  id: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  score: number;
  band: ScoreBand;
  provenance: { source_path: string; ref: string };
}

export interface MemoryNeighborsResult {
  source_id: string;
  source_kind: MemoryKind;
  filters_applied: { kinds?: MemoryKind[] };
  considered: number;
  neighbors: MemoryNeighbor[];
  neighbors_by_kind: Record<MemoryKind, MemoryNeighbor[]>;
  notes: string[];
}

export interface MemoryNeighborsOptions extends StoreOptions {
  kinds?: MemoryKind[];
  top_k?: number;
  preloaded?: { index: MemoryIndex; embeddings: EmbeddingsStore };
}

export async function neighborsOf(id: string, opts: MemoryNeighborsOptions = {}): Promise<MemoryNeighborsResult> {
  const { index, embeddings } = opts.preloaded ?? {
    index: await loadIndex(opts),
    embeddings: await loadEmbeddings(opts),
  };
  const record = index.records.find((r) => r.id === id);
  if (!record) throw new Error(`Unknown memory_id: ${id}`);

  const notes: string[] = [];
  const selfEmbedding = embeddings.entries[record.id];
  if (!selfEmbedding) {
    notes.push("Source record has no stored embedding yet — run ollama_memory_refresh first.");
    return {
      source_id: record.id,
      source_kind: record.kind,
      filters_applied: { kinds: opts.kinds },
      considered: 0,
      neighbors: [],
      neighbors_by_kind: { skill_receipt: [], pack_artifact: [], approved_skill: [], candidate_proposal: [] },
      notes,
    };
  }

  const allowKind = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;
  const scored: MemoryNeighbor[] = [];
  let considered = 0;
  for (const r of index.records) {
    if (r.id === record.id) continue;
    if (allowKind && !allowKind.has(r.kind)) continue;
    const entry = embeddings.entries[r.id];
    if (!entry) continue;
    considered += 1;
    const score = cosine(selfEmbedding.vector, entry.vector);
    if (score <= 0) continue;
    scored.push({
      id: r.id,
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      score,
      band: scoreBand(score),
      provenance: { source_path: r.provenance.source_path, ref: r.provenance.ref },
    });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const topK = scored.slice(0, opts.top_k ?? 8);
  const byKind: Record<MemoryKind, MemoryNeighbor[]> = {
    skill_receipt: [],
    pack_artifact: [],
    approved_skill: [],
    candidate_proposal: [],
  };
  for (const n of topK) byKind[n.kind].push(n);

  return {
    source_id: record.id,
    source_kind: record.kind,
    filters_applied: { kinds: opts.kinds },
    considered,
    neighbors: topK,
    neighbors_by_kind: byKind,
    notes,
  };
}
