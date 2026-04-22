/**
 * ollama_corpus_rerank — post-retrieval re-sort utility.
 *
 * Takes the hits array from a prior ollama_corpus_search (or equivalent
 * shape) and re-ranks by one of three cheap, LLM-free strategies:
 *
 *   - "recency"           : newer file mtime ranks higher (stats the file on disk)
 *   - "path_specificity"  : more path segments ranks higher
 *   - "lexical_boost"     : substring match of lexical_terms in preview /
 *                           heading_path / title, case-insensitive with
 *                           word-boundary matching, pushes hits up
 *
 * The original score is preserved on each hit so callers can diff/inspect;
 * a `rerank_score` + `rank` are appended. No embed calls, no file reads
 * except in the `recency` mode.
 */

import { z } from "zod";
import { stat } from "node:fs/promises";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier } from "../tiers.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const RERANK_MODES = ["recency", "path_specificity", "lexical_boost"] as const;
export type RerankMode = (typeof RERANK_MODES)[number];

/**
 * Input hit shape — mirrors the shape ollama_corpus_search emits. We
 * don't reuse its type because callers may pass hits from other sources
 * (synthetic, filtered, deduped) and a too-strict schema would reject
 * legitimate inputs.
 */
const inputHitSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  score: z.number(),
  chunk_index: z.number().int(),
  preview: z.string().optional(),
  heading_path: z.array(z.string()).optional(),
  title: z.string().nullable().optional(),
});

export const corpusRerankSchema = z
  .object({
    hits: z
      .array(inputHitSchema)
      .min(1, "hits must contain at least one hit to re-rank")
      .describe("Hits from a prior ollama_corpus_search (or equivalent). Required fields: id, path, score, chunk_index. Optional: preview, heading_path, title."),
    rerank_by: z
      .enum(RERANK_MODES)
      .describe("'recency' stats file mtime (newer wins). 'path_specificity' prefers deeper paths. 'lexical_boost' requires lexical_terms."),
    lexical_terms: z
      .array(z.string().min(1))
      .optional()
      .describe("Required when rerank_by='lexical_boost'. Each term is matched case-insensitively with word-boundaries against preview + heading_path + title."),
  })
  .refine(
    (d) => {
      if (d.rerank_by === "lexical_boost") {
        return Array.isArray(d.lexical_terms) && d.lexical_terms.length > 0;
      }
      return true;
    },
    {
      message: "rerank_by='lexical_boost' requires a non-empty lexical_terms array",
      path: ["lexical_terms"],
    },
  );

export type CorpusRerankInput = z.infer<typeof corpusRerankSchema>;
export type CorpusRerankHit = z.infer<typeof inputHitSchema>;

export interface RerankedHit extends CorpusRerankHit {
  /** The new score produced by the rerank strategy. */
  rerank_score: number;
  /** The hit's original input-order position (1-based) for diff/inspection. */
  original_rank: number;
  /** The hit's new rank after sorting by rerank_score (1-based). */
  rank: number;
}

export interface CorpusRerankResult {
  hits: RerankedHit[];
  rerank_by: RerankMode;
}

/** Count path segments in a path (both POSIX and Windows separators). */
function pathDepth(path: string): number {
  // Treat \ and / identically so a Windows-style "C:\foo\bar" and
  // POSIX "/foo/bar" both score 2. Drop leading/trailing separators.
  const trimmed = path.replace(/^[\\/]+|[\\/]+$/g, "");
  if (trimmed.length === 0) return 0;
  return trimmed.split(/[\\/]+/).length;
}

/** Word-boundary, case-insensitive substring test. */
function containsTermWordBounded(haystack: string, term: string): boolean {
  if (term.length === 0) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // \b is adequate for ASCII words; for Unicode-heavy terms we fall back
  // to a plain lower-case includes() which is strictly more lenient.
  try {
    const rx = new RegExp(`\\b${escaped}\\b`, "i");
    if (rx.test(haystack)) return true;
  } catch {
    // Defensive: a pathologically long term that blows the regex compiler
    // shouldn't kill the whole rerank. Fall through to the lenient check.
  }
  return haystack.toLowerCase().includes(term.toLowerCase());
}

function lexicalHaystack(h: CorpusRerankHit): string {
  const parts: string[] = [];
  if (h.preview) parts.push(h.preview);
  if (h.heading_path && h.heading_path.length > 0) parts.push(h.heading_path.join(" "));
  if (h.title) parts.push(h.title);
  return parts.join("\n");
}

async function scoreRecency(hits: CorpusRerankHit[]): Promise<Map<string, number>> {
  // One stat() per unique path, not per hit — a single file with 20
  // chunks shouldn't pay 20 syscalls.
  const scoreByPath = new Map<string, number>();
  const uniquePaths = [...new Set(hits.map((h) => h.path))];
  await Promise.all(
    uniquePaths.map(async (p) => {
      try {
        const st = await stat(p);
        scoreByPath.set(p, st.mtimeMs);
      } catch {
        // Missing file → oldest possible (0). Don't throw; rerank degrades
        // gracefully rather than failing the whole call.
        scoreByPath.set(p, 0);
      }
    }),
  );
  return scoreByPath;
}

export async function handleCorpusRerank(
  input: CorpusRerankInput,
  ctx: RunContext,
): Promise<Envelope<CorpusRerankResult>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);

  // Redundant belt-and-suspenders check — the schema refine() already
  // enforces this, but the runtime check produces a typed error code
  // callers can match on (instead of ZodError).
  if (input.rerank_by === "lexical_boost") {
    if (!input.lexical_terms || input.lexical_terms.length === 0) {
      throw new InternError(
        "RERANK_INPUT_INVALID",
        "rerank_by='lexical_boost' requires a non-empty lexical_terms array.",
        "Pass lexical_terms: ['word1', 'word2'] when using lexical_boost mode, or switch to 'recency' / 'path_specificity'.",
        false,
      );
    }
  }

  const withOriginalRank = input.hits.map((h, i) => ({ ...h, original_rank: i + 1 }));

  let scored: Array<CorpusRerankHit & { original_rank: number; rerank_score: number }>;

  if (input.rerank_by === "recency") {
    const byPath = await scoreRecency(withOriginalRank);
    scored = withOriginalRank.map((h) => ({
      ...h,
      rerank_score: byPath.get(h.path) ?? 0,
    }));
  } else if (input.rerank_by === "path_specificity") {
    scored = withOriginalRank.map((h) => ({
      ...h,
      rerank_score: pathDepth(h.path),
    }));
  } else {
    // lexical_boost — each matched term adds 1 to the boost; final score
    // is the original score + boost. We keep the original score as the
    // base so hits that matched AND were originally strong stay strong.
    const terms = input.lexical_terms as string[];
    scored = withOriginalRank.map((h) => {
      const hay = lexicalHaystack(h);
      let boost = 0;
      for (const t of terms) {
        if (containsTermWordBounded(hay, t)) boost += 1;
      }
      return { ...h, rerank_score: h.score + boost };
    });
  }

  // Sort: rerank_score desc, then original order as tiebreak so stable
  // callers see predictable output on ties.
  scored.sort((a, b) => {
    if (b.rerank_score !== a.rerank_score) return b.rerank_score - a.rerank_score;
    return a.original_rank - b.original_rank;
  });
  const ranked: RerankedHit[] = scored.map((h, i) => ({ ...h, rank: i + 1 }));

  const envelope = buildEnvelope<CorpusRerankResult>({
    result: { hits: ranked, rerank_by: input.rerank_by },
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });

  await ctx.logger.log(callEvent("ollama_corpus_rerank", envelope));
  return envelope;
}
