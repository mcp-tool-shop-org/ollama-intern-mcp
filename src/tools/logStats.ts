/**
 * ollama_log_stats — F4. Aggregate the NDJSON receipts into measured
 * economics (no-LLM, no egress).
 *
 * Every envelope already logs tokens_in/out, elapsed_ms, tier, and (since
 * v2.7.0) backend/degraded provenance — but the only consumer was
 * ollama_log_tail (raw events). Nobody could answer "cloud vs local
 * split", "fallback rate", "tokens this week", "p95 per tool" without jq.
 * This tool is the aggregation the "measured economics" tagline promises.
 *
 * Shape discipline mirrors logTail: stream the NDJSON line-by-line (never
 * materialize the whole file), JSON.parse per line, tolerate a torn tail
 * line (append-only log during a concurrent write), treat a missing file
 * as soft-empty (zeros, log_present:false). Files past a hard byte cap
 * fail loud (LOG_READ_FAILED) rather than allocating unbounded. Aggregation
 * is coerce-before-trust: a call event with a malformed envelope
 * still counts as a call (honest volume) but contributes 0 tokens and no
 * elapsed sample — sums can never go NaN from one bad line.
 *
 * Percentiles are nearest-rank (sorted[ceil(p·N)−1]) — exact for small N,
 * no interpolation to explain in receipts.
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import { iterateLogLines } from "./logRead.js";

export const logStatsSchema = z.object({
  since: z
    .string()
    .optional()
    .describe(
      "ISO-8601 timestamp. Aggregate only events with ts >= since (e.g. " +
        "'tokens this week'). Invalid ISO → SCHEMA_INVALID. Omit for the " +
        "whole log.",
    ),
});

export type LogStatsInput = z.infer<typeof logStatsSchema>;

export interface ToolStats {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  /** Calls this tool served from cloud. */
  cloud_calls: number;
  /** Calls that WANTED cloud but were served local (degraded). */
  degraded_calls: number;
  /** Nearest-rank percentiles over this tool's elapsed_ms samples. Null when no samples. */
  p50_elapsed_ms: number | null;
  p95_elapsed_ms: number | null;
}

export interface LogStatsResult {
  log_path: string;
  log_present: boolean;
  /** Echo of the caller's window start (null = whole log). */
  since: string | null;
  /** Parsed event lines examined after the since filter (all kinds). */
  events_scanned: number;
  totals: { calls: number; tokens_in: number; tokens_out: number };
  by_tool: Record<string, ToolStats>;
  by_tier: Record<string, { calls: number; tokens_in: number; tokens_out: number }>;
  backend: {
    /** Calls served by cloud (envelope backend:'cloud'). */
    cloud_calls: number;
    /** Calls explicitly served local WITHOUT degradation (standby default / backend:'local' pins). */
    local_calls: number;
    /** Calls that wanted cloud but were served local (envelope degraded:true). */
    degraded_calls: number;
    /** Calls with no backend field at all (local-only mode, pre-cloud receipts). */
    unrouted_calls: number;
    /** Raw backend_fallback events in the window (corroborates degraded_calls). */
    backend_fallback_events: number;
    /**
     * degraded / (cloud + degraded) — the fraction of cloud-INTENDED calls
     * that fell back to local. Null when no call in the window intended
     * cloud (rate over zero intent would be noise, not signal).
     */
    fallback_rate: number | null;
  };
  /** TIER degradation events (orthogonal to backend fallback — see routing.ts). */
  tier_events: { timeouts: number; fallbacks: number };
  /** Nearest-rank percentiles over ALL call elapsed_ms samples. Null when no samples. */
  elapsed_ms: { p50: number | null; p95: number | null };
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
      "Pass an ISO-8601 string like 2026-07-06T00:00:00Z, or omit the field.",
      false,
    );
  }
  return d.getTime();
}

/** Nearest-rank percentile over a SORTED ascending array. Null on empty. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** Read a finite non-negative number off a loose object, else 0. */
function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function emptyResult(logPath: string, present: boolean, since: string | null): LogStatsResult {
  return {
    log_path: logPath,
    log_present: present,
    since,
    events_scanned: 0,
    totals: { calls: 0, tokens_in: 0, tokens_out: 0 },
    by_tool: {},
    by_tier: {},
    backend: {
      cloud_calls: 0,
      local_calls: 0,
      degraded_calls: 0,
      unrouted_calls: 0,
      backend_fallback_events: 0,
      fallback_rate: null,
    },
    tier_events: { timeouts: 0, fallbacks: 0 },
    elapsed_ms: { p50: null, p95: null },
  };
}

export async function handleLogStats(
  input: LogStatsInput,
  ctx: RunContext,
): Promise<Envelope<LogStatsResult>> {
  const startedAt = Date.now();
  const sinceMs = parseSince(input.since);
  const sinceEcho = input.since ?? null;
  const logPath = defaultLogPath();

  const finish = async (result: LogStatsResult): Promise<Envelope<LogStatsResult>> => {
    const envelope = buildEnvelope<LogStatsResult>({
      result,
      tier: "instant",
      model: "",
      hardwareProfile: ctx.hardwareProfile,
      tokensIn: 0,
      tokensOut: 0,
      startedAt,
      residency: null,
    });
    await ctx.logger.log(callEvent("ollama_log_stats", envelope));
    return envelope;
  };

  if (!existsSync(logPath)) {
    return finish(emptyResult(logPath, false, sinceEcho));
  }

  // H5: intern log can vanish between existsSync and the first byte.
  // Probe via readFile so the existing test mock (forceReadEnoent) still
  // maps that race to soft-empty. Abort immediately so we never allocate
  // the body — aggregation streams below.
  try {
    await readFile(logPath, { encoding: "utf8", signal: AbortSignal.abort() });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return finish(emptyResult(logPath, false, sinceEcho));
    }
    // AbortError (expected) or other: continue to the bounded stream.
  }

  const result = emptyResult(logPath, true, sinceEcho);
  const allElapsed: number[] = [];
  const perToolElapsed = new Map<string, number[]>();

  try {
    for await (const line of iterateLogLines(logPath)) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn tail during a concurrent write, or a corrupt line
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as Record<string, unknown>;

    if (sinceMs !== null) {
      const tsVal = ev.ts;
      if (typeof tsVal !== "string") continue;
      const evMs = new Date(tsVal).getTime();
      if (Number.isNaN(evMs) || evMs < sinceMs) continue;
    }
    result.events_scanned += 1;

    const kind = ev.kind;
    if (kind === "backend_fallback") {
      result.backend.backend_fallback_events += 1;
      continue;
    }
    if (kind === "timeout") {
      result.tier_events.timeouts += 1;
      continue;
    }
    if (kind === "fallback") {
      result.tier_events.fallbacks += 1;
      continue;
    }
    if (kind !== "call") continue;

    // A call event with a malformed envelope still counts as a call
    // (honest volume) but contributes 0 tokens and no elapsed sample.
    result.totals.calls += 1;
    const tool = typeof ev.tool === "string" && ev.tool.length > 0 ? ev.tool : "(unknown)";
    const perTool = (result.by_tool[tool] ??= {
      calls: 0,
      tokens_in: 0,
      tokens_out: 0,
      cloud_calls: 0,
      degraded_calls: 0,
      p50_elapsed_ms: null,
      p95_elapsed_ms: null,
    });
    perTool.calls += 1;

    const rawEnvelope = ev.envelope;
    if (!rawEnvelope || typeof rawEnvelope !== "object" || Array.isArray(rawEnvelope)) continue;
    const e = rawEnvelope as Record<string, unknown>;

    const tin = num(e, "tokens_in");
    const tout = num(e, "tokens_out");
    result.totals.tokens_in += tin;
    result.totals.tokens_out += tout;
    perTool.tokens_in += tin;
    perTool.tokens_out += tout;

    const tier = typeof e.tier_used === "string" && e.tier_used.length > 0 ? e.tier_used : "(unknown)";
    const perTier = (result.by_tier[tier] ??= { calls: 0, tokens_in: 0, tokens_out: 0 });
    perTier.calls += 1;
    perTier.tokens_in += tin;
    perTier.tokens_out += tout;

    const elapsed = e.elapsed_ms;
    if (typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0) {
      allElapsed.push(elapsed);
      let bucket = perToolElapsed.get(tool);
      if (!bucket) perToolElapsed.set(tool, (bucket = []));
      bucket.push(elapsed);
    }

    // Backend provenance (v2.7.0+ receipts). degraded means "wanted cloud,
    // served local" — counted apart from an explicitly-local serve so the
    // fallback rate reflects intent, not mode.
    if (e.degraded === true) {
      result.backend.degraded_calls += 1;
      perTool.degraded_calls += 1;
    } else if (e.backend === "cloud") {
      result.backend.cloud_calls += 1;
      perTool.cloud_calls += 1;
    } else if (e.backend === "local") {
      result.backend.local_calls += 1;
    } else {
      result.backend.unrouted_calls += 1;
    }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return finish(emptyResult(logPath, false, sinceEcho));
    }
    throw err;
  }

  allElapsed.sort((a, b) => a - b);
  result.elapsed_ms.p50 = percentile(allElapsed, 0.5);
  result.elapsed_ms.p95 = percentile(allElapsed, 0.95);
  for (const [tool, samples] of perToolElapsed) {
    samples.sort((a, b) => a - b);
    result.by_tool[tool].p50_elapsed_ms = percentile(samples, 0.5);
    result.by_tool[tool].p95_elapsed_ms = percentile(samples, 0.95);
  }

  const cloudIntended = result.backend.cloud_calls + result.backend.degraded_calls;
  result.backend.fallback_rate =
    cloudIntended > 0 ? result.backend.degraded_calls / cloudIntended : null;

  return finish(result);
}
