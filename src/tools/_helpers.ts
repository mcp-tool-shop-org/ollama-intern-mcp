/**
 * Tool-layer helpers.
 *
 * Small, shared utilities for brief / pack tools. Keeps domain-specific
 * normalization out of individual handlers without bloating the common
 * briefs module, which is already evidence-focused.
 */

import { posix } from "node:path";
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
/**
 * Strip prompt-injection vectors from a user-supplied field: code-fence
 * delimiters and CR/LF become spaces, then runs of whitespace collapse. A
 * user field can no longer break out of its slot in an LLM prompt with a
 * fenced block or a newline-delimited "IGNORE ABOVE" instruction.
 */
export function stripInjectionVectors(raw: string): string {
  return raw.replace(/```/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Sanitize a user-supplied field that flows VERBATIM into an LLM prompt
 * (classify labels/frame, research question — M9). Strips injection vectors
 * (fences/newlines) then rejects if the cleaned text exceeds maxChars.
 * Returns the cleaned text. The length reject keeps a caller from filling the
 * prompt budget with a whole log/diff blob under the guise of one field.
 */
export function sanitizePromptField(
  raw: string,
  opts: { fieldName: string; maxChars: number },
): string {
  const cleaned = stripInjectionVectors(raw);
  if (cleaned.length > opts.maxChars) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${opts.fieldName} exceeds ${opts.maxChars} chars after stripping newlines/fences (got ${cleaned.length}).`,
      `Shorten ${opts.fieldName} to a concise single-line value under ${opts.maxChars} chars — it is interpolated directly into the model prompt, so newlines and code fences are stripped.`,
      false,
    );
  }
  return cleaned;
}

export function normalizeCorpusQuery(
  raw: string | undefined,
  opts: { fieldName?: string } = {},
): string | undefined {
  if (raw === undefined) return undefined;
  const field = opts.fieldName ?? "corpus_query";
  // Strip fences + newlines first — if the cleaned query fits within the
  // cap we keep the call alive instead of rejecting on trivia.
  const cleaned = stripInjectionVectors(raw);
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

/**
 * Posix-normalize a path for allowlist comparison: backslashes become
 * slashes, `.` / `..` collapse, a leading `./` is stripped.
 */
export function posixNormPath(p: string): string {
  let n = posix.normalize(p.replace(/\\/g, "/"));
  while (n.startsWith("./")) n = n.slice(2);
  return n;
}

function posixIsAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("//") || /^[A-Za-z]:\//.test(p);
}

/**
 * Allowlist membership for model-cited paths vs caller/diff paths.
 *
 * Exact posix-normalized equality always matches. A separator-safe suffix
 * matches only when the shorter side contains a path separator (rel vs abs
 * of the same file) AND the longer side is absolute. Bare filenames
 * (`package.json`) must equal exactly — `node_modules/evil/package.json`
 * must not inherit membership from a git-diff basename, and
 * `evil/src/index.ts` must not inherit from `src/index.ts`.
 */
export function allowlistPathsMatch(a: string, b: string): boolean {
  const na = posixNormPath(a);
  const nb = posixNormPath(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (!shorter.includes("/")) return false;
  if (!longer.endsWith("/" + shorter)) return false;
  return posixIsAbsolute(longer);
}
