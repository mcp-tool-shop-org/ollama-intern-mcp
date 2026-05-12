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
  frame: z.string().optional().describe("The question / section purpose / topic this summary is FOR. When supplied, the summarizer first decides whether the text addresses the frame; if not, it refuses to paraphrase off-topic content and surfaces `on_topic: false` in the result."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional per-call model override. When provided, overrides the " +
        "tool's tier-resolved model for this call. The tier's timeout " +
        "(TIER_TIMEOUT_MS) still applies. On timeout, fallback uses the " +
        "tier-resolved model, NOT the override. Use for receipt-backed " +
        "orchestration that requires explicit model identity (e.g., " +
        "research-os reviewer profiles).",
    ),
});

export type SummarizeFastInput = z.infer<typeof summarizeFastSchema>;

export interface SummarizeResult {
  summary: string;
  source_preview: string;
  source_chars: number;
  /** Present only when `frame` was supplied as input. Null when the model output couldn't be parsed for the on-topic decision. */
  on_topic?: boolean | null;
}

function buildPrompt(input: SummarizeFastInput): string {
  const maxWords = input.max_words ?? 80;
  const lines = [
    `You are a fast summarizer. Return only the summary — no preamble, no trailing commentary.`,
    `Write at most ${maxWords} words. Preserve concrete facts; drop filler.`,
  ];
  if (input.frame !== undefined) {
    lines.push(
      ``,
      `Frame: ${input.frame}`,
      `If the text does not address the frame, return summary as a single sentence "(off-topic for frame: ...)" with a brief reason and DO NOT continue summarizing the off-topic content.`,
      `Return JSON only in this exact shape: {"on_topic": true|false, "summary": "..."}`,
    );
  }
  lines.push(``, `Text:`, input.text);
  return lines.join("\n");
}

interface ParsedFrameSummary {
  on_topic: boolean | null;
  summary: string;
}

function parseFrameSummary(raw: string): ParsedFrameSummary {
  const trimmed = raw.trim();
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const summary = typeof obj.summary === "string" ? obj.summary : trimmed;
      const onTopic = typeof obj.on_topic === "boolean" ? obj.on_topic : null;
      return { on_topic: onTopic, summary };
    }
  } catch {
    // fall through
  }
  // Heuristic fallback: "(off-topic for frame: …)" pattern.
  if (/^\(?off-topic for frame:/i.test(trimmed)) {
    return { on_topic: false, summary: trimmed };
  }
  return { on_topic: null, summary: trimmed };
}

export async function handleSummarizeFast(
  input: SummarizeFastInput,
  ctx: RunContext,
): Promise<Envelope<SummarizeResult>> {
  const maxWords = input.max_words ?? 80;
  const frameSupplied = input.frame !== undefined;
  return runTool<SummarizeResult>({
    tool: "ollama_summarize_fast",
    tier: "instant",
    ctx,
    think: false,
    modelOverride: input.model,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input),
      ...(frameSupplied ? { format: "json" as const } : {}),
      options: { temperature: TEMPERATURE_BY_SHAPE.summarize, num_predict: Math.ceil(maxWords * 2.5) },
    }),
    parse: (raw): SummarizeResult => {
      const base: SummarizeResult = {
        summary: raw.trim(),
        source_preview: input.text.slice(0, 200),
        source_chars: input.text.length,
      };
      if (!frameSupplied) return base;
      const parsed = parseFrameSummary(raw);
      base.summary = parsed.summary;
      base.on_topic = parsed.on_topic;
      return base;
    },
  });
}
