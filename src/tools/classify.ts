/**
 * ollama_classify — single-label classification with confidence.
 * Tier: Instant.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { applyConfidenceThreshold, type ClassifyGuarded } from "../guardrails/confidence.js";
import type { RunContext } from "../runContext.js";

export const classifySchema = z.object({
  text: z.string().min(1).describe("The text to classify."),
  labels: z.array(z.string().min(1)).min(2).describe("Candidate labels — the model picks exactly one, or null if allow_none."),
  allow_none: z.boolean().optional().describe("If true and confidence < threshold, return label=null instead of a weak guess."),
  threshold: z.number().min(0).max(1).optional().describe("Confidence floor (default 0.7)."),
});

export type ClassifyInput = z.infer<typeof classifySchema>;

function buildPrompt(input: ClassifyInput): string {
  const labels = input.labels.map((l) => `"${l}"`).join(", ");
  return [
    `You are a classifier. Pick exactly one label from this set: [${labels}].`,
    input.allow_none
      ? `If no label fits with high confidence, return label: null.`
      : `You must pick one of the provided labels.`,
    `Return only JSON in this exact shape: {"label": "...", "confidence": 0.0}`,
    `Confidence is your estimate in [0, 1] that the label is correct.`,
    ``,
    `Text:`,
    input.text,
  ].join("\n");
}

function parseClassify(raw: string): { label: string | null; confidence: number } {
  try {
    const obj = JSON.parse(raw.trim());
    const label = typeof obj.label === "string" ? obj.label : null;
    const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
    return { label, confidence: Math.max(0, Math.min(1, confidence)) };
  } catch {
    return { label: null, confidence: 0 };
  }
}

export async function handleClassify(
  input: ClassifyInput,
  ctx: RunContext,
): Promise<Envelope<ClassifyGuarded>> {
  return runTool<ClassifyGuarded>({
    tool: "ollama_classify",
    tier: "instant",
    ctx,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input),
      format: "json",
      options: { temperature: TEMPERATURE_BY_SHAPE.classify, num_predict: 64 },
    }),
    parse: (raw) => applyConfidenceThreshold(parseClassify(raw), { threshold: input.threshold, allow_none: input.allow_none }),
  });
}
