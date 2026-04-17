/**
 * Lexical index + BM25 scorer — the "keyword truth" rail.
 *
 * This file is deliberately narrow: it produces one trustworthy primitive,
 * `scoreLexical(query, index)`, that returns deterministic field-aware
 * BM25 scores over v2 chunks. No fusion, no modes, no synthesis — slice 3
 * layers those on top.
 *
 * Four fields are scored independently and then combined into a single
 * `score`, but the per-field breakdown is preserved on every result so
 * slice 3 can recombine them (e.g. title_path mode) without reworking
 * this layer.
 *
 * Field identity matters:
 *   - title         : the file's first H1 (if any)
 *   - heading_path  : the breadcrumb stack for the chunk's section
 *   - path          : file path tokens (dirs, base name, extension)
 *   - body          : the chunk text itself
 *
 * Determinism guarantees:
 *   - Sort by score desc, then (path asc, chunk_index asc) as tie-break.
 *   - Zero-score chunks are omitted.
 *   - Tokenizer is pure: same input → same tokens, independent of locale.
 *   - Stopword set is a fixed list in this file (no env lookup).
 */

import type { CorpusChunk } from "./storage.js";

// BM25 constants — classic Robertson/Walker defaults.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Default per-field weights. Metadata matches outweigh body because a
// term in the title almost always means "this document is about that
// thing" while a term in the body can be incidental.
export const DEFAULT_FIELD_WEIGHTS = {
  title: 3.0,
  heading: 2.0,
  path: 1.5,
  body: 1.0,
} as const;

// Small, conservative English stopword list. Applied at BOTH index and
// query time so IDF statistics stay consistent. Kept short on purpose —
// overly aggressive stopword removal eats legitimate technical terms.
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "do", "does", "did", "for", "from", "had", "has", "have", "he", "her",
  "him", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my",
  "of", "on", "or", "our", "she", "so", "than", "that", "the", "their",
  "them", "these", "they", "this", "those", "to", "us", "was", "we", "were",
  "will", "with", "you", "your",
]);

export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}

/**
 * Generic tokenizer for body/title/heading text.
 * Lowercases, splits on non-alphanumeric, drops stopwords and empties.
 * No stemming, no fuzzy matching — those are explicit slice-3+ decisions.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const raw = lower.split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length === 0) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Path tokenizer — same splitter as body, but runs the full path through
 * so dirs, base name stem, and extension each become searchable tokens.
 * Absolute-path prefixes (drive letters, leading slashes) contribute
 * nothing once split, which is the right behavior.
 */
export function tokenizePath(path: string): string[] {
  return tokenize(path);
}

/**
 * Heading tokenizer — flattens the heading_path breadcrumb into tokens.
 * Deeper headings contribute the same as shallower ones; weighting by
 * depth is a slice-3+ concern.
 */
export function tokenizeHeadings(headingPath: string[]): string[] {
  const joined = headingPath.join(" ");
  return tokenize(joined);
}

export type FieldName = "body" | "heading" | "title" | "path";

interface LexicalDoc {
  chunkId: string;
  chunkIndex: number;
  path: string;
  tokens: Record<FieldName, Map<string, number>>;
  len: Record<FieldName, number>;
}

export interface LexicalIndex {
  chunkCount: number;
  avg: Record<FieldName, number>;
  /** Document frequency per field: term -> number of chunks whose field contains it. */
  df: Record<FieldName, Map<string, number>>;
  docs: LexicalDoc[];
}

export interface LexicalScore {
  chunkId: string;
  chunkIndex: number;
  path: string;
  score: number;
  fieldScores: Record<FieldName, number>;
  matchedTerms: string[];
}

function countTokens(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/**
 * Build the in-memory lexical index from the chunks of a loaded corpus.
 * Idempotent and deterministic: same input corpus → identical index.
 */
export function buildLexicalIndex(
  chunks: CorpusChunk[],
  titles: Record<string, string | null>,
): LexicalIndex {
  const docs: LexicalDoc[] = [];
  const df: Record<FieldName, Map<string, number>> = {
    body: new Map(),
    heading: new Map(),
    title: new Map(),
    path: new Map(),
  };
  const totals: Record<FieldName, number> = { body: 0, heading: 0, title: 0, path: 0 };

  for (const c of chunks) {
    const bodyTokens = tokenize(c.text);
    const headingTokens = tokenizeHeadings(c.heading_path);
    const title = titles[c.path] ?? "";
    const titleTokens = tokenize(title);
    const pathTokens = tokenizePath(c.path);

    const doc: LexicalDoc = {
      chunkId: c.id,
      chunkIndex: c.chunk_index,
      path: c.path,
      tokens: {
        body: countTokens(bodyTokens),
        heading: countTokens(headingTokens),
        title: countTokens(titleTokens),
        path: countTokens(pathTokens),
      },
      len: {
        body: bodyTokens.length,
        heading: headingTokens.length,
        title: titleTokens.length,
        path: pathTokens.length,
      },
    };
    docs.push(doc);

    for (const field of ["body", "heading", "title", "path"] as FieldName[]) {
      totals[field] += doc.len[field];
      for (const term of doc.tokens[field].keys()) {
        df[field].set(term, (df[field].get(term) ?? 0) + 1);
      }
    }
  }

  const n = docs.length;
  const avg: Record<FieldName, number> = {
    body: n === 0 ? 0 : totals.body / n,
    heading: n === 0 ? 0 : totals.heading / n,
    title: n === 0 ? 0 : totals.title / n,
    path: n === 0 ? 0 : totals.path / n,
  };

  return { chunkCount: n, avg, df, docs };
}

/**
 * BM25+ IDF variant: ln((N - df + 0.5) / (df + 0.5) + 1).
 * The +1 inside the log keeps IDF non-negative for very common terms.
 */
function bm25Idf(n: number, df: number): number {
  return Math.log((n - df + 0.5) / (df + 0.5) + 1);
}

function bm25FieldScore(
  queryTerms: string[],
  doc: LexicalDoc,
  field: FieldName,
  index: LexicalIndex,
): { score: number; matched: string[] } {
  const avgLen = index.avg[field];
  const docLen = doc.len[field];
  let score = 0;
  const matched: string[] = [];
  if (docLen === 0) return { score: 0, matched };
  for (const term of queryTerms) {
    const tf = doc.tokens[field].get(term) ?? 0;
    if (tf === 0) continue;
    const df = index.df[field].get(term) ?? 0;
    const idf = bm25Idf(index.chunkCount, df);
    const normLen = avgLen === 0 ? 1 : docLen / avgLen;
    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * normLen);
    score += idf * ((tf * (BM25_K1 + 1)) / denom);
    matched.push(term);
  }
  return { score, matched };
}

export interface ScoreLexicalOptions {
  weights?: Partial<Record<FieldName, number>>;
  /** Override the query tokenizer. Default = tokenize(). */
  queryTokens?: string[];
}

/**
 * Score every chunk in the index against `query`. Returns only chunks
 * with score > 0, sorted score desc, (path asc, chunk_index asc) tie-break.
 *
 * Field scores are preserved on every result so slice 3 can recombine
 * without rescoring.
 */
export function scoreLexical(
  query: string,
  index: LexicalIndex,
  opts: ScoreLexicalOptions = {},
): LexicalScore[] {
  const queryTerms = opts.queryTokens ?? tokenize(query);
  if (queryTerms.length === 0 || index.chunkCount === 0) return [];

  const weights: Record<FieldName, number> = {
    title: opts.weights?.title ?? DEFAULT_FIELD_WEIGHTS.title,
    heading: opts.weights?.heading ?? DEFAULT_FIELD_WEIGHTS.heading,
    path: opts.weights?.path ?? DEFAULT_FIELD_WEIGHTS.path,
    body: opts.weights?.body ?? DEFAULT_FIELD_WEIGHTS.body,
  };

  const results: LexicalScore[] = [];
  for (const doc of index.docs) {
    const fieldScores: Record<FieldName, number> = { body: 0, heading: 0, title: 0, path: 0 };
    const matchedSet = new Set<string>();
    for (const field of ["body", "heading", "title", "path"] as FieldName[]) {
      const { score, matched } = bm25FieldScore(queryTerms, doc, field, index);
      fieldScores[field] = score;
      for (const m of matched) matchedSet.add(m);
    }
    const combined =
      weights.title * fieldScores.title +
      weights.heading * fieldScores.heading +
      weights.path * fieldScores.path +
      weights.body * fieldScores.body;
    if (combined <= 0) continue;
    results.push({
      chunkId: doc.chunkId,
      chunkIndex: doc.chunkIndex,
      path: doc.path,
      score: combined,
      fieldScores,
      matchedTerms: [...matchedSet].sort(),
    });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.chunkIndex - b.chunkIndex;
  });
  return results;
}
