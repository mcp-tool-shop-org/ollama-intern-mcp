/**
 * ollama_triage_logs — stable-shape log digest: errors, warnings, suspected root cause.
 * Tier: Instant.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import type { Logger } from "../observability.js";
import type { OllamaClient } from "../ollama.js";
import { TEMPERATURE_BY_SHAPE, type TierConfig } from "../tiers.js";
import { runTool } from "./runner.js";

export const triageLogsSchema = z.object({
  log_text: z.string().min(1).describe("Raw log output to triage."),
  patterns: z.array(z.string()).optional().describe("Optional regex patterns the triage should bias toward."),
});

export type TriageLogsInput = z.infer<typeof triageLogsSchema>;

export interface TriageLogsResult {
  errors: string[];
  warnings: string[];
  suspected_root_cause?: string;
}

function buildPrompt(input: TriageLogsInput): string {
  const patterns = input.patterns && input.patterns.length > 0
    ? `\nPay particular attention to these patterns: ${input.patterns.join(", ")}`
    : "";
  return [
    `You are a log triage assistant. If the input is not a log, reply exactly: {"errors": [], "warnings": [], "suspected_root_cause": "NOT_A_LOG"}.`,
    `Return JSON in exactly this shape:`,
    `{"errors": ["..."], "warnings": ["..."], "suspected_root_cause": "..."}`,
    `- errors: one string per distinct error (deduplicated, no stack traces)`,
    `- warnings: one string per distinct warning`,
    `- suspected_root_cause: one sentence or null`,
    patterns,
    ``,
    `Log:`,
    input.log_text,
  ].join("\n");
}

function parse(raw: string): TriageLogsResult {
  try {
    const obj = JSON.parse(raw.trim());
    return {
      errors: Array.isArray(obj.errors) ? obj.errors.filter((x: unknown) => typeof x === "string") : [],
      warnings: Array.isArray(obj.warnings) ? obj.warnings.filter((x: unknown) => typeof x === "string") : [],
      ...(typeof obj.suspected_root_cause === "string" ? { suspected_root_cause: obj.suspected_root_cause } : {}),
    };
  } catch {
    return { errors: [], warnings: [] };
  }
}

export async function handleTriageLogs(
  input: TriageLogsInput,
  deps: { client: OllamaClient; tierConfig: TierConfig; logger: Logger },
): Promise<Envelope<TriageLogsResult>> {
  return runTool<TriageLogsResult>({
    tool: "ollama_triage_logs",
    tier: "instant",
    tierConfig: deps.tierConfig,
    client: deps.client,
    logger: deps.logger,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input),
      format: "json",
      options: { temperature: TEMPERATURE_BY_SHAPE.triage, num_predict: 512 },
    }),
    parse,
  });
}
