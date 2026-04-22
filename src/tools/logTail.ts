/**
 * ollama_log_tail — structured tail of the NDJSON observability log (no-LLM).
 *
 * Reads the last N lines of ~/.ollama-intern/log.ndjson (override via
 * INTERN_LOG_PATH), parses each line as JSON, applies optional filters, and
 * returns a stable array of structured events. Truncated final lines are
 * skipped silently (the log is append-only and a concurrent writer can
 * leave a partial line at the tail).
 *
 * Missing log file is a soft-empty case: the tool returns 0 events without
 * an error — there's nothing wrong with "no activity yet."
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const logTailSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max events to return (newest first). Default 50, cap 500."),
  filter_kind: z
    .string()
    .optional()
    .describe("Keep only events with this kind — e.g. 'call', 'timeout', 'fallback', 'pack_step', 'semaphore:wait'."),
  filter_tool: z
    .string()
    .optional()
    .describe("Keep only events whose `tool` matches — e.g. 'ollama_research'."),
  since: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp. Keep only events with ts >= since. Invalid ISO → SCHEMA_INVALID."),
});

export type LogTailInput = z.infer<typeof logTailSchema>;

export interface LogTailResult {
  events: Array<Record<string, unknown>>;
  total_returned: number;
  log_path: string;
  log_present: boolean;
}

function defaultLogPath(): string {
  return process.env.INTERN_LOG_PATH || join(homedir(), ".ollama-intern", "log.ndjson");
}

function parseSince(s: string | undefined): number | null {
  if (s === undefined) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Invalid ISO timestamp for 'since': ${s}`,
      "Pass an ISO-8601 string like 2026-04-17T00:00:00Z, or omit the field.",
      false,
    );
  }
  return d.getTime();
}

export async function handleLogTail(
  input: LogTailInput,
  ctx: RunContext,
): Promise<Envelope<LogTailResult>> {
  const startedAt = Date.now();
  const limit = input.limit ?? 50;
  const since = parseSince(input.since);
  const logPath = defaultLogPath();

  if (!existsSync(logPath)) {
    const result: LogTailResult = {
      events: [],
      total_returned: 0,
      log_path: logPath,
      log_present: false,
    };
    const envelope = buildEnvelope<LogTailResult>({
      result,
      tier: "instant",
      model: "",
      hardwareProfile: ctx.hardwareProfile,
      tokensIn: 0,
      tokensOut: 0,
      startedAt,
      residency: null,
    });
    await ctx.logger.log(callEvent("ollama_log_tail", envelope));
    return envelope;
  }

  let body: string;
  try {
    body = await readFile(logPath, "utf8");
  } catch (err) {
    throw new InternError(
      "LOG_READ_FAILED",
      `Cannot read log at ${logPath}: ${(err as Error).message}`,
      "Check filesystem permissions on ~/.ollama-intern/ or override with INTERN_LOG_PATH.",
      false,
    );
  }

  const lines = body.split("\n");
  // Walk from the end; a truncated last line is expected — the NDJSON file is
  // append-only and can have a partial tail during a concurrent write.
  const collected: Array<Record<string, unknown>> = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
    const line = lines[i];
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip truncated / malformed lines (last-line-during-write case)
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as Record<string, unknown>;
    if (input.filter_kind && ev.kind !== input.filter_kind) continue;
    if (input.filter_tool && ev.tool !== input.filter_tool) continue;
    if (since !== null) {
      const tsVal = ev.ts;
      if (typeof tsVal !== "string") continue;
      const evMs = new Date(tsVal).getTime();
      if (Number.isNaN(evMs) || evMs < since) continue;
    }
    collected.push(ev);
  }

  const result: LogTailResult = {
    events: collected,
    total_returned: collected.length,
    log_path: logPath,
    log_present: true,
  };

  const envelope = buildEnvelope<LogTailResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_log_tail", envelope));
  return envelope;
}
