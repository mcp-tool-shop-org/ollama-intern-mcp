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
  schema: z.record(z.string(), z.unknown()).describe("JSONSchema the output must conform to — shared across all items in a batch."),
  hint: z.string().optional().describe("Optional field-by-field hint."),
  frame: z.string().optional().describe("The question / section purpose / topic this extraction is FOR. When supplied, the model first determines on/off-topic, then extracts only fields the source addresses for that frame."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars to read when source_path is used (default 40k)."),
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
  // R-019 (v2.6.0) — per-call tier-budget override.
  //
  // Replaces the active profile's per-tier `timeouts` budget for THIS call
  // only. Applies to the initial tier AND any fallback tier the cascade
  // visits. Other callers and other tool invocations are unaffected.
  //
  // Default behavior (field omitted) preserves the profile's per-tier
  // timeouts byte-identically — pre-R-019 callers see no change.
  //
  // Motivating use case: research-os synth prose `--planner-timeout-ms`
  // (R-018) needs to reach the inner mechanism. The R-018 wrapper sits
  // outside the MCP call and never sees structured TIER_TIMEOUT responses;
  // research-os now passes its operator-supplied budget here so the per-tier
  // guardrail (runWithTimeoutAndFallback) honors the operator's intent.
  //
  // Bounds: [1, 600_000] (10-minute safety rail against typo runaway).
  tier_budget_ms_override: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe(
      "Optional per-call tier-budget override in milliseconds. When set, " +
        "this value replaces the active profile's per-tier timeouts for " +
        "THIS call only (both initial tier and any fallback tier visited). " +
        "Other callers and tool invocations are unaffected. Omit to use " +
        "the profile defaults (byte-identical to pre-R-019 behavior). " +
        "Bounds: [1, 600000]. Use for client-orchestrated synth flows " +
        "(e.g., research-os --planner-timeout-ms) where the operator's " +
        "budget must reach the inner tier guardrail.",
    ),
});

export type ExtractInput = z.infer<typeof extractSchema>;

export interface FrameAlignment {
  on_topic: boolean;
  reason: string;
  unaddressed_aspects?: string[];
}

export type ExtractResult =
  | { ok: true; data: Record<string, unknown>; frame_alignment?: FrameAlignment }
  | { ok: false; error: "unparseable"; raw: string };

function buildPromptFor(text: string, schema: Record<string, unknown>, hint?: string, frame?: string): string {
  const schemaStr = JSON.stringify(schema, null, 2);
  const hintLine = hint ? `\nHint: ${hint}` : "";
  const lines = [
    `You are a structured extractor. Read the text and return JSON conforming to this schema:`,
    schemaStr,
    `Return JSON only — no prose, no markdown fences.${hintLine}`,
    `If a field is not present in the text, use null or omit the field per the schema.`,
  ];
  if (frame !== undefined) {
    lines.push(
      ``,
      `Frame: ${frame}`,
      `Before extracting, judge whether the source addresses this frame. If it does not, return _frame_alignment: { on_topic: false, reason: "..." } and either null-fill content fields per schema OR (preferred) return an empty data shape conforming to the caller's schema. Do not paraphrase off-topic content to fill the schema. When the source DOES address the frame, include _frame_alignment: { on_topic: true, reason: "..." } alongside the extracted fields, and only extract values the source actually supplies for the frame.`,
    );
  }
  lines.push(``, `Text:`, text);
  return lines.join("\n");
}

/** Lift `_frame_alignment` out of the parsed object and validate its shape. */
function liftFrameAlignment(
  data: Record<string, unknown>,
): { data: Record<string, unknown>; frame_alignment?: FrameAlignment; warning?: string } {
  if (!("_frame_alignment" in data)) {
    return { data };
  }
  const raw = data._frame_alignment;
  const { _frame_alignment: _ignored, ...rest } = data;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      data: rest,
      warning: "ollama_extract: _frame_alignment present but not an object — discarded.",
    };
  }
  const candidate = raw as Record<string, unknown>;
  const onTopic = candidate.on_topic;
  const reason = candidate.reason;
  if (typeof onTopic !== "boolean" || typeof reason !== "string") {
    return {
      data: rest,
      warning: "ollama_extract: _frame_alignment is missing required {on_topic: boolean, reason: string} — discarded.",
    };
  }
  const fa: FrameAlignment = { on_topic: onTopic, reason };
  const aspects = candidate.unaddressed_aspects;
  if (Array.isArray(aspects) && aspects.every((a) => typeof a === "string")) {
    fa.unaddressed_aspects = aspects as string[];
  }
  return { data: rest, frame_alignment: fa };
}

function parseFactory(frameSupplied: boolean, warnings: string[]) {
  return function parse(raw: string): ExtractResult {
    try {
      const obj = JSON.parse(raw.trim());
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const asObj = obj as Record<string, unknown>;
        if (frameSupplied) {
          const lifted = liftFrameAlignment(asObj);
          if (lifted.warning) warnings.push(lifted.warning);
          const out: ExtractResult = { ok: true, data: lifted.data };
          if (lifted.frame_alignment) out.frame_alignment = lifted.frame_alignment;
          return out;
        }
        return { ok: true, data: asObj };
      }
      return { ok: false, error: "unparseable", raw };
    } catch {
      return { ok: false, error: "unparseable", raw };
    }
  };
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
  const frameSupplied = input.frame !== undefined;
  const warnings: string[] = [];
  const parse = parseFactory(frameSupplied, warnings);

  if (input.items) {
    const env = await runBatch<{ id: string; text: string }, ExtractResult>({
      tool: "ollama_extract",
      tier: "workhorse",
      ctx,
      think: false,
      items: input.items,
      modelOverride: input.model,
      // R-019 — propagate per-call tier-budget override into the runner so the
      // inner runWithTimeoutAndFallback honors the operator's budget.
      tierBudgetMsOverride: input.tier_budget_ms_override,
      build: (item, _tier, model) => ({
        model,
        prompt: buildPromptFor(item.text, input.schema, input.hint, input.frame),
        format: "json",
        options: { temperature: TEMPERATURE_BY_SHAPE.extract, num_predict: 1024 },
      }),
      parse,
    });
    if (warnings.length > 0) env.warnings = [...(env.warnings ?? []), ...warnings];
    return env;
  }

  let text: string;
  if (input.source_path !== undefined) {
    const perFileMax = input.per_file_max_chars ?? 40_000;
    const [loaded] = await loadSources([input.source_path], perFileMax);
    text = loaded.body;
  } else {
    text = input.text as string;
  }
  const env = await runTool<ExtractResult>({
    tool: "ollama_extract",
    tier: "workhorse",
    ctx,
    think: false,
    modelOverride: input.model,
    // R-019 — propagate per-call tier-budget override into the runner so the
    // inner runWithTimeoutAndFallback honors the operator's budget.
    tierBudgetMsOverride: input.tier_budget_ms_override,
    build: (_tier, model) => ({
      model,
      prompt: buildPromptFor(text, input.schema, input.hint, input.frame),
      format: "json",
      options: { temperature: TEMPERATURE_BY_SHAPE.extract, num_predict: 1024 },
    }),
    parse,
  });
  if (warnings.length > 0) env.warnings = [...(env.warnings ?? []), ...warnings];
  return env;
}
