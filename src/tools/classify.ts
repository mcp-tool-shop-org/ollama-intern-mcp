/**
 * ollama_classify — single-label classification with confidence.
 * Tier: Instant.
 *
 * Three input modes (exactly one):
 *   - `text`        : single text, classified directly
 *   - `source_path` : single file, read + classified server-side — caller
 *                     never pre-reads the file (context preservation)
 *   - `items`       : batch of {id, text} — returns one batch envelope with
 *                     per-item {id, ok, result|error}
 *
 * Exactly one of {text, source_path, items} must be provided.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { runBatch, type BatchResult } from "./batch.js";
import { applyConfidenceThreshold, type ClassifyGuarded } from "../guardrails/confidence.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { loadSources } from "../sources.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const classifySchema = z.object({
  text: z.string().min(1).optional().describe("The single text to classify. Use this OR source_path OR items — exactly one."),
  source_path: z.string().min(1).optional().describe("A single file path to read + classify server-side. Use this instead of `text` to save Claude context — the server reads the file, Claude never sees its contents."),
  items: z
    .array(
      z.object({
        id: z.string().min(1).describe("Caller-provided, unique within the batch."),
        text: z.string().min(1),
      }),
    )
    .min(1)
    .optional()
    .describe("Batch of texts to classify. Each needs a stable caller-provided id so results join back to source inputs cleanly. Returns one batch envelope with per-item {id, ok, result|error} entries."),
  labels: strictStringArray({ min: 2, fieldName: "labels" }).describe("Candidate labels — the model picks exactly one, or null if allow_none."),
  allow_none: z.boolean().optional().describe("If true and confidence < threshold, return label=null instead of a weak guess."),
  threshold: z.number().min(0).max(1).optional().describe("Confidence floor (default 0.7)."),
  frame: z.string().optional().describe("The question / section purpose / topic this classification is FOR. When supplied, the model first determines on/off-topic for the frame, then picks a label only within that frame. Off-topic inputs return label=null with off_topic=true regardless of label fit."),
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
});

export type ClassifyInput = z.infer<typeof classifySchema>;

export interface ClassifyGuardedWithFrame extends ClassifyGuarded {
  off_topic?: boolean;
  off_topic_reason?: string | null;
}

function buildPromptFor(text: string, input: ClassifyInput): string {
  const labels = input.labels.map((l) => `"${l}"`).join(", ");
  const lines = [
    `You are a classifier. Pick exactly one label from this set: [${labels}].`,
    input.allow_none
      ? `If no label fits with high confidence, return label: null.`
      : `You must pick one of the provided labels.`,
  ];
  if (input.frame !== undefined) {
    lines.push(
      `These labels apply ONLY within the frame: ${input.frame}.`,
      `If the source is off-topic for the frame, return label: null and set off_topic: true regardless of how well one of the labels fits in isolation. Do not pick a label just because the words rhyme.`,
      `Return only JSON in this exact shape: {"label": "...", "confidence": 0.0, "off_topic": false, "off_topic_reason": null}`,
    );
  } else {
    lines.push(`Return only JSON in this exact shape: {"label": "...", "confidence": 0.0}`);
  }
  lines.push(
    `Confidence is your estimate in [0, 1] that the label is correct.`,
    ``,
    `Text:`,
    text,
  );
  return lines.join("\n");
}

interface ClassifyRawFromModel {
  label: string | null;
  confidence: number;
  off_topic?: boolean;
  off_topic_reason?: string | null;
}

function parseClassify(raw: string): ClassifyRawFromModel {
  try {
    const obj = JSON.parse(raw.trim());
    const label = typeof obj.label === "string" ? obj.label : null;
    const confidence = typeof obj.confidence === "number" ? obj.confidence : 0;
    const out: ClassifyRawFromModel = { label, confidence: Math.max(0, Math.min(1, confidence)) };
    if (typeof obj.off_topic === "boolean") out.off_topic = obj.off_topic;
    if (typeof obj.off_topic_reason === "string" || obj.off_topic_reason === null) {
      out.off_topic_reason = obj.off_topic_reason ?? null;
    }
    return out;
  } catch {
    return { label: null, confidence: 0 };
  }
}

function applyFrameAlignment(
  guarded: ClassifyGuarded,
  rawParsed: ClassifyRawFromModel,
  frameSupplied: boolean,
): ClassifyGuardedWithFrame {
  if (!frameSupplied) return guarded;
  const offTopic = rawParsed.off_topic === true;
  const out: ClassifyGuardedWithFrame = {
    ...guarded,
    off_topic: offTopic,
    off_topic_reason: rawParsed.off_topic_reason ?? null,
  };
  // When off_topic, null out the label regardless of allow_none — off-topic ≠ low confidence.
  if (offTopic) out.label = null;
  return out;
}

function assertExactlyOneInput(input: ClassifyInput): void {
  const given =
    (input.text !== undefined ? 1 : 0) +
    (input.source_path !== undefined ? 1 : 0) +
    (input.items !== undefined ? 1 : 0);
  if (given !== 1) {
    throw new InternError(
      "SCHEMA_INVALID",
      `ollama_classify: provide exactly one of "text", "source_path", or "items" (given ${given}).`,
      "Pass text for a single call, source_path to read a file server-side, or items:[{id,text}] for a batch.",
      false,
    );
  }
}

export async function handleClassify(
  input: ClassifyInput,
  ctx: RunContext,
): Promise<Envelope<ClassifyGuardedWithFrame> | Envelope<BatchResult<ClassifyGuardedWithFrame>>> {
  assertExactlyOneInput(input);
  const frameSupplied = input.frame !== undefined;
  const parseOne = (raw: string): ClassifyGuardedWithFrame => {
    const rawParsed = parseClassify(raw);
    const guarded = applyConfidenceThreshold(rawParsed, {
      threshold: input.threshold,
      allow_none: input.allow_none,
    });
    return applyFrameAlignment(guarded, rawParsed, frameSupplied);
  };

  if (input.items) {
    return runBatch<{ id: string; text: string }, ClassifyGuardedWithFrame>({
      tool: "ollama_classify",
      tier: "instant",
      ctx,
      think: false,
      items: input.items,
      modelOverride: input.model,
      build: (item, _tier, model) => ({
        model,
        prompt: buildPromptFor(item.text, input),
        format: "json",
        options: { temperature: TEMPERATURE_BY_SHAPE.classify, num_predict: 64 },
      }),
      parse: parseOne,
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
  return runTool<ClassifyGuardedWithFrame>({
    tool: "ollama_classify",
    tier: "instant",
    ctx,
    think: false,
    modelOverride: input.model,
    build: (_tier, model) => ({
      model,
      prompt: buildPromptFor(text, input),
      format: "json",
      options: { temperature: TEMPERATURE_BY_SHAPE.classify, num_predict: 64 },
    }),
    parse: parseOne,
  });
}
