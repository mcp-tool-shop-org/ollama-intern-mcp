/**
 * ollama_extract — schema-constrained JSON extraction. Tier: Workhorse.
 * Uses Ollama's format: "json" mode. Returns {error: "unparseable"} when
 * the model's output doesn't round-trip through the caller's schema.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import type { Logger } from "../observability.js";
import type { OllamaClient } from "../ollama.js";
import { TEMPERATURE_BY_SHAPE, type TierConfig } from "../tiers.js";
import { runTool } from "./runner.js";

export const extractSchema = z.object({
  text: z.string().min(1).describe("Text to extract structured data from."),
  schema: z.record(z.unknown()).describe("JSONSchema the output must conform to."),
  hint: z.string().optional().describe("Optional field-by-field hint."),
});

export type ExtractInput = z.infer<typeof extractSchema>;

export type ExtractResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: "unparseable"; raw: string };

function buildPrompt(input: ExtractInput): string {
  const schemaStr = JSON.stringify(input.schema, null, 2);
  const hint = input.hint ? `\nHint: ${input.hint}` : "";
  return [
    `You are a structured extractor. Read the text and return JSON conforming to this schema:`,
    schemaStr,
    `Return JSON only — no prose, no markdown fences.${hint}`,
    `If a field is not present in the text, use null or omit the field per the schema.`,
    ``,
    `Text:`,
    input.text,
  ].join("\n");
}

function parse(raw: string): ExtractResult {
  try {
    const obj = JSON.parse(raw.trim());
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return { ok: true, data: obj as Record<string, unknown> };
    }
    return { ok: false, error: "unparseable", raw };
  } catch {
    return { ok: false, error: "unparseable", raw };
  }
}

export async function handleExtract(
  input: ExtractInput,
  deps: { client: OllamaClient; tierConfig: TierConfig; logger: Logger },
): Promise<Envelope<ExtractResult>> {
  return runTool<ExtractResult>({
    tool: "ollama_extract",
    tier: "workhorse",
    tierConfig: deps.tierConfig,
    client: deps.client,
    logger: deps.logger,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input),
      format: "json",
      options: { temperature: TEMPERATURE_BY_SHAPE.extract, num_predict: 1024 },
    }),
    parse,
  });
}
