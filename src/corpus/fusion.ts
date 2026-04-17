/**
 * Score fusion primitives — pure, deterministic, no I/O.
 *
 * RRF (Reciprocal Rank Fusion) combines multiple ranked lists into one.
 * It is the standard fusion strategy in modern hybrid retrieval because
 * it needs no score calibration — only ranks — so BM25 and cosine can
 * be safely combined without learning a joint normalization.
 *
 * `applyFactBoost` is the "fact mode" reranker: a dominant multiplier
 * for exact-substring matches plus a secondary multiplier for short
 * chunks. Boost, never filter — chunks without a match keep their
 * fused score and stay in the result so a near-miss query never
 * collapses to empty.
 */

export interface Ranked {
  /** Opaque chunk identifier. */
  chunkId: string;
  /** 1-indexed rank within the source list. */
  rank: number;
}

export interface FusionList {
  ranked: Ranked[];
  /** Defaults to 1.0. Weighting is multiplicative on the RRF term. */
  weight?: number;
}

/**
 * Reciprocal Rank Fusion. Score for doc d =
 *   sum over input lists i: weight_i / (K + rank_i(d))
 * where K is a smoothing constant (default 60 — the canonical value from
 * Cormack et al. 2009). A doc that appears in only one list is still
 * scored; a doc absent from every list never appears in the output.
 */
export function rrfFuse(lists: FusionList[], k: number = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { ranked, weight = 1 } of lists) {
    for (const r of ranked) {
      scores.set(r.chunkId, (scores.get(r.chunkId) ?? 0) + weight / (k + r.rank));
    }
  }
  return scores;
}

/**
 * Convert a score-sorted list into a rank list. Ties are broken by the
 * order the scores arrive — callers are responsible for passing in a
 * deterministically sorted list. Ranks are 1-indexed as RRF expects.
 */
export function toRanked(scored: Array<{ chunkId: string }>): Ranked[] {
  return scored.map((s, i) => ({ chunkId: s.chunkId, rank: i + 1 }));
}

export interface FactBoostOptions {
  /** Multiplier applied when the chunk text contains the query substring (case-insensitive). */
  exactSubstringMultiplier?: number;
  /** Multiplier range for short chunks. Shorter = higher multiplier. */
  shortChunkMaxMultiplier?: number;
  /** Chunks at or below this length receive the full short-chunk boost. */
  shortChunkFloorChars?: number;
  /** Chunks at or above this length receive no short-chunk boost. */
  shortChunkCeilingChars?: number;
}

const DEFAULT_FACT_BOOST: Required<FactBoostOptions> = {
  exactSubstringMultiplier: 2.5,
  shortChunkMaxMultiplier: 1.15,
  shortChunkFloorChars: 200,
  shortChunkCeilingChars: 1600,
};

export interface FactBoostInput {
  chunkId: string;
  score: number;
}

export interface FactBoostContext {
  query: string;
  chunkText: Map<string, string>;
}

/**
 * Apply the fact-mode reranker. Returns a new list; input is not mutated.
 * Dominant boost = exact substring match (multiplier ≈ 2.5x by default).
 * Secondary boost = short-chunk preference (up to ≈ 1.15x, decays to 1.0).
 * Non-matching chunks keep their fused score unchanged and stay in the list.
 */
export function applyFactBoost(
  scored: FactBoostInput[],
  ctx: FactBoostContext,
  opts: FactBoostOptions = {},
): FactBoostInput[] {
  const cfg = { ...DEFAULT_FACT_BOOST, ...opts };
  const q = ctx.query.toLowerCase();
  const hasQuery = q.length > 0;
  const boosted: FactBoostInput[] = [];
  for (const s of scored) {
    const text = ctx.chunkText.get(s.chunkId) ?? "";
    let mult = 1;
    if (hasQuery && text.toLowerCase().includes(q)) {
      mult *= cfg.exactSubstringMultiplier;
    }
    mult *= shortChunkMultiplier(text.length, cfg);
    boosted.push({ chunkId: s.chunkId, score: s.score * mult });
  }
  return boosted;
}

function shortChunkMultiplier(
  len: number,
  cfg: Required<FactBoostOptions>,
): number {
  if (len <= cfg.shortChunkFloorChars) return cfg.shortChunkMaxMultiplier;
  if (len >= cfg.shortChunkCeilingChars) return 1.0;
  const range = cfg.shortChunkCeilingChars - cfg.shortChunkFloorChars;
  const delta = cfg.shortChunkMaxMultiplier - 1.0;
  return cfg.shortChunkMaxMultiplier - (delta * (len - cfg.shortChunkFloorChars) / range);
}
