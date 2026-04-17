/**
 * Coverage contract — after a multi-source research or summarize call,
 * detect which source paths the model's output actually covered.
 *
 * A two-file summary that only mentions one file is a real quality bug
 * (observed in the first adoption pass: commandui.md + hardware-m5-max.md
 * → summary only covered CommandUI). Silently accepting that makes the
 * flagship less trustworthy. This module surfaces omissions so the caller
 * knows when to rerun, re-prompt, or read the omitted file themselves.
 *
 * Detection is deterministic and cheap — no extra LLM calls. We pull a
 * small set of "distinctive tokens" per source and check how many show
 * up in the output. Accurate enough to catch whole-file omissions,
 * conservative enough to avoid false-alarm on tight summaries.
 */

import { basename, extname } from "node:path";
import type { LoadedSource } from "./sources.js";

export interface CoverageReport {
  covered_sources: string[];
  omitted_sources: string[];
  coverage_notes: string[];
}

/** Stop words + common connectors we won't treat as distinctive signal. */
const STOP = new Set([
  "the","and","for","with","from","into","over","under","this","that","these","those",
  "have","will","shall","been","were","being","your","their","them","they","each",
  "when","what","where","which","would","could","should","about","after","before",
  "some","most","many","much","more","less","also","than","then","there","here",
  "only","just","very","such","like","than","onto","upon","into","unto","then",
  "name","type","description","true","false","null","none","note","notes","section",
  "example","examples","step","steps","item","items","thing","things","file","files",
  "input","inputs","output","outputs","result","results","value","values","field","fields",
  "option","options","param","params","return","returns","function","class","method",
  "interface","import","export","const","async","await","null","true","false",
]);

function isSignalToken(word: string): boolean {
  if (word.length < 5) return false;
  if (/^\d+$/.test(word)) return false;
  if (STOP.has(word.toLowerCase())) return false;
  return true;
}

/** Extract distinctive signal tokens from a source: frequent, long, non-stop. */
function signalTokensFor(source: LoadedSource, maxTokens: number = 12): string[] {
  const body = source.body.slice(0, 4000); // headers/summary region is enough
  const words = body
    .toLowerCase()
    .split(/[^a-z0-9-]+/g)
    .filter(isSignalToken);
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  // Score: frequency * length — long repeated tokens are most distinctive.
  const ranked = [...freq.entries()]
    .map(([w, c]) => ({ word: w, score: c * Math.min(w.length, 12) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTokens)
    .map((r) => r.word);

  // Always include the filename stem — it's often the strongest coverage signal
  // ("commandui" from "commandui.md" will appear in any summary that covers it).
  const stem = basename(source.path, extname(source.path)).toLowerCase();
  if (stem && !ranked.includes(stem)) ranked.unshift(stem);
  return ranked;
}

function outputHasAnyToken(output: string, tokens: string[]): boolean {
  const lower = output.toLowerCase();
  for (const t of tokens) {
    // Word-ish match: surrounded by non-alphanum or at string edges.
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(t)}([^a-z0-9]|$)`, "i");
    if (re.test(lower)) return true;
  }
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DetectCoverageOptions {
  /** Paths the caller already knows are covered (e.g. from research citations). */
  explicitlyCovered?: string[];
  /** Maximum signal tokens to extract per source. Default 12. */
  maxTokensPerSource?: number;
}

/**
 * Detect which source paths the output covers.
 *
 * A source is "covered" when:
 *   - it appears in `explicitlyCovered` (citations etc.), OR
 *   - any of its signal tokens appear in the output.
 *
 * Everything else is "omitted" and a coverage note is added.
 */
export function detectCoverage(
  output: string,
  sources: LoadedSource[],
  options: DetectCoverageOptions = {},
): CoverageReport {
  const explicit = new Set((options.explicitlyCovered ?? []).map(normalizeForCompare));
  const covered: string[] = [];
  const omitted: string[] = [];
  const notes: string[] = [];

  for (const src of sources) {
    const isExplicit = explicit.has(normalizeForCompare(src.path));
    if (isExplicit) {
      covered.push(src.path);
      continue;
    }
    const tokens = signalTokensFor(src, options.maxTokensPerSource);
    if (tokens.length === 0) {
      // No detectable signal — don't falsely claim coverage. Call it omitted.
      omitted.push(src.path);
      notes.push(`No distinctive tokens extractable from "${src.path}"; coverage could not be verified.`);
      continue;
    }
    if (outputHasAnyToken(output, tokens)) {
      covered.push(src.path);
    } else {
      omitted.push(src.path);
    }
  }

  if (omitted.length > 0 && sources.length > 1) {
    notes.unshift(
      `Summary omitted ${omitted.length} of ${sources.length} source(s). Consider rerunning with a narrower focus, a longer max_words, or reading the omitted files directly.`,
    );
  }

  return { covered_sources: covered, omitted_sources: omitted, coverage_notes: notes };
}

function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
