/**
 * Corpus search dispatcher — picks the retrieval strategy and returns
 * ranked hits with a stable tie-break. No synthesis here: the answer
 * flagship builds on top of this.
 *
 * Modes:
 *   - semantic   : dense cosine only (pre-slice-3 behavior)
 *   - lexical    : BM25 only, never calls embed
 *   - hybrid     : RRF-fused semantic + lexical, default mode
 *   - fact       : hybrid + exact-substring boost + short-chunk preference
 *   - title_path : pure metadata (lexical with body weight = 0), no embed
 *
 * Mode choice controls whether the query is embedded at all; `lexical`
 * and `title_path` skip the embed round-trip entirely, so the model
 * mismatch check only fires on modes that actually touch the embed rail.
 *
 * Tie-break: score desc, then (path asc, chunk_index asc). Zero-score
 * chunks are dropped before top_k slicing.
 *
 * Score scale (F-35003a1d): `score` does NOT mean the same thing in every
 * mode, so every hit now says which scale it is on (`score_scale`) and the
 * two fused modes are rescaled onto 0–1 before they leave this module.
 * Raw RRF tops out at 2/61 ≈ 0.0328, which read to an operator as "3%
 * relevant" and made an absolute floor (the briefs' documented 0–1
 * `corpus_min_evidence_score`) drop 100% of hybrid evidence. Rescaling is
 * one positive constant applied to every doc in a run — the numbers change,
 * the ranking does not. `lexical` / `title_path` stay on raw BM25 and are
 * UNBOUNDED; no absolute 0–1 floor is meaningful there.
 */

import type { OllamaClient } from "../ollama.js";
import { rankByCosine } from "../embedMath.js";
import { InternError } from "../errors.js";
import { embedWithTimeout } from "../guardrails/embedTimeout.js";
import type { ChunkType } from "./chunker.js";
import {
  buildLexicalIndex,
  scoreLexical,
  tokenize,
  type FieldName,
  type LexicalIndex,
  type LexicalScore,
} from "./lexical.js";
import { applyFactBoost, maxFactBoost, rrfFuse, rrfMaxScore, toRanked, type FusionList } from "./fusion.js";
import type { CorpusChunk, CorpusFile } from "./storage.js";

export type SearchMode = "semantic" | "lexical" | "hybrid" | "fact" | "title_path";

export const DEFAULT_SEARCH_MODE: SearchMode = "hybrid";

export const SEARCH_MODES: readonly SearchMode[] = [
  "semantic",
  "lexical",
  "hybrid",
  "fact",
  "title_path",
] as const;

/**
 * Which numeric scale a hit's `score` is on. Read this BEFORE comparing a
 * score to a constant — the scales differ by orders of magnitude.
 *
 *   - `cosine`   : dense cosine similarity, (0, 1]. Mode `semantic`.
 *   - `bm25`     : weighted per-field BM25 sum. UNBOUNDED (commonly ~1–30,
 *                  grows with query length and corpus IDF). Modes `lexical`
 *                  and `title_path`. An absolute 0–1 floor is MEANINGLESS
 *                  here — filter by rank, or normalize against `hits[0]`.
 *   - `rrf`      : RRF fusion of the dense + lexical rails, divided by the
 *                  theoretical RRF ceiling (`rrfMaxScore`), so (0, 1] with
 *                  1.0 = ranked #1 in both rails. Mode `hybrid`.
 *   - `rrf_fact` : the `rrf` value times the fact boost, divided by
 *                  ceiling × `maxFactBoost()`, so (0, 1] with 1.0 = top of
 *                  both rails AND an exact substring match in a short
 *                  chunk. A top-ranked hit with no exact match tops out
 *                  near 1 / 2.875 ≈ 0.35. Mode `fact`.
 */
export type ScoreScale = "cosine" | "bm25" | "rrf" | "rrf_fact";

/**
 * Marker appended to a `preview` that does not contain the whole chunk.
 * Appended AFTER the `preview_chars` slice, so the content itself is still
 * exactly `preview_chars` long and the marker is unambiguous.
 */
export const PREVIEW_TRUNCATION_MARKER = "…";

export interface CorpusHit {
  id: string;
  path: string;
  /**
   * Relevance score. Its RANGE depends on the mode — read `score_scale`
   * before comparing it against any constant. See {@link ScoreScale} for
   * the per-scale ranges; `cosine`, `rrf` and `rrf_fact` are (0, 1] while
   * `bm25` is unbounded.
   *
   * Only ever compare scores from the SAME mode to each other. Ranking is
   * identical before and after the 0–1 rescale the fused modes apply.
   */
  score: number;
  /** The scale `score` is on — see {@link ScoreScale}. */
  score_scale: ScoreScale;
  /** The search mode that produced this hit (what `score_scale` follows from). */
  mode: SearchMode;
  chunk_index: number;
  char_start: number;
  char_end: number;
  heading_path: string[];
  chunk_type: ChunkType;
  title: string | null;
  /**
   * LEADING SLICE of the chunk text, bounded by the caller's
   * `preview_chars` — NOT the full chunk, and truncation is the common
   * case (corpus_search defaults to 200 chars against 800-char chunks).
   * Ends with {@link PREVIEW_TRUNCATION_MARKER} when it was cut; compare
   * `preview_truncated` / `text_chars` rather than assuming completeness.
   * Absent entirely when `preview_chars` is 0.
   */
  preview?: string;
  /**
   * True when `preview` is a cut-down slice rather than the whole chunk.
   * Present only alongside `preview`. A consumer that needs the full text
   * (evidence excerpts, phrase matching) must re-read the chunk instead of
   * treating a truncated preview as complete.
   */
  preview_truncated?: boolean;
  /** Length of the FULL chunk text in characters, regardless of preview. */
  text_chars: number;
  /**
   * Query terms (post-tokenization, post-stopword) that matched this chunk
   * in any field. Present on the lexical-bearing modes only — absent on
   * `semantic`, and absent on a hybrid/fact hit that the lexical rail did
   * not rank at all (i.e. it matched no keyword). Deterministic and free:
   * the BM25 pass already computes it, so "why did this rank?" no longer
   * requires the per-hit `explain` LLM call.
   */
  matched_terms?: string[];
  /**
   * RAW per-field BM25 contributions (before the field weights are
   * applied), so a caller can see whether a hit ranked on its title, its
   * path, its heading breadcrumb, or its body. Present under the same
   * conditions as `matched_terms`. Note `title_path` mode scores the body
   * field too and then suppresses it with weight 0 — a non-zero `body`
   * here does not mean the body contributed to `score` in that mode.
   */
  field_scores?: Record<FieldName, number>;
}

export interface SearchParams {
  corpus: CorpusFile;
  query: string;
  model: string;
  mode?: SearchMode;
  top_k?: number;
  preview_chars?: number;
  client: OllamaClient;
}

function modeRequiresEmbedding(mode: SearchMode): boolean {
  return mode === "semantic" || mode === "hybrid" || mode === "fact";
}

function stableSort(hits: CorpusHit[]): CorpusHit[] {
  return hits.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.chunk_index - b.chunk_index;
  });
}

/** Per-hit provenance the dispatcher knows and the chunk does not. */
interface HitContext {
  mode: SearchMode;
  scale: ScoreScale;
  /** Lexical detail for this chunk, when the mode ran the keyword rail. */
  lexical?: Pick<LexicalScore, "fieldScores" | "matchedTerms">;
}

function toHit(
  c: CorpusChunk,
  score: number,
  corpus: CorpusFile,
  previewChars: number,
  ctx: HitContext,
): CorpusHit {
  // Truncation is the DEFAULT path here, not an edge case: 200 preview
  // chars against 800-char chunks. An unmarked slice hands the model (and
  // the retrieval eval's phrase check) a sentence severed mid-clause that
  // reads as a whole one, so mark the cut and carry the real length.
  const slice = previewChars > 0 ? c.text.slice(0, previewChars) : null;
  const truncated = slice !== null && slice.length < c.text.length;
  return {
    id: c.id,
    path: c.path,
    score,
    score_scale: ctx.scale,
    mode: ctx.mode,
    chunk_index: c.chunk_index,
    char_start: c.char_start,
    char_end: c.char_end,
    heading_path: c.heading_path,
    chunk_type: c.chunk_type,
    title: corpus.titles?.[c.path] ?? null,
    ...(slice !== null
      ? {
          preview: truncated ? slice + PREVIEW_TRUNCATION_MARKER : slice,
          preview_truncated: truncated,
        }
      : {}),
    text_chars: c.text.length,
    ...(ctx.lexical
      ? { matched_terms: ctx.lexical.matchedTerms, field_scores: ctx.lexical.fieldScores }
      : {}),
  };
}

async function scoreDense(
  params: SearchParams,
): Promise<Array<{ chunkId: string; score: number }>> {
  // Bounded by the canonical embed budget so a wedged embed can't hold a
  // semaphore permit un-timed (H4-res). Search is a single embed, no cascade.
  const resp = await embedWithTimeout(params.client, { model: params.model, input: params.query });
  if (resp.embeddings.length === 0) {
    throw new Error("Embed returned no vectors for query");
  }
  const queryVec = resp.embeddings[0];
  const ranked = rankByCosine(
    queryVec,
    params.corpus.chunks.map((c: CorpusChunk) => ({ item: c, vec: c.vector })),
  );
  // Drop non-positive cosines — they carry no useful similarity signal
  // and would otherwise seed spurious ranks into RRF fusion.
  return ranked.filter((r) => r.score > 0).map((r) => ({ chunkId: r.item.id, score: r.score }));
}

/**
 * Full BM25 rows, NOT just (chunkId, score): the per-field breakdown and
 * matched terms lexical.ts deliberately preserves on every result used to
 * be discarded here, so the two keyword-truth modes could only report a
 * bare number (F-777bf138). The dispatcher now carries them onto the hit.
 */
function scoreLex(
  query: string,
  index: LexicalIndex,
  mode: SearchMode,
): LexicalScore[] {
  // title_path suppresses the body field; other modes use default weights.
  const opts = mode === "title_path" ? { weights: { body: 0 } } : {};
  return scoreLexical(query, index, opts);
}

function toScored(rows: LexicalScore[]): Array<{ chunkId: string; score: number }> {
  return rows.map((r) => ({ chunkId: r.chunkId, score: r.score }));
}

/**
 * True iff the query is null, empty, or whitespace-only. Every search mode
 * needs a query with at least one non-whitespace character — BM25 and the
 * embed tier both return meaningless results for whitespace. Rather than
 * silently returning 0 hits (which looks indistinguishable from "no
 * matches"), callers get a fast-path empty result and the tool layer
 * annotates the envelope so the user sees WHY retrieval was zero.
 */
export function isEmptyQuery(query: string | null | undefined): boolean {
  return query == null || query.trim().length === 0;
}

/**
 * True iff the query survives `isEmptyQuery` but tokenizes to ZERO lexical
 * terms — the silent zero `isEmptyQuery` was written to prevent, one step
 * further in (F-90e1bb67). Two reachable triggers, neither exotic:
 *
 *   (a) an all-stopword query ("is it in the") — `tokenize` drops every term;
 *   (b) any query with no ASCII word characters — the tokenizer splits on
 *       /[^a-z0-9]+/, so Japanese, Chinese, Cyrillic, Greek and
 *       emoji-only queries yield nothing (see `tokenize`).
 *
 * In `lexical` / `title_path` that guarantees zero hits with no other
 * signal; in `hybrid` / `fact` the keyword rail contributes nothing to the
 * fusion and results come from the dense rail alone.
 */
export function hasNoLexicalTerms(query: string | null | undefined): boolean {
  if (query == null) return true;
  return tokenize(query).length === 0;
}

/** Modes whose entire result comes from the keyword rail. */
function isKeywordOnlyMode(mode: SearchMode): boolean {
  return mode === "lexical" || mode === "title_path";
}

/**
 * Operator-facing reason a query is structurally unsearchable in `mode`,
 * or null when the query carries usable signal for that mode. The tool
 * layer pairs this with an empty result to emit `weak: true` + `reason`,
 * so a degenerate query never renders as a plain "no matches".
 *
 * `semantic` returns null for a zero-term query: the dense rail embeds the
 * raw string and never touches the tokenizer.
 */
export function degenerateQueryReason(
  query: string | null | undefined,
  mode: SearchMode = DEFAULT_SEARCH_MODE,
): string | null {
  if (isEmptyQuery(query)) return "empty query";
  if (!hasNoLexicalTerms(query) || mode === "semantic") return null;
  const cause =
    "query has no searchable terms after tokenization (stopwords only, or no ASCII word characters — the keyword rail is ASCII-only)";
  return isKeywordOnlyMode(mode)
    ? `${cause}; mode "${mode}" is keyword-only, so it can return no hits`
    : `${cause}; the keyword rail contributes nothing in mode "${mode}" and results come from the dense rail alone`;
}

export async function searchCorpus(params: SearchParams): Promise<CorpusHit[]> {
  const mode = params.mode ?? DEFAULT_SEARCH_MODE;
  // Fast-path: empty/whitespace-only query. Skip BOTH the embed round-trip
  // and the BM25 build — they'd return noise ranked by index order. The
  // tool layer also checks `isEmptyQuery` and surfaces a `weak: true` /
  // `reason: "empty query"` envelope so callers can tell this apart from
  // "no matches found".
  if (isEmptyQuery(params.query)) return [];
  if (params.corpus.chunks.length === 0) return [];
  // Same fast-path one step in: a keyword-only mode whose query tokenizes
  // to nothing can only return []. Skip the index build (scoreLexical would
  // return [] anyway — identical result, no wasted pass). `hybrid`/`fact`
  // deliberately continue: the dense rail still has signal. Callers get the
  // WHY from `degenerateQueryReason`, not from a bare empty array.
  if (isKeywordOnlyMode(mode) && hasNoLexicalTerms(params.query)) return [];

  if (modeRequiresEmbedding(mode) && params.corpus.model_version !== params.model) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${params.corpus.name}" was indexed with model "${params.corpus.model_version}", but active embed tier is "${params.model}". Mode "${mode}" requires embedding the query.`,
      `Re-index with the current embed model, or call with mode: "lexical" or "title_path" — those don't embed.`,
      false,
    );
  }

  const topK = params.top_k ?? params.corpus.chunks.length;
  const previewChars = params.preview_chars ?? 0;
  const chunkById = new Map(params.corpus.chunks.map((c) => [c.id, c]));

  let lexicalIndex: LexicalIndex | null = null;
  if (mode !== "semantic") {
    lexicalIndex = buildLexicalIndex(params.corpus.chunks, params.corpus.titles ?? {});
  }

  let denseScored: Array<{ chunkId: string; score: number }> | null = null;
  if (modeRequiresEmbedding(mode)) {
    denseScored = await scoreDense(params);
  }

  let lexicalRows: LexicalScore[] | null = null;
  if (mode !== "semantic") {
    lexicalRows = scoreLex(params.query, lexicalIndex!, mode);
  }
  // Per-chunk keyword detail, kept for the hit builder. A hybrid/fact chunk
  // the lexical rail never ranked simply has no entry — and its hit then
  // carries no matched_terms, which is the honest answer ("matched nothing").
  const lexicalDetail = new Map<string, LexicalScore>(
    (lexicalRows ?? []).map((r) => [r.chunkId, r]),
  );

  let finalScores: Array<{ chunkId: string; score: number }>;
  let scale: ScoreScale;

  if (mode === "semantic") {
    finalScores = denseScored!;
    scale = "cosine";
  } else if (isKeywordOnlyMode(mode)) {
    finalScores = toScored(lexicalRows!);
    scale = "bm25";
  } else {
    // hybrid and fact: RRF-fuse dense + lexical.
    const lists: FusionList[] = [
      { ranked: toRanked(denseScored!), weight: 1.0 },
      { ranked: toRanked(lexicalRows!), weight: 1.0 },
    ];
    const fused = rrfFuse(lists);
    finalScores = [...fused.entries()].map(([chunkId, score]) => ({ chunkId, score }));
    // Ceiling for the 0–1 rescale, derived from the same lists + k the fuser
    // used rather than a copied 0.0328 literal.
    let ceiling = rrfMaxScore(lists);
    scale = "rrf";
    if (mode === "fact") {
      const chunkText = new Map<string, string>();
      for (const c of params.corpus.chunks) chunkText.set(c.id, c.text);
      finalScores = applyFactBoost(finalScores, { query: params.query, chunkText });
      // The boost multiplies on top of the fused score, so the fact ceiling
      // is the RRF ceiling times the largest boost a chunk can earn.
      ceiling *= maxFactBoost();
      scale = "rrf_fact";
    }
    // Rescale onto 0–1. One positive constant across every doc in this run:
    // it changes the numbers a caller reads, never the ranking or the ties.
    // Guarded because rrfMaxScore is 0 for an empty list set.
    if (ceiling > 0) {
      finalScores = finalScores.map(({ chunkId, score }) => ({ chunkId, score: score / ceiling }));
    }
  }

  const hits: CorpusHit[] = [];
  for (const { chunkId, score } of finalScores) {
    if (score <= 0) continue;
    const c = chunkById.get(chunkId);
    if (!c) continue;
    const lex = lexicalDetail.get(chunkId);
    hits.push(
      toHit(c, score, params.corpus, previewChars, {
        mode,
        scale,
        ...(lex
          ? { lexical: { fieldScores: lex.fieldScores, matchedTerms: lex.matchedTerms } }
          : {}),
      }),
    );
  }

  return stableSort(hits).slice(0, topK);
}
