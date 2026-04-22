/**
 * ollama_summarize_deep — digest of long input with optional focus.
 * Tier: Deep.
 *
 * Accepts EITHER `text` (caller already has the content) OR `source_paths[]`
 * (server reads + chunks locally, preserving Claude context). This matches
 * the source-based shape of ollama_research and restores the context-saving
 * thesis — the caller does NOT have to pre-read the file to summarize it.
 *
 * Exactly one of {text, source_paths} must be provided.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import type { SummarizeResult } from "./summarizeFast.js";
import { loadSources, formatSourcesBlock, type LoadedSource } from "../sources.js";
import { detectCoverage, type CoverageReport } from "../coverage.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

/**
 * Base object shape — what McpServer.tool() registers for Claude.
 * Mutual-exclusion between `text` and `source_paths` is enforced in the
 * handler, because McpServer.tool() needs a ZodRawShape (not ZodEffects)
 * for its input-schema parameter.
 */
export const summarizeDeepSchema = z.object({
  text: z.string().min(1).optional().describe("Raw text to digest. Use this when you already have the content in hand."),
  source_path: z
    .string()
    .min(1)
    .optional()
    .describe("A single file path to read + chunk server-side. Shortcut for `source_paths: [one]` — use whichever reads more naturally. Closes adoption SEAM #2 (large single-file summaries no longer force Claude to pre-read the file)."),
  source_paths: strictStringArray({ min: 1, fieldName: "source_paths" })
    .optional()
    .describe("File paths to read + chunk server-side. Use this instead of `text` to save Claude context — the tool reads the files, Claude never sees the raw content."),
  focus: z.string().optional().describe("Optional aspect to emphasize (e.g. 'combat doctrine', 'auth flow')."),
  max_words: z.number().int().min(20).max(1500).optional().describe("Target digest length in words (default 250)."),
  per_file_max_chars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .describe("Chars to read per file when source_paths is used (default 40k)."),
});

export type SummarizeDeepInput = z.infer<typeof summarizeDeepSchema>;

function assertExactlyOneSource(input: SummarizeDeepInput): void {
  const given =
    (input.text ? 1 : 0) +
    (input.source_paths ? 1 : 0) +
    (input.source_path ? 1 : 0);
  if (given !== 1) {
    throw new InternError(
      "SCHEMA_INVALID",
      `ollama_summarize_deep: provide exactly one of "text", "source_path", or "source_paths" (given ${given}).`,
      "Pass text for raw content, source_path for a single file, or source_paths for multiple. Not combined, not none.",
      false,
    );
  }
}

function buildPrompt(input: SummarizeDeepInput, body: string): string {
  const maxWords = input.max_words ?? 250;
  const focus = input.focus ? `Emphasize this aspect above all others: ${input.focus}` : `Cover the whole document.`;
  return [
    `You are a deep reader. Produce a faithful digest of the text below.`,
    `Return only the digest — no preamble, no meta-commentary.`,
    `Length: at most ${maxWords} words.`,
    focus,
    `Preserve specific names, numbers, and decisions. Drop filler.`,
    ``,
    `Text:`,
    body,
  ].join("\n");
}

/** Result of summarize_deep — extended with coverage when source_paths was used. */
export interface SummarizeDeepResult extends SummarizeResult {
  covered_sources?: string[];
  omitted_sources?: string[];
  coverage_notes?: string[];
}

export async function handleSummarizeDeep(
  input: SummarizeDeepInput,
  ctx: RunContext,
): Promise<Envelope<SummarizeDeepResult>> {
  assertExactlyOneSource(input);
  const maxWords = input.max_words ?? 250;
  const perFileMax = input.per_file_max_chars ?? 40_000;

  // Resolve body + preview from whichever input mode the caller used.
  let body: string;
  let sourcePreview: string;
  let sourceChars: number;
  let sources: LoadedSource[] | null = null;

  if (input.source_paths || input.source_path) {
    // Normalize both shapes to the loader's array input — source_path is just
    // a single-file alias so callers don't have to wrap in brackets.
    const paths = input.source_paths ?? [input.source_path as string];
    sources = await loadSources(paths, perFileMax);
    body = formatSourcesBlock(sources);
    sourcePreview = sources[0]?.body.slice(0, 200) ?? "";
    sourceChars = sources.reduce((n, s) => n + s.body.length, 0);
  } else {
    body = input.text as string;
    sourcePreview = body.slice(0, 200);
    sourceChars = body.length;
  }

  return runTool<SummarizeDeepResult>({
    tool: "ollama_summarize_deep",
    tier: "deep",
    ctx,
    think: false,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input, body),
      options: { temperature: TEMPERATURE_BY_SHAPE.summarize, num_predict: Math.ceil(maxWords * 2.5) },
    }),
    parse: (raw): SummarizeDeepResult => {
      const summary = raw.trim();
      const base: SummarizeDeepResult = {
        summary,
        source_preview: sourcePreview,
        source_chars: sourceChars,
      };
      // Coverage only makes sense for multi-source path-based calls.
      // Single source or raw-text input: skip — no omission risk to surface.
      if (sources && sources.length >= 2) {
        const cov: CoverageReport = detectCoverage(summary, sources);
        base.covered_sources = cov.covered_sources;
        base.omitted_sources = cov.omitted_sources;
        if (cov.coverage_notes.length > 0) base.coverage_notes = cov.coverage_notes;
      }
      return base;
    },
  });
}
