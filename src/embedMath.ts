/**
 * Minimal vector math for concept-search mode. Stdlib only.
 *
 * `cosine(a, b)` returns a similarity in [-1, 1] (higher = more similar).
 * `rank` returns descending by score and stable by input order on ties.
 */

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface RankedCandidate<T> {
  item: T;
  score: number;
  /** Input-order index for stable sorting. */
  originalIndex: number;
}

/**
 * Rank candidates by cosine similarity to queryVec, descending.
 * Ties break on original input index so the output is deterministic.
 */
export function rankByCosine<T>(
  queryVec: number[],
  candidates: Array<{ item: T; vec: number[] }>,
): RankedCandidate<T>[] {
  const ranked: RankedCandidate<T>[] = candidates.map((c, i) => ({
    item: c.item,
    score: cosine(queryVec, c.vec),
    originalIndex: i,
  }));
  ranked.sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex));
  return ranked;
}
