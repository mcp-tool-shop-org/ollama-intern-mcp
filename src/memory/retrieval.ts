/**
 * Memory retrieval — metadata pre-filter + cosine rank against embedded
 * memory records.
 *
 * Filter-vs-rank strategy (per research): pre-filter by HARD predicates
 * (kind, tags, facet exact-match) so the candidate set shrinks before
 * embedding math runs. Similarity then reorders the survivors.
 *
 * Typed results — every match carries `kind`, so the caller can surface
 * "similar past run" / "similar skill" / "similar artifact" simply by
 * filtering on kind or grouping the response.
 *
 * Explain surfaces (for Phase 3C): every match reports which filter
 * predicates it matched, its similarity score, and a bucketed label
 * (strong/medium/weak) so the caller doesn't have to eyeball raw cosines.
 */

import { cosine } from "../embedMath.js";
import type { OllamaClient } from "../ollama.js";
import { loadEmbeddings, queryEmbedText, type EmbeddingsStore } from "./embeddings.js";
import { loadIndex, type StoreOptions } from "./store.js";
import type { MemoryIndex, MemoryKind, MemoryRecord } from "./types.js";

export interface MemoryFacetPredicate {
  /** Exact-equality predicate on a facet value. */
  equals?: string | number | boolean | null;
}

export interface MemoryFilters {
  kinds?: MemoryKind[];
  /** Each listed tag must be present on the record (AND). */
  tags?: string[];
  /** Each facet key maps to a predicate; all must pass (AND). */
  facets?: Record<string, MemoryFacetPredicate>;
  /** Consider only records with created_at >= since. */
  since?: string;
}

export type ScoreBand = "strong" | "medium" | "weak";

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
  band: ScoreBand;
  /** Ordered reasons: "kind:X matched", "tag:Y matched", "facet:Z == V", "top_cosine". */
  reasons: string[];
  matched_tags: string[];
  matched_facets: string[];
}

export interface MemorySearchResult {
  query: string;
  filters: MemoryFilters;
  considered: number;
  candidates_after_prefilter: number;
  weak: boolean;
  hits: MemoryHit[];
}

/** Score bands — tight enough to flag weak retrieval honestly. */
function scoreBand(score: number): ScoreBand {
  if (score >= 0.55) return "strong";
  if (score >= 0.35) return "medium";
  return "weak";
}

export function prefilter(records: MemoryRecord[], filters: MemoryFilters): {
  survivors: MemoryRecord[];
  matchReasons: Map<string, { tags: string[]; facets: string[]; kind: boolean }>;
} {
  const matchReasons = new Map<string, { tags: string[]; facets: string[]; kind: boolean }>();
  const survivors: MemoryRecord[] = [];

  const kinds = filters.kinds && filters.kinds.length > 0 ? new Set(filters.kinds) : null;
  const requiredTags = filters.tags ?? [];
  const facetPredicates = filters.facets ?? {};
  const sinceMs = filters.since ? Date.parse(filters.since) : null;

  for (const r of records) {
    if (kinds && !kinds.has(r.kind)) continue;
    if (sinceMs !== null) {
      const rMs = Date.parse(r.created_at);
      if (Number.isFinite(rMs) && rMs < sinceMs) continue;
    }
    const matchedTags: string[] = [];
    let tagOk = true;
    for (const t of requiredTags) {
      if (r.tags.includes(t)) matchedTags.push(t);
      else {
        tagOk = false;
        break;
      }
    }
    if (!tagOk) continue;

    const matchedFacets: string[] = [];
    let facetOk = true;
    for (const [key, pred] of Object.entries(facetPredicates)) {
      const value = r.facets[key];
      if (pred.equals !== undefined) {
        if (value === pred.equals) matchedFacets.push(`${key}==${JSON.stringify(pred.equals)}`);
        else {
          facetOk = false;
          break;
        }
      }
    }
    if (!facetOk) continue;

    survivors.push(r);
    matchReasons.set(r.id, {
      tags: matchedTags,
      facets: matchedFacets,
      kind: !!kinds,
    });
  }
  return { survivors, matchReasons };
}

export interface SearchOptions extends StoreOptions {
  client: OllamaClient;
  embedModel: string;
  /** Cap on returned hits. Default 8. */
  limit?: number;
  /** Optional pre-loaded index + embeddings for test injection. */
  preloaded?: { index: MemoryIndex; embeddings: EmbeddingsStore };
}

/**
 * Rank filtered records against a pre-computed query vector. Used both by
 * free-text search (query vector comes from embedding the query) and by
 * "similar to this record" retrieval (query vector is the record's own
 * stored embedding — no fresh Ollama call needed).
 */
export function rankAgainstVector(
  survivors: MemoryRecord[],
  matchReasons: Map<string, { tags: string[]; facets: string[]; kind: boolean }>,
  queryVec: number[],
  embeddings: EmbeddingsStore,
  excludeId?: string,
): MemoryHit[] {
  const scored: MemoryHit[] = [];
  for (const r of survivors) {
    if (r.id === excludeId) continue;
    const entry = embeddings.entries[r.id];
    if (!entry) continue;
    const score = cosine(queryVec, entry.vector);
    if (score <= 0) continue;
    const band = scoreBand(score);
    const mr = matchReasons.get(r.id) ?? { tags: [], facets: [], kind: false };
    const reasons: string[] = [];
    if (mr.kind) reasons.push(`kind:${r.kind}`);
    for (const t of mr.tags) reasons.push(`tag:${t}`);
    for (const f of mr.facets) reasons.push(`facet:${f}`);
    reasons.push(`cosine:${score.toFixed(3)}`);
    scored.push({
      record: r,
      score,
      band,
      reasons,
      matched_tags: mr.tags,
      matched_facets: mr.facets,
    });
  }
  scored.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1));
  return scored;
}

export async function searchMemory(
  query: string,
  filters: MemoryFilters,
  opts: SearchOptions,
): Promise<MemorySearchResult> {
  const limit = opts.limit ?? 8;
  const { index, embeddings } = opts.preloaded ?? {
    index: await loadIndex(opts),
    embeddings: await loadEmbeddings(opts),
  };

  const { survivors, matchReasons } = prefilter(index.records, filters);

  if (survivors.length === 0) {
    return {
      query,
      filters,
      considered: index.records.length,
      candidates_after_prefilter: 0,
      weak: true,
      hits: [],
    };
  }

  // Embed the query ONCE, with nomic's `search_query:` task prefix.
  const resp = await opts.client.embed({
    model: opts.embedModel,
    input: queryEmbedText(query),
  });
  const queryVec = resp.embeddings[0];
  if (!queryVec) {
    return {
      query,
      filters,
      considered: index.records.length,
      candidates_after_prefilter: survivors.length,
      weak: true,
      hits: [],
    };
  }

  const scored = rankAgainstVector(survivors, matchReasons, queryVec, embeddings);
  const hits = scored.slice(0, limit);
  const weak = hits.length === 0 || hits[0].band === "weak";

  return {
    query,
    filters,
    considered: index.records.length,
    candidates_after_prefilter: survivors.length,
    weak,
    hits,
  };
}
