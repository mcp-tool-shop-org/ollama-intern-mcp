/**
 * bannedPhrases — marketing-sludge rejection list for `draft(style="doc")`.
 *
 * The draft-for-prose problem: even strong models generate hype words when
 * asked for "doc" output. A post-generation regex pass catches the obvious
 * sludge and triggers regeneration. Won't catch subtle bad prose, but
 * cheapens the floor by rejecting the signal words that flag it.
 *
 * List is curated from the 2026-04-17 adoption pass and the repo-dataset
 * marketing swarm — phrases that came back in brochure-voice drafts.
 *
 * Kept minimal on purpose. A bloated list starts rejecting legitimate
 * technical prose ("robust error handling", "leverage caching"). Each entry
 * here is one we'd reject 95%+ of the time as sludge.
 *
 * Match is case-insensitive, whole-word. Multi-word phrases match across
 * whitespace; embedded punctuation is not normalized away (matches on
 * natural prose boundaries only).
 */

export const BANNED_PHRASES: readonly string[] = Object.freeze([
  "blazing fast",
  "industry-leading",
  "industry leading",
  "the only",
  "effortless",
  "effortlessly",
  "seamless",
  "seamlessly",
  "enhance",
  "enhances",
  "enhanced",
  "streamline",
  "streamlines",
  "streamlined",
  "leverage",
  "leverages",
  "leveraging",
  "unlock",
  "unlocks",
  "unlocking",
  "empower",
  "empowers",
  "empowering",
  "robust",
  "cutting-edge",
  "cutting edge",
  "next-generation",
  "next generation",
  "best-in-class",
  "best in class",
]);

export interface BannedPhraseMatch {
  phrase: string;
  index: number;
}

/**
 * Scan `text` for any entry in `list`. Returns every match (case-insensitive,
 * whole-word). Empty array means the text is clean.
 *
 * Whole-word match prevents false positives like "ecutting-edge" or
 * "unlocksmith". Uses \b from the regex engine — which treats hyphen as a
 * word boundary, so "cutting-edge" matches both "cutting-edge" (as a single
 * token by its natural boundaries) and by falling back through the split
 * "cutting" and "edge" variants already in the list.
 */
export function findBannedPhrases(
  text: string,
  list: readonly string[] = BANNED_PHRASES,
): BannedPhraseMatch[] {
  const matches: BannedPhraseMatch[] = [];
  const lower = text.toLowerCase();
  for (const phrase of list) {
    const lowerPhrase = phrase.toLowerCase();
    // Escape-contract: every JavaScript regex metacharacter outside a
    // character class is escaped here. The set `.*+?^${}()|[]\` is complete
    // per MDN — `-`, `/`, `=`, `!`, `:` are not metacharacters in this
    // position and do not need escaping. A phrase containing any of
    // `.*+?{}()[]\|^$` therefore becomes a literal match, not a pattern.
    // See tests/guardrails/bannedPhrases.test.ts for the contract test.
    const escaped = lowerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow flexible whitespace inside multi-word phrases.
    const pattern = escaped.replace(/\s+/g, "\\s+");
    const re = new RegExp(`\\b${pattern}\\b`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      matches.push({ phrase, index: m.index });
    }
  }
  return matches;
}

/** True iff any banned phrase is present. Cheap wrapper for handler use. */
export function containsBannedPhrase(
  text: string,
  list: readonly string[] = BANNED_PHRASES,
): boolean {
  return findBannedPhrases(text, list).length > 0;
}

/**
 * Detail payload for an operator-facing structured event emitted when the
 * banned-phrase guardrail rejects a draft. Includes the matched phrase,
 * its character index in the rejected text, and an optional truncated
 * "location" string carrying ~40 chars of context around the match for
 * grep-friendly debugging.
 *
 * Phase 7 / FT-001: `op` + `rule` stamped so the NDJSON log filters
 * uniformly with `jq 'select(.op=="guardrail" and
 * .detail.rule=="banned_phrase")'`. The NDJSON logger auto-merges
 * `run_id` from the active AsyncLocalStorage `CorrelationContext` at
 * write time (see observability.withCorrelation), so this helper does
 * not need to know about run_id.
 *
 * Pattern (wired by tools agent in src/tools/draft.ts):
 *
 *   for (const m of findBannedPhrases(text)) {
 *     await ctx.logger.log({ kind: 'guardrail', ts: ...,
 *       tool: 'ollama_draft', rule: detail.rule, action: 'rejected',
 *       detail: buildBannedPhraseEvent(m, text) });
 *   }
 */
export interface BannedPhraseEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. Always 'guardrail' here. */
  op: "guardrail";
  /** Stable rule identifier — greppable. */
  rule: "banned_phrase";
  /** The exact entry from the banned list that matched (case as listed). */
  phrase: string;
  /** Character index of the match in the original text. */
  index: number;
  /**
   * Up to ~40 chars of surrounding context — enough for an operator to
   * eyeball whether the match was a true positive or an unfortunate
   * substring inside a quoted example. May be omitted when the caller
   * doesn't have access to the original text at log time.
   */
  location?: string;
}

/** Number of context characters to capture either side of the match. */
const LOCATION_CONTEXT_CHARS = 40;

/**
 * Build the structured-event detail for an operator log entry when a
 * banned-phrase match was found. Includes the phrase, char index, and
 * (when `text` is supplied) a windowed `location` snippet so an
 * operator reading log_tail can see the context without re-running.
 *
 * `text` is optional — callers without the original text (e.g., the
 * draft body has already been mutated) can omit it; the event still
 * carries phrase + index so the match is recoverable.
 */
export function buildBannedPhraseEvent(
  match: BannedPhraseMatch,
  text?: string,
): BannedPhraseEventDetail {
  const detail: BannedPhraseEventDetail = {
    op: "guardrail",
    rule: "banned_phrase",
    phrase: match.phrase,
    index: match.index,
  };
  if (typeof text === "string" && text.length > 0) {
    const start = Math.max(0, match.index - LOCATION_CONTEXT_CHARS);
    const end = Math.min(
      text.length,
      match.index + match.phrase.length + LOCATION_CONTEXT_CHARS,
    );
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    detail.location = `${prefix}${text.slice(start, end)}${suffix}`;
  }
  return detail;
}
