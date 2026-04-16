/**
 * ollama_summarize_deep — digest of long input (~32k tokens) with optional focus.
 * Tier: Deep.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import type { Logger } from "../observability.js";
import type { OllamaClient } from "../ollama.js";
import { TEMPERATURE_BY_SHAPE, type TierConfig } from "../tiers.js";
import { runTool } from "./runner.js";
import type { SummarizeResult } from "./summarizeFast.js";

export const summarizeDeepSchema = z.object({
  text: z.string().min(1).describe("Long text to digest. Best for inputs that would bloat Claude's context."),
  focus: z.string().optional().describe("Optional aspect to emphasize (e.g. 'combat doctrine', 'auth flow')."),
  max_words: z.number().int().min(20).max(1500).optional().describe("Target digest length in words (default 250)."),
});

export type SummarizeDeepInput = z.infer<typeof summarizeDeepSchema>;

function buildPrompt(input: SummarizeDeepInput): string {
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
    input.text,
  ].join("\n");
}

export async function handleSummarizeDeep(
  input: SummarizeDeepInput,
  deps: { client: OllamaClient; tierConfig: TierConfig; logger: Logger },
): Promise<Envelope<SummarizeResult>> {
  const maxWords = input.max_words ?? 250;
  return runTool<SummarizeResult>({
    tool: "ollama_summarize_deep",
    tier: "deep",
    tierConfig: deps.tierConfig,
    client: deps.client,
    logger: deps.logger,
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
