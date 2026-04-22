/**
 * Tool-layer helpers.
 *
 * Small, shared utilities for brief / pack tools. Keeps domain-specific
 * normalization out of individual handlers without bloating the common
 * briefs module, which is already evidence-focused.
 */

import { InternError } from "../errors.js";

/**
 * Max length for a user-supplied corpus_query string. 200 chars is well
 * past any reasonable natural-language query yet small enough that a
 * novice/noisy caller can't fill the embedding input with fence-delimited
 * prose blobs or whole log excerpts.
 */
export const MAX_CORPUS_QUERY_CHARS = 200;

/**
 * Enforce the corpus_query length + shape contract.
 *
 * The query flows through to embedding + prompt contexts; long multi-line
 * payloads dilute the vector, waste tokens, and can smuggle code-fence
 * delimiters into prompts. Reject rather than silently truncating — the
 * caller learns the limit the first time.
 *
 * Strips newlines (CR/LF) and fence markers from OTHERWISE-valid queries
 * as a convenience: they're always mistakes, never intent.
 */
export function normalizeCorpusQuery(
  raw: string | undefined,
  opts: { fieldName?: string } = {},
): string | undefined {
  if (raw === undefined) return undefined;
  const field = opts.fieldName ?? "corpus_query";
  // Strip fences + newlines first — if the cleaned query fits within the
  // cap we keep the call alive instead of rejecting on trivia.
  const cleaned = raw.replace(/```/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length > MAX_CORPUS_QUERY_CHARS) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${field} exceeds ${MAX_CORPUS_QUERY_CHARS} chars after stripping newlines/fences (got ${cleaned.length}).`,
      `Corpus queries are short retrieval prompts, not log excerpts or diff blobs. Shorten to under ${MAX_CORPUS_QUERY_CHARS} chars — if the signal you need is a whole log, pass it as log_text instead.`,
      false,
    );
  }
  return cleaned;
}
