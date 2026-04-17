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
    // Escape regex metachars in the phrase, then bound on word chars.
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
