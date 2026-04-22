/**
 * ollama_corpus_search — FLAGSHIP persistent concept search.
 *
 * Tier: Embed. Loads the named corpus from disk, embeds the query once,
 * cosine-ranks against stored chunk vectors, returns ranked hits. Raw
 * vectors never cross the MCP boundary.
 *
 * Use this to search memory/, canon/, handbook/, doctrine/, etc. by
 * concept — the filename-to-idea bridge the handoff called out as the
 * flagship user story.
 *
 * Optional refinements:
 *   - `filter.path_glob` — minimatch-style glob against chunk.path. Supports
 *     `**` (recursive), `*` (single segment, no separator), `?` (single char).
 *     No brace expansion — keep patterns simple.
 *   - `filter.since` — ISO timestamp. Only chunks whose source file's
 *     recorded mtime is ≥ this value survive the filter.
 *   - `explain: true` — after retrieval, call the Instant tier per top-5
 *     hit with "why does this chunk match the query?" and attach the result
 *     as `why_matched`. Capped at 5 hits to bound cost; LLM failures
 *     degrade gracefully (no `why_matched`, a warnings[] entry appended).
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { resolveTier, TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { loadCorpus, type CorpusFile, type CorpusChunk } from "../corpus/storage.js";
import { searchCorpus, DEFAULT_SEARCH_MODE, SEARCH_MODES, isEmptyQuery, type CorpusHit, type SearchMode } from "../corpus/searcher.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const corpusSearchSchema = z.object({
  corpus: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .describe("Name of the corpus to search (e.g. 'memory', 'canon'). Must have been indexed first with ollama_corpus_index."),
  query: z
    .string()
    .min(1)
    // 1000-char cap is generous — briefs cap at 200, but corpus queries are
    // the flagship tool for longer agent-style prompts. Beyond 1000 chars
    // you're not searching, you're pasting a document; the retrieval
    // contract degrades and the embed call is an API misuse.
    .max(1000, "query must be 1000 characters or fewer")
    .describe("Concept or question to search for (max 1000 chars)."),
  mode: z
    .enum(SEARCH_MODES as unknown as [SearchMode, ...SearchMode[]])
    .optional()
    .describe(
      "Ranking strategy. 'hybrid' (default) fuses dense + lexical via RRF — best for general queries. 'semantic' is dense-only. 'lexical' is BM25-only (no embed call). 'fact' is hybrid with exact-substring + short-chunk boosts for specific-fact lookups. 'title_path' searches only title/heading/path metadata (no embed call, sub-ms).",
    ),
  top_k: z.number().int().min(1).max(100).optional().describe("Return the top K chunks (default 10)."),
  preview_chars: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe("Include this many chars of each chunk's text in the result (default 200)."),
  filter: z
    .object({
      path_glob: z
        .string()
        .min(1)
        .optional()
        .describe("Minimatch-style glob applied to chunk.path. Supports **, *, ? (no braces). Applied BEFORE ranking."),
      since: z
        .string()
        .min(1)
        .optional()
        .describe("ISO timestamp. Keep only chunks whose source file mtime is ≥ this value."),
    })
    .optional()
    .describe("Restrict which chunks participate in retrieval. Applied before RRF fusion so scores reflect the filtered set."),
  explain: z
    .boolean()
    .optional()
    .describe("When true, each top-5 hit gets a short LLM-generated 'why matched' explanation. Capped at 5 hits to bound cost. Fails soft — on LLM failure the hits return without why_matched and a warning is appended."),
});

export type CorpusSearchInput = z.infer<typeof corpusSearchSchema>;

export interface CorpusHitExplained extends CorpusHit {
  why_matched?: string;
}

export interface CorpusSearchResult {
  hits: CorpusHitExplained[];
  corpus_name: string;
  model_version: string;
  total_chunks: number;
  mode: SearchMode;
  /**
   * True when retrieval was skipped or degenerate — e.g. empty query.
   * Absent on the happy path. Pairs with `reason` so callers can tell
   * "zero hits because of a degenerate query" apart from "zero matches".
   */
  weak?: boolean;
  /** Plain-English explanation when `weak: true`. */
  reason?: string;
  /** Populated when the caller used filter.* — how many chunks survived. */
  filter_applied?: {
    total_before: number;
    kept: number;
    path_glob?: string;
    since?: string;
  };
}

/** Hard cap on explain calls — keep cost bounded even if the caller asks for top_k: 100. */
const EXPLAIN_CAP = 5;

/**
 * Minimal glob → regex converter.
 *
 * Supports:
 *   - `**` (any number of segments, including zero)
 *   - `*`  (any chars except separator within a single segment)
 *   - `?`  (single char except separator)
 *   - `\` and `/` are treated as equivalent separators so Windows paths
 *     match POSIX-style globs (the common case: a caller types
 *     "F:/AI/**" and the corpus stored "F:\AI\...").
 *
 * No brace expansion, no character classes. Keep the matcher honest
 * and document the limitations on the tool description.
 */
export function globToRegex(glob: string): RegExp {
  // Normalize separators in the glob itself — callers can write POSIX
  // slashes and still match Windows chunk paths.
  const src = glob;
  let rx = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "*") {
      if (src[i + 1] === "*") {
        // `**` — any number of path segments, including nothing.
        rx += ".*";
        i += 2;
        // Absorb a trailing separator after `**` so "**/*.md" matches
        // "file.md" at root too.
        if (src[i] === "/" || src[i] === "\\") i += 1;
      } else {
        // Single `*` — match anything except separators within this segment.
        rx += "[^\\\\/]*";
        i += 1;
      }
    } else if (ch === "?") {
      rx += "[^\\\\/]";
      i += 1;
    } else if (ch === "/" || ch === "\\") {
      // Either separator matches either separator.
      rx += "[\\\\/]";
      i += 1;
    } else if (/[a-zA-Z0-9_\- ]/.test(ch)) {
      rx += ch;
      i += 1;
    } else {
      // Escape anything else to be literal.
      rx += "\\" + ch;
      i += 1;
    }
  }
  return new RegExp("^" + rx + "$");
}

/**
 * Apply filter.path_glob / filter.since to a corpus by producing a
 * filtered copy (shared metadata, reduced chunks). Returns the original
 * corpus untouched when no filter is set — no wasted allocation.
 */
export function applyFilter(
  corpus: CorpusFile,
  filter: { path_glob?: string; since?: string } | undefined,
): { corpus: CorpusFile; kept: number; total_before: number } {
  const total_before = corpus.chunks.length;
  if (!filter || (!filter.path_glob && !filter.since)) {
    return { corpus, kept: total_before, total_before };
  }
  let sinceMs: number | null = null;
  if (filter.since) {
    const t = Date.parse(filter.since);
    if (Number.isNaN(t)) {
      throw new InternError(
        "FILTER_INVALID",
        `filter.since is not a parseable ISO timestamp: ${filter.since}`,
        "Pass an ISO-8601 string like '2026-04-01T00:00:00Z'.",
        false,
      );
    }
    sinceMs = t;
  }
  let rx: RegExp | null = null;
  if (filter.path_glob) {
    try {
      rx = globToRegex(filter.path_glob);
    } catch (err) {
      throw new InternError(
        "FILTER_INVALID",
        `filter.path_glob failed to compile: ${(err as Error).message}`,
        "Keep the glob simple — only **, *, ? and literal segments are supported. No braces, no character classes.",
        false,
      );
    }
  }

  const keptChunks: CorpusChunk[] = [];
  for (const c of corpus.chunks) {
    if (rx && !rx.test(c.path)) continue;
    if (sinceMs !== null) {
      const t = Date.parse(c.file_mtime);
      if (Number.isNaN(t) || t < sinceMs) continue;
    }
    keptChunks.push(c);
  }
  const filtered: CorpusFile = { ...corpus, chunks: keptChunks };
  return { corpus: filtered, kept: keptChunks.length, total_before };
}

function buildExplainPrompt(query: string, hit: CorpusHitExplained): string {
  const heading = hit.heading_path && hit.heading_path.length > 0 ? hit.heading_path.join(" > ") : "(none)";
  return [
    `In ONE short sentence (≤ 30 words), explain why this chunk matches the query.`,
    `Do NOT quote the chunk verbatim. Do NOT preamble. Just the reason.`,
    ``,
    `Query: ${query}`,
    `Chunk path: ${hit.path}`,
    `Heading: ${heading}`,
    `Preview: ${hit.preview ?? "(no preview)"}`,
  ].join("\n");
}

export async function handleCorpusSearch(
  input: CorpusSearchInput,
  ctx: RunContext,
): Promise<Envelope<CorpusSearchResult>> {
  const startedAt = Date.now();
  const model = resolveTier("embed", ctx.tiers);

  const loaded = await loadCorpus(input.corpus);
  if (!loaded) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${input.corpus}" does not exist`,
      `Build it first with ollama_corpus_index({ name: "${input.corpus}", paths: [...] }), or call ollama_corpus_list to see available corpora.`,
      false,
    );
  }

  const topK = input.top_k ?? 10;
  const previewChars = input.preview_chars ?? 200;
  const mode: SearchMode = input.mode ?? DEFAULT_SEARCH_MODE;

  // Empty / whitespace-only query short-circuit. Zod's .min(1) rejects
  // length-0 strings, but "   " passes the schema and would otherwise
  // fall through to an embed call that returns noise. Returning a
  // weak: true envelope gives callers a legible "why zero?" signal.
  if (isEmptyQuery(input.query)) {
    const envelope = buildEnvelope<CorpusSearchResult>({
      result: {
        hits: [],
        corpus_name: loaded.name,
        model_version: loaded.model_version,
        total_chunks: loaded.chunks.length,
        mode,
        weak: true,
        reason: "empty query",
      },
      tier: "embed",
      model,
      hardwareProfile: ctx.hardwareProfile,
      tokensIn: 0,
      tokensOut: 0,
      startedAt,
      residency: null,
      warnings: ["corpus_search: empty query; retrieval skipped"],
    });
    await ctx.logger.log(callEvent("ollama_corpus_search", envelope));
    return envelope;
  }

  // Apply filter BEFORE retrieval so ranking operates on the reduced set
  // (scores and RRF fusion reflect only what survived the filter).
  const filtered = applyFilter(loaded, input.filter);
  const corpus = filtered.corpus;

  const rawHits = await searchCorpus({
    corpus,
    query: input.query,
    model,
    mode,
    top_k: topK,
    preview_chars: previewChars,
    client: ctx.client,
  });

  const warnings: string[] = [];
  let explainedHits: CorpusHitExplained[] = rawHits;

  if (input.explain === true && rawHits.length > 0) {
    const deepModel = resolveTier("instant", ctx.tiers);
    const toExplain = rawHits.slice(0, EXPLAIN_CAP);
    let explainFailures = 0;
    const explanations = await Promise.all(
      toExplain.map(async (hit) => {
        try {
          const resp = await ctx.client.generate({
            model: deepModel,
            prompt: buildExplainPrompt(input.query, hit),
            options: {
              temperature: TEMPERATURE_BY_SHAPE.summarize,
              // ~40 tokens is plenty for a single-sentence explanation.
              num_predict: 80,
            },
          });
          const text = (resp.response ?? "").trim();
          return text.length > 0 ? text : null;
        } catch {
          explainFailures += 1;
          return null;
        }
      }),
    );
    explainedHits = rawHits.map((hit, i) => {
      if (i >= EXPLAIN_CAP) return hit;
      const reason = explanations[i];
      return reason ? { ...hit, why_matched: reason } : hit;
    });
    if (explainFailures > 0) {
      warnings.push(
        `corpus_search: ${explainFailures} of ${toExplain.length} explain calls failed; affected hits returned without why_matched.`,
      );
    }
    if (rawHits.length > EXPLAIN_CAP) {
      warnings.push(
        `corpus_search: explain capped at top ${EXPLAIN_CAP} hit(s); ${rawHits.length - EXPLAIN_CAP} remaining hit(s) returned without why_matched.`,
      );
    }
  }

  // title_path and lexical never embed; skip the residency call too.
  const modeEmbeds = mode === "semantic" || mode === "hybrid" || mode === "fact";
  const residency = modeEmbeds ? await ctx.client.residency(model) : null;

  const filterApplied = input.filter && (input.filter.path_glob || input.filter.since)
    ? {
        total_before: filtered.total_before,
        kept: filtered.kept,
        ...(input.filter.path_glob ? { path_glob: input.filter.path_glob } : {}),
        ...(input.filter.since ? { since: input.filter.since } : {}),
      }
    : undefined;

  const envelope = buildEnvelope<CorpusSearchResult>({
    result: {
      hits: explainedHits,
      corpus_name: loaded.name,
      model_version: loaded.model_version,
      total_chunks: loaded.chunks.length,
      mode,
      ...(filterApplied ? { filter_applied: filterApplied } : {}),
    },
    tier: "embed",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: Math.ceil(input.query.length / 4),
    tokensOut: 0,
    startedAt,
    residency,
    warnings: warnings.length > 0 ? warnings : undefined,
  });

  await ctx.logger.log(callEvent("ollama_corpus_search", envelope));
  return envelope;
}
