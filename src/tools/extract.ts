/**
 * ollama_extract — schema-constrained JSON extraction. Tier: Workhorse.
 * Uses Ollama's format: "json" mode. Returns {error: "unparseable"} when
 * the model's output doesn't round-trip through the caller's schema.
 *
 * Two input modes:
 *   - `text`  : single extraction, returns {ok: true, data} | {ok: false, error}
 *   - `items` : batch, returns {result.items[]: [{id, ok, result|error}]}
 *     with one shared envelope. Unique caller-provided ids required per item.
 *
 * Exactly one of {text, items} must be provided.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { runBatch, type BatchResult } from "./batch.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const extractSchema = z.object({
  text: z.string().min(1).optional().describe("Text to extract structured data from. Use this OR items, not both."),
  items: z
    .array(
      z.object({
        id: z.string().min(1).describe("Caller-provided, unique within the batch."),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .optional()
    .describe("Batch of texts to extract from, each with a stable id. Returns one batch envelope with per-item {id, ok, result|error} entries."),
  schema: z.record(z.unknown()).describe("JSONSchema the output must conform to — shared across all items in a batch."),
  hint: z.string().optional().describe("Optional field-by-field hint."),
});

export type ExtractInput = z.infer<typeof extractSchema>;

export type ExtractResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: "unparseable"; raw: string };

function buildPromptFor(text: string, schema: Record<string, unknown>, hint?: string): string {
  const schemaStr = JSON.stringify(schema, null, 2);
  const hintLine = hint ? `\nHint: ${hint}` : "";
  return [
    `You are a structured extractor. Read the text and return JSON conforming to this schema:`,
    schemaStr,
    `Return JSON only — no prose, no markdown fences.${hintLine}`,
    `If a field is not present in the text, use null or omit the field per the schema.`,
    ``,
    `Text:`,
    text,
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

function assertExactlyOneInput(input: ExtractInput): void {
  const given = (input.text !== undefined ? 1 : 0) + (input.items !== undefined ? 1 : 0);
  if (given !== 1) {
    throw new InternError(
      "SCHEMA_INVALID",
      `ollama_extract: provide exactly one of "text" or "items" (given ${given}).`,
      "Pass text for a single call, or items:[{id,text}] for a batch. Not both, not neither.",
      false,
    );
  }
}

export async function handleExtract(
  input: ExtractInput,
  ctx: RunContext,
): Promise<Envelope<ExtractResult> | Envelope<BatchResult<ExtractResult>>> {
  assertExactlyOneInput(input);

  if (input.items) {
    return runBatch<{ id: string; text: string }, ExtractResult>({
      tool: "ollama_extract",
      tier: "workhorse",
      ctx,
      items: input.items,
      build: (item, _tier, model) => ({
        model,
        prompt: buildPromptFor(item.text, input.schema, input.hint),
        format: "json",
        options: { temperature: TEMPERATURE_BY_SHAPE.extract, num_predict: 1024 },
      }),
      parse,
    });
  }

  const text = input.text as string;
  return runTool<ExtractResult>({
    tool: "ollama_extract",
    tier: "workhorse",
    ctx,
    build: (_tier, model) => ({
      model,
      prompt: buildPromptFor(text, input.schema, input.hint),
      format: "json",
      options: { temperature: TEMPERATURE_BY_SHAPE.extract, num_predict: 1024 },
    }),
    parse,
  });
}
