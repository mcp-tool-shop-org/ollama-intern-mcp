/**
 * ollama_research — FLAGSHIP TOOL.
 *
 * Takes file *paths*, not raw text. Reads and chunks locally, returns a
 * digest with validated citations. This is context preservation as a
 * product feature — exactly the bulk work Claude should not burn
 * premium context on.
 *
 * Tier: Deep.
 *
 * Guardrails:
 * - All paths in source_paths must exist (SOURCE_PATH_NOT_FOUND otherwise)
 * - Citations returned by the model are validated against source_paths;
 *   any path not in the input is stripped and a warning added to the envelope.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { parseCitations, validateCitations, type ValidatedCitation } from "../guardrails/citations.js";
import { timestamp } from "../observability.js";
import { loadSources, formatSourcesBlock, type LoadedSource } from "../sources.js";
import { detectCoverage } from "../coverage.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import type { RunContext } from "../runContext.js";

export const researchSchema = z.object({
  question: z.string().min(1).describe("The question to answer."),
  source_paths: strictStringArray({ min: 1, fieldName: "source_paths" }).describe("Files the answer must be grounded in. Nothing outside this list is allowed as a source."),
  max_words: z.number().int().min(20).max(1500).optional().describe("Target answer length in words (default 300)."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars to read per file (default 40k)."),
});

export type ResearchInput = z.infer<typeof researchSchema>;

export interface ResearchResult {
  answer: string;
  citations: ValidatedCitation[];
  covered_sources?: string[];
  omitted_sources?: string[];
  coverage_notes?: string[];
}

function buildPrompt(input: ResearchInput, sources: LoadedSource[]): string {
  const maxWords = input.max_words ?? 300;
  const blocks = formatSourcesBlock(sources);
  return [
    `You are a grounded research assistant. Answer ONLY from the source files below.`,
    `Never invent facts. If the sources do not contain the answer, say so.`,
    ``,
    `Write your answer in at most ${maxWords} words, then a "Sources:" block listing`,
    `the files you used, one per line as: <path>:<line_range> (line_range optional).`,
    `Do not cite any file not in the provided source list.`,
    ``,
    `Question: ${input.question}`,
    ``,
    `Sources:`,
    blocks,
  ].join("\n");
}

function splitAnswerAndSources(raw: string): { answer: string; sources: string } {
  const idx = raw.search(/\n\s*Sources?:\s*/i);
  if (idx === -1) return { answer: raw.trim(), sources: "" };
  return { answer: raw.slice(0, idx).trim(), sources: raw.slice(idx) };
}

export async function handleResearch(
  input: ResearchInput,
  ctx: RunContext,
): Promise<Envelope<ResearchResult>> {
  const perFileMax = input.per_file_max_chars ?? 40_000;
  const sources = await loadSources(input.source_paths, perFileMax);
  const warnings: string[] = [];

  const envelope = await runTool<ResearchResult>({
    tool: "ollama_research",
    tier: "deep",
    ctx,
    logInput: input,
    think: true,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input, sources),
      options: { temperature: TEMPERATURE_BY_SHAPE.research, num_predict: Math.ceil((input.max_words ?? 300) * 2.5) },
    }),
    parse: (raw): ResearchResult => {
      const { answer, sources: sourcesBlock } = splitAnswerAndSources(raw);
      const parsed = parseCitations(sourcesBlock);
      const { valid, stripped } = validateCitations(parsed, input.source_paths);
      if (stripped.length > 0) {
        warnings.push(`Stripped ${stripped.length} citation(s) not in source_paths: ${stripped.map((c) => c.path).join(", ")}`);
      }
      const base: ResearchResult = { answer, citations: valid };
      // Coverage only meaningful with multiple sources — one-source research
      // either cites or doesn't, and the citation check already covers it.
      if (sources.length >= 2) {
        const cov = detectCoverage(answer, sources, {
          explicitlyCovered: valid.map((c) => c.path),
        });
        base.covered_sources = cov.covered_sources;
        base.omitted_sources = cov.omitted_sources;
        if (cov.coverage_notes.length > 0) base.coverage_notes = cov.coverage_notes;
      }
      return base;
    },
  });

  if (warnings.length > 0) {
    envelope.warnings = [...(envelope.warnings ?? []), ...warnings];
    await ctx.logger.log({
      kind: "guardrail",
      ts: timestamp(),
      tool: "ollama_research",
      rule: "citations",
      action: "stripped",
      detail: { count: warnings.length },
    });
  }

  return envelope;
}
