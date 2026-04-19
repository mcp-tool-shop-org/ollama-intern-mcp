/**
 * ollama_extract — schema-constrained JSON extraction. Tier: Workhorse.
 * Uses Ollama's format: "json" mode. Returns {error: "unparseable"} when
 * the model's output doesn't round-trip through the caller's schema.
 *
 * Three input modes (exactly one):
 *   - `text`        : single extraction from raw text
 *   - `source_path` : single file read + extracted server-side (context
 *                     preservation — caller never pre-reads the file)
 *   - `items`       : batch of {id, text}, one shared envelope with per-item
 *                     {id, ok, result|error}
 *
 * Exactly one of {text, source_path, items} must be provided.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { runBatch, type BatchResult } from "./batch.js";
import { loadSources } from "../sources.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const extractSchema = z.object({
  text: z.string().min(1).optional().describe("Text to extract structured data from. Use this OR source_path OR items — exactly one."),
  source_path: z.string().min(1).optional().describe("A single file path to read + extract from server-side. Use this instead of `text` to save Claude context — the server reads the file, Claude never sees its contents."),
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
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars to read when source_path is used (default 40k)."),
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
  const given =
    (input.text !== undefined ? 1 : 0) +
    (input.source_path !== undefined ? 1 : 0) +
    (input.items !== undefined ? 1 : 0);
  if (given !== 1) {
    throw new InternError(
      "SCHEMA_INVALID",
      `ollama_extract: provide exactly one of "text", "source_path", or "items" (given ${given}).`,
      "Pass text for a single call, source_path to read a file server-side, or items:[{id,text}] for a batch.",
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

  let text: string;
  if (input.source_path !== undefined) {
    const perFileMax = input.per_file_max_chars ?? 40_000;
    const [loaded] = await loadSources([input.source_path], perFileMax);
    text = loaded.body;
  } else {
    text = input.text as string;
  }
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
