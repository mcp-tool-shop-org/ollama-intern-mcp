/**
 * ollama_corpus_answer — FLAGSHIP TOOL.
 *
 * Job-shape: given a NAMED CORPUS and a question, retrieve via
 * searchCorpus, then synthesize an answer grounded in the retrieved
 * chunks only. Distinct from ollama_research (which takes source_paths
 * the caller explicitly hands in).
 *
 * Tier: Deep for synthesis; Embed for retrieval (via searchCorpus).
 *
 * Laws:
 * - Retrieved chunks only. The synthesis prompt never receives outside
 *   context, and the system prompt forbids outside knowledge.
 * - Chunk-grounded citations. The model cites by source number; we
 *   validate every number is in [1, N] and strip the rest, then map
 *   back to (path, chunk_index, heading_path, title) from retrieval.
 * - Weak retrieval degrades honestly. Zero hits short-circuit without
 *   invoking the model; thin retrieval (< 2 hits) flags `weak: true`
 *   and adds a coverage note so the caller doesn't mistake a narrow
 *   answer for a confident one.
 * - Raw chunk text never crosses the MCP boundary. Only the structured
 *   citation shape and the final answer are returned.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE, resolveTier } from "../tiers.js";
import { runTool } from "./runner.js";
import { callEvent, timestamp } from "../observability.js";
import { loadCorpus } from "../corpus/storage.js";
import {
  searchCorpus,
  DEFAULT_SEARCH_MODE,
  SEARCH_MODES,
  type SearchMode,
  type CorpusHit,
} from "../corpus/searcher.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const corpusAnswerSchema = z.object({
  corpus: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_-]+$/, "Corpus names must match [a-zA-Z0-9_-]+")
    .describe("Name of the corpus to answer from (must have been indexed with ollama_corpus_index)."),
  question: z.string().min(1).describe("The question to answer."),
  mode: z
    .enum(SEARCH_MODES as unknown as [SearchMode, ...SearchMode[]])
    .optional()
    .describe("Retrieval strategy passed through to ollama_corpus_search. Default: hybrid."),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("How many chunks to retrieve as grounding (default 5). Fewer chunks means tighter citation, more chunks means broader coverage."),
  max_words: z
    .number()
    .int()
    .min(20)
    .max(1000)
    .optional()
    .describe("Target answer length in words (default 200)."),
});

export type CorpusAnswerInput = z.infer<typeof corpusAnswerSchema>;

export interface CorpusAnswerCitation {
  path: string;
  chunk_index: number;
  heading_path: string[];
  title: string | null;
}

export interface RetrievalStat {
  retrieved: number;
  total_in_corpus: number;
  top_score: number;
  weak: boolean;
}

export interface CorpusAnswerResult {
  answer: string;
  citations: CorpusAnswerCitation[];
  covered_sources: string[];
  omitted_sources: string[];
  coverage_notes: string[];
  mode: SearchMode;
  retrieval: RetrievalStat;
}

/** A single-hit retrieval is "weak" — narrow coverage, risk of over-confident synthesis. */
const WEAK_THRESHOLD_HITS = 2;

function buildPrompt(question: string, hits: CorpusHit[], maxWords: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const heading = h.heading_path.length > 0 ? h.heading_path.join(" > ") : "(none)";
    const titleLine = h.title ? ` title="${h.title}"` : "";
    blocks.push(
      `[${i + 1}] path=${h.path} chunk=${h.chunk_index}${titleLine}\n` +
        `heading: ${heading}\n` +
        `${h.preview ?? ""}`,
    );
  }
  return [
    `You are a grounded answering assistant. Use ONLY the numbered sources below.`,
    `Do not use any outside knowledge. If the sources do not contain the answer,`,
    `say so directly rather than guessing.`,
    ``,
    `Question: ${question}`,
    ``,
    `Sources (numbered):`,
    blocks.join("\n\n"),
    ``,
    `Respond with JSON matching this shape exactly:`,
    `  {"answer": "<text, at most ${maxWords} words>", "citations": [<integer source numbers used>]}`,
    ``,
    `Rules:`,
    `- Cite every substantive claim by its source number.`,
    `- Valid source numbers are 1 to ${hits.length}.`,
    `- Do not invent citation numbers outside that range.`,
    `- If the sources are insufficient, the correct answer is to say so.`,
  ].join("\n");
}

interface ModelOutput {
  answer: string;
  citations: number[];
}

function parseModelOutput(raw: string): ModelOutput {
  try {
    const obj = JSON.parse(raw.trim()) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const o = obj as { answer?: unknown; citations?: unknown };
      const answer = typeof o.answer === "string" ? o.answer : "";
      const citations = Array.isArray(o.citations)
        ? o.citations.filter((x): x is number => Number.isInteger(x))
        : [];
      return { answer, citations };
    }
  } catch {
    // Non-JSON output: treat the whole raw as answer, no citations. The
    // model ignored the JSON contract — a downstream warning catches this.
  }
  return { answer: raw.trim(), citations: [] };
}

export function validateAndMapCitations(
  numbers: number[],
  hits: CorpusHit[],
): { valid: CorpusAnswerCitation[]; stripped: number } {
  const valid: CorpusAnswerCitation[] = [];
  const seen = new Set<string>();
  let stripped = 0;
  for (const n of numbers) {
    const idx = n - 1;
    if (idx < 0 || idx >= hits.length) {
      stripped += 1;
      continue;
    }
    const h = hits[idx];
    const key = `${h.path}#${h.chunk_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({
      path: h.path,
      chunk_index: h.chunk_index,
      heading_path: h.heading_path,
      title: h.title,
    });
  }
  return { valid, stripped };
}

export function computeCoverage(
  hits: CorpusHit[],
  citations: CorpusAnswerCitation[],
  weak: boolean,
  stripped: number,
): { covered: string[]; omitted: string[]; notes: string[] } {
  const retrievedPaths = new Set(hits.map((h) => h.path));
  const citedPaths = new Set(citations.map((c) => c.path));
  const covered = [...citedPaths].sort();
  const omitted = [...retrievedPaths].filter((p) => !citedPaths.has(p)).sort();
  const notes: string[] = [];
  if (weak) {
    notes.push(
      `Retrieval was weak (${hits.length} chunk${hits.length === 1 ? "" : "s"} returned). Answer reflects narrow grounding; consider indexing more sources or rephrasing the query.`,
    );
  }
  if (retrievedPaths.size > 1 && omitted.length > 0) {
    notes.push(
      `Answer cited ${covered.length} of ${retrievedPaths.size} retrieved source(s). Uncited: ${omitted.join(", ")}`,
    );
  }
  if (stripped > 0) {
    notes.push(`Stripped ${stripped} invalid citation number(s) from model output.`);
  }
  return { covered, omitted, notes };
}

export async function handleCorpusAnswer(
  input: CorpusAnswerInput,
  ctx: RunContext,
): Promise<Envelope<CorpusAnswerResult>> {
  const mode: SearchMode = input.mode ?? DEFAULT_SEARCH_MODE;
  const topK = input.top_k ?? 5;
  const maxWords = input.max_words ?? 200;

  const corpus = await loadCorpus(input.corpus);
  if (!corpus) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${input.corpus}" does not exist`,
      `Build it first with ollama_corpus_index, or use ollama_corpus_list to see available corpora.`,
      false,
    );
  }

  const embedModel = resolveTier("embed", ctx.tiers);
  const hits = await searchCorpus({
    corpus,
    query: input.question,
    model: embedModel,
    mode,
    top_k: topK,
    preview_chars: 800,
    client: ctx.client,
  });

  const totalInCorpus = corpus.chunks.length;
  const weak = hits.length < WEAK_THRESHOLD_HITS;
  const topScore = hits.length > 0 ? hits[0].score : 0;

  // 0-hit short-circuit: refuse to invoke the model without grounding.
  // The whole thesis is that synthesis is downstream of retrieval truth;
  // synthesis without retrieval is just chat, and we already have a
  // last-resort tool for that.
  if (hits.length === 0) {
    const startedAt = Date.now();
    const deepModel = resolveTier("deep", ctx.tiers);
    const residency = await ctx.client.residency(deepModel);
    const result: CorpusAnswerResult = {
      answer:
        `No matching chunks found in corpus "${input.corpus}" for the question "${input.question}". The model was not invoked — synthesis without retrieved grounding would be unsafe. Try rephrasing, switching mode, or indexing more sources.`,
      citations: [],
      covered_sources: [],
      omitted_sources: [],
      coverage_notes: [
        `Retrieval returned 0 chunks for mode "${mode}". Model invocation skipped on purpose.`,
      ],
      mode,
      retrieval: { retrieved: 0, total_in_corpus: totalInCorpus, top_score: 0, weak: true },
    };
    const envelope = buildEnvelope<CorpusAnswerResult>({
      result,
      tier: "deep",
      model: deepModel,
      hardwareProfile: ctx.hardwareProfile,
      tokensIn: Math.ceil(input.question.length / 4),
      tokensOut: 0,
      startedAt,
      residency,
      warnings: ["corpus_answer: zero retrieval hits; model not invoked"],
    });
    await ctx.logger.log(callEvent("ollama_corpus_answer", envelope));
    return envelope;
  }

  // Normal path: synthesize with Deep tier from the retrieved chunks only.
  // `parseWarnings` is captured in closure so the parse callback can
  // surface citation-stripping signals up to the envelope.
  const parseWarnings: string[] = [];

  const envelope = await runTool<CorpusAnswerResult>({
    tool: "ollama_corpus_answer",
    tier: "deep",
    ctx,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input.question, hits, maxWords),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: Math.ceil(maxWords * 2.5),
      },
    }),
    parse: (raw): CorpusAnswerResult => {
      const parsed = parseModelOutput(raw);
      const { valid, stripped } = validateAndMapCitations(parsed.citations, hits);
      const coverage = computeCoverage(hits, valid, weak, stripped);
      if (stripped > 0) {
        parseWarnings.push(
          `Stripped ${stripped} citation number(s) not in [1, ${hits.length}]`,
        );
      }
      if (parsed.citations.length === 0 && parsed.answer.length > 0) {
        parseWarnings.push(
          "Model produced an answer with no structured citations; coverage may be understated.",
        );
      }
      return {
        answer: parsed.answer,
        citations: valid,
        covered_sources: coverage.covered,
        omitted_sources: coverage.omitted,
        coverage_notes: coverage.notes,
        mode,
        retrieval: {
          retrieved: hits.length,
          total_in_corpus: totalInCorpus,
          top_score: topScore,
          weak,
        },
      };
    },
  });

  if (parseWarnings.length > 0) {
    envelope.warnings = [...(envelope.warnings ?? []), ...parseWarnings];
    await ctx.logger.log({
      kind: "guardrail",
      ts: timestamp(),
      tool: "ollama_corpus_answer",
      rule: "citations",
      action: "stripped",
      detail: { warnings: parseWarnings.length },
    });
  }

  return envelope;
}
