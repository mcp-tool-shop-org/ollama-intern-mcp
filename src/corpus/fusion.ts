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
 *
 * Scale note (F-35003a1d): RRF needs no calibration to FUSE, but the
 * number it produces is tiny and non-obvious — a doc ranked #1 in every
 * list earns only sum(weights) / (k + 1), i.e. 2/61 ≈ 0.0328 for the
 * default two weight-1.0 lists. That reads to an operator (and to any
 * caller applying an absolute floor) as "3% relevant". `rrfMaxScore` and
 * `maxFactBoost` expose the theoretical ceilings so the searcher can
 * rescale the fused score onto 0–1 using the same constants the fuser
 * used, instead of a magic number copied at the call site.
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
 * RRF smoothing constant — the canonical value from Cormack et al. 2009.
 * Exported so anything that needs the theoretical score ceiling derives it
 * from the SAME k the fuser used (a second hard-coded 60 elsewhere would
 * silently mis-normalize the day this is tuned).
 */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion. Score for doc d =
 *   sum over input lists i: weight_i / (K + rank_i(d))
 * where K is a smoothing constant (default `RRF_K` = 60 — the canonical
 * value from Cormack et al. 2009). A doc that appears in only one list is
 * still scored; a doc absent from every list never appears in the output.
 *
 * The output is NOT on a 0–1 scale: see `rrfMaxScore` for the ceiling.
 */
export function rrfFuse(lists: FusionList[], k: number = RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { ranked, weight = 1 } of lists) {
    for (const r of ranked) {
      scores.set(r.chunkId, (scores.get(r.chunkId) ?? 0) + weight / (k + r.rank));
    }
  }
  return scores;
}

/**
 * Theoretical maximum `rrfFuse` score for `lists`: what a doc earns by
 * ranking #1 in every one of them, i.e. sum(weight_i) / (k + 1). With the
 * searcher's default pair of weight-1.0 lists at k = 60 that is
 * 2 / 61 ≈ 0.0328.
 *
 * Dividing a fused score by this puts it back on 0–1 without touching the
 * ordering (it is a single positive constant applied to every doc in the
 * run). Returns 0 for an empty list set — callers must not divide by it
 * blindly.
 */
export function rrfMaxScore(lists: FusionList[], k: number = RRF_K): number {
  let totalWeight = 0;
  for (const { weight = 1 } of lists) totalWeight += weight;
  return totalWeight / (k + 1);
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

/**
 * Largest multiplier `applyFactBoost` can apply to a single score: an exact
 * substring match in a chunk at or below the short-chunk floor. With the
 * defaults that is 2.5 × 1.15 = 2.875.
 *
 * Each factor is floored at 1.0 because a non-matching / long chunk keeps
 * its score unchanged (multiplier 1), so a sub-1.0 configured multiplier
 * would make 1.0 — not itself — the maximum. Fact mode divides by
 * `rrfMaxScore(lists) * maxFactBoost()` to land back on 0–1.
 */
export function maxFactBoost(opts: FactBoostOptions = {}): number {
  const cfg = { ...DEFAULT_FACT_BOOST, ...opts };
  return Math.max(cfg.exactSubstringMultiplier, 1) * Math.max(cfg.shortChunkMaxMultiplier, 1);
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
