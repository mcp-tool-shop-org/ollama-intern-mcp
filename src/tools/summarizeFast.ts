/**
 * ollama_summarize_fast — gist of short input (~4k tokens).
 * Tier: Instant.
 *
 * Carries source_preview (first 200 chars) so Claude can spot-check
 * fabrication against real text, not trust the summary blind.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import type { RunContext } from "../runContext.js";

export const summarizeFastSchema = z.object({
  text: z.string().min(1).describe("Text to summarize (best under ~4k tokens — use summarize_deep for longer inputs)."),
  max_words: z.number().int().min(10).max(400).optional().describe("Target summary length in words (default 80)."),
});

export type SummarizeFastInput = z.infer<typeof summarizeFastSchema>;

export interface SummarizeResult {
  summary: string;
  source_preview: string;
  source_chars: number;
}

function buildPrompt(input: SummarizeFastInput): string {
  const maxWords = input.max_words ?? 80;
  return [
    `You are a fast summarizer. Return only the summary — no preamble, no trailing commentary.`,
    `Write at most ${maxWords} words. Preserve concrete facts; drop filler.`,
    ``,
    `Text:`,
    input.text,
  ].join("\n");
}

export async function handleSummarizeFast(
  input: SummarizeFastInput,
  ctx: RunContext,
): Promise<Envelope<SummarizeResult>> {
  const maxWords = input.max_words ?? 80;
  return runTool<SummarizeResult>({
    tool: "ollama_summarize_fast",
    tier: "instant",
    ctx,
    think: false,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input),
      options: { temperature: TEMPERATURE_BY_SHAPE.summarize, num_predict: Math.ceil(maxWords * 2.5) },
    }),
    parse: (raw) => ({
      summary: raw.trim(),
      source_preview: input.text.slice(0, 200),
      source_chars: input.text.length,
    }),
  });
}
