/**
 * Shared brief helpers — evidence assembly, ref validation, JSON parsing.
 *
 * Every brief tool follows the same skeleton:
 *   1. Assemble numbered evidence from the caller's inputs
 *   2. Prompt the Deep tier with the numbered evidence + a structured
 *      JSON schema the model must fill in
 *   3. Validate model-cited evidence_refs against real evidence ids
 *   4. Honestly flag weak briefs via coverage_notes
 *
 * This module centralizes (1), (3), and the generic pieces of (4) so
 * brief handlers stay focused on their prompt and their output shape.
 */

import { resolveTier } from "../../tiers.js";
import { loadSources } from "../../sources.js";
import { loadCorpus } from "../../corpus/storage.js";
import { searchCorpus, DEFAULT_SEARCH_MODE, type CorpusHit } from "../../corpus/searcher.js";
import { InternError } from "../../errors.js";
import type { RunContext } from "../../runContext.js";
import {
  sliceLogIntoEvidence,
  sliceDiffIntoEvidence,
  pathToEvidence,
  corpusHitsToEvidence,
  EVIDENCE_CONFIG,
  type EvidenceItem,
} from "./evidence.js";

export interface AssembleEvidenceInput {
  /** Raw log text, sliced into numbered line-range windows. */
  log_text?: string;
  /** Unified-diff text, split on `diff --git` markers into per-file items. */
  diff_text?: string;
  /** File paths loaded server-side (Claude does not preload). */
  source_paths?: string[];
  /** Optional corpus; queried via hybrid mode when `corpus_query` is non-empty. */
  corpus?: string;
  /** Already-resolved corpus query. Handlers decide their own fallback. */
  corpus_query?: string;
  /** Per-file chunk cap when loading source_paths. */
  per_file_max_chars?: number;
  /** How many chunks to pull from the corpus. */
  corpus_top_k?: number;
}

export interface AssembledEvidence {
  evidence: EvidenceItem[];
  corpus_used: { name: string; chunks_used: number } | null;
  /** Corpus hits kept for callers that want to inspect them beyond evidence snapshotting. */
  corpus_hits: CorpusHit[];
}

/**
 * Walk the input sources in a deterministic order (log → diff → paths →
 * corpus) and return a single numbered evidence list. Ids are "e1",
 * "e2", ... — assigned in that order so the model can cite by index.
 */
export async function assembleEvidence(
  input: AssembleEvidenceInput,
  ctx: RunContext,
): Promise<AssembledEvidence> {
  const perFileMax = input.per_file_max_chars ?? 20_000;
  const corpusTopK = input.corpus_top_k ?? 4;
  const evidence: EvidenceItem[] = [];
  let nextId = 1;

  if (input.log_text) {
    const logEv = sliceLogIntoEvidence(input.log_text, nextId);
    evidence.push(...logEv);
    nextId += logEv.length;
  }

  if (input.diff_text) {
    const diffEv = sliceDiffIntoEvidence(input.diff_text, nextId);
    evidence.push(...diffEv);
    nextId += diffEv.length;
  }

  if (input.source_paths && input.source_paths.length > 0) {
    const sources = await loadSources(input.source_paths, perFileMax);
    const pathEv = pathToEvidence(sources, nextId);
    evidence.push(...pathEv);
    nextId += pathEv.length;
  }

  let corpus_used: AssembledEvidence["corpus_used"] = null;
  let corpus_hits: CorpusHit[] = [];
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
    const query = (input.corpus_query ?? "").trim();
    if (query.length > 0) {
      const embedModel = resolveTier("embed", ctx.tiers);
      corpus_hits = await searchCorpus({
        corpus,
        query,
        model: embedModel,
        mode: DEFAULT_SEARCH_MODE,
        top_k: corpusTopK,
        preview_chars: EVIDENCE_CONFIG.CORPUS_EXCERPT_CHARS,
        client: ctx.client,
      });
      const corpusEv = corpusHitsToEvidence(corpus_hits, nextId);
      evidence.push(...corpusEv);
      nextId += corpusEv.length;
    }
    corpus_used = { name: input.corpus, chunks_used: corpus_hits.length };
  }

  return { evidence, corpus_used, corpus_hits };
}

/**
 * Strip model-supplied evidence_refs that don't match any real evidence id.
 * Dedupes while preserving first-mention order. Returns the valid subset
 * and a count of stripped refs so callers can surface it in warnings.
 */
export function normalizeRefs(
  refs: unknown,
  validIds: Set<string>,
): { valid: string[]; stripped: number } {
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

/** Normalize a free-form confidence string to the closed set. */
export function normalizeConfidence(c: unknown): "high" | "medium" | "low" {
  if (c === "high" || c === "medium" || c === "low") return c;
  return "low";
}

/** Tolerant JSON parse: returns an empty object if the model didn't follow the contract. */
export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(raw.trim());
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

/** Pick a string field off a loose object, else default to empty. */
export function readString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

/** Pick an array field off a loose object, else default to empty array. */
export function readArray(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}
