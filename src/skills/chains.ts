/**
 * Chain reconstruction — reads the NDJSON call log and groups consecutive
 * tool calls into "workflows" based on time proximity.
 *
 * No explicit session id exists in the call stream, so the chain boundary
 * is a gap threshold: a stretch of silence longer than `gapMs` starts a new
 * chain. This is the right default heuristic — operators doing coherent
 * work fire calls within seconds of each other; a 3-minute pause is a
 * reasonable "different workflow" signal.
 *
 * What this module is NOT:
 *   - It does NOT propose new skills (that's proposer.ts in Commit C).
 *   - It does NOT invent session ids; chains are purely time-based.
 *   - It does NOT filter — every call in the log appears in exactly one chain.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { InputShape, LogEvent } from "../observability.js";

export type CallLogEvent = Extract<LogEvent, { kind: "call" }>;

export interface ChainStep {
  tool: string;
  ts: string;
  tier_used?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  elapsed_ms?: number;
  ok: boolean;
  input_shape?: InputShape;
}

export interface Chain {
  chain_id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  steps: ChainStep[];
  ok_count: number;
  fail_count: number;
  /**
   * Stable signature for grouping: tool names joined by "→".
   * Proposer groups chains by signature; identical signatures with similar
   * input shapes are the core "recurring workflow" signal.
   */
  signature: string;
}

export interface ReadChainsOptions {
  /** Path to the NDJSON log. Defaults to INTERN_LOG_PATH or ~/.ollama-intern/log.ndjson. */
  logPath?: string;
  /**
   * Silence gap (ms) between consecutive events that starts a new chain.
   * Default 180_000 (3 minutes) — long enough to survive a brief pause mid-
   * workflow, short enough to split unrelated sessions cleanly.
   */
  gapMs?: number;
  /** Filter to events with ts >= since. */
  since?: string;
  /** Drop chains shorter than this many steps. Default 1 (keep everything). */
  min_steps?: number;
  /**
   * Exclude these tool names from chain reconstruction. Default excludes
   * the skill-layer tools themselves to prevent self-referential feedback
   * (e.g. `ollama_skill_list` calls appearing as "workflow steps").
   */
  exclude_tools?: string[];
}

const DEFAULT_EXCLUDES = new Set([
  "ollama_skill_list",
  "ollama_skill_match",
  "ollama_skill_run",
  "ollama_skill_propose",
  "ollama_skill_promote",
]);

/**
 * Resolve the NDJSON log path at CALL time, not module-load time, so the
 * INTERN_LOG_PATH env var can be set after import (scripts, tests).
 */
export function resolveLogPath(override?: string): string {
  if (override !== undefined) return override;
  return process.env.INTERN_LOG_PATH ?? path.join(os.homedir(), ".ollama-intern", "log.ndjson");
}

async function readCallEvents(logPath: string, since?: string): Promise<CallLogEvent[]> {
  if (!existsSync(logPath)) return [];
  const raw = await fs.readFile(logPath, "utf8");
  const events: CallLogEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as LogEvent;
    if (ev.kind !== "call") continue;
    if (since && ev.ts < since) continue;
    events.push(ev as CallLogEvent);
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return events;
}

function extractEnvelopeFacts(env: CallLogEvent["envelope"]): {
  tier_used?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  elapsed_ms?: number;
  ok: boolean;
} {
  const e = env as {
    tier_used?: string;
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    elapsed_ms?: number;
    result?: { error?: unknown } | { ok?: boolean };
  };
  const result = e.result as unknown;
  let ok = true;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.error === true || (typeof r.ok === "boolean" && r.ok === false)) ok = false;
  }
  return {
    tier_used: e.tier_used,
    model: e.model,
    tokens_in: e.tokens_in,
    tokens_out: e.tokens_out,
    elapsed_ms: e.elapsed_ms,
    ok,
  };
}

function toStep(ev: CallLogEvent): ChainStep {
  const facts = extractEnvelopeFacts(ev.envelope);
  const step: ChainStep = {
    tool: ev.tool,
    ts: ev.ts,
    ok: facts.ok,
  };
  if (facts.tier_used !== undefined) step.tier_used = facts.tier_used;
  if (facts.model !== undefined && facts.model !== "") step.model = facts.model;
  if (facts.tokens_in !== undefined) step.tokens_in = facts.tokens_in;
  if (facts.tokens_out !== undefined) step.tokens_out = facts.tokens_out;
  if (facts.elapsed_ms !== undefined) step.elapsed_ms = facts.elapsed_ms;
  if (ev.input_shape !== undefined) step.input_shape = ev.input_shape;
  return step;
}

export async function reconstructChains(opts: ReadChainsOptions = {}): Promise<Chain[]> {
  const gapMs = opts.gapMs ?? 180_000;
  const minSteps = opts.min_steps ?? 1;
  const excludes = new Set([...(opts.exclude_tools ?? []), ...DEFAULT_EXCLUDES]);
  const events = (await readCallEvents(resolveLogPath(opts.logPath), opts.since)).filter(
    (ev) => !excludes.has(ev.tool),
  );
  if (events.length === 0) return [];

  const chains: Chain[] = [];
  let bucket: CallLogEvent[] = [];
  let lastTs = Date.parse(events[0].ts);

  const flush = (): void => {
    if (bucket.length === 0) return;
    if (bucket.length < minSteps) {
      bucket = [];
      return;
    }
    const steps = bucket.map(toStep);
    const startedAt = bucket[0].ts;
    const endedAt = bucket[bucket.length - 1].ts;
    const startMs = Date.parse(startedAt);
    const endMs = Date.parse(endedAt);
    const signature = steps.map((s) => s.tool).join("→");
    const okCount = steps.filter((s) => s.ok).length;
    chains.push({
      chain_id: `${startedAt}_${signature}`,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, endMs - startMs),
      steps,
      ok_count: okCount,
      fail_count: steps.length - okCount,
      signature,
    });
    bucket = [];
  };

  for (const ev of events) {
    const ts = Date.parse(ev.ts);
    if (bucket.length === 0) {
      bucket.push(ev);
      lastTs = ts;
      continue;
    }
    if (ts - lastTs > gapMs) {
      flush();
    }
    bucket.push(ev);
    lastTs = ts;
  }
  flush();
  return chains;
}
