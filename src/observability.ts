/**
 * NDJSON observability — one line per call to ~/.ollama-intern/log.ndjson.
 *
 * This is what lets Claude tune delegation instead of guessing:
 * "that call used 5k tokens on Deep when fast would have sufficed."
 *
 * Also logs timeout events and fallback decisions so later we can prove
 * the system degraded correctly under pressure, not just that a call was slow.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Envelope, Residency } from "./envelope.js";
import type { Tier } from "./tiers.js";

const DEFAULT_LOG_DIR = join(homedir(), ".ollama-intern");
const DEFAULT_LOG_PATH = process.env.INTERN_LOG_PATH || join(DEFAULT_LOG_DIR, "log.ndjson");

/**
 * Normalized input-shape record — LOG SHAPE, NEVER CONTENT.
 *
 * One entry per top-level input key, so the NDJSON log is rich enough for
 * Phase 2.5 chain reconstruction + new-skill proposal without storing raw
 * text, paths, or user content. Size-bucketing means "10k chars of log" and
 * "14k chars of log" bucket the same way, which is the right semantic for
 * "these two calls were the same kind of job."
 */
export type ValueShape =
  | { kind: "absent" }
  | { kind: "string"; bucket: "tiny" | "small" | "medium" | "large" | "huge" }
  | { kind: "array"; length: number }
  | { kind: "object"; keys: string[] }
  | { kind: "boolean"; value: boolean }
  | { kind: "number" }
  | { kind: "other" };

export type InputShape = Record<string, ValueShape>;

export type LogEvent =
  | { kind: "call"; ts: string; tool: string; envelope: Envelope<unknown>; input_shape?: InputShape }
  | { kind: "timeout"; ts: string; tool: string; tier: Tier; timeout_ms: number }
  | { kind: "fallback"; ts: string; tool: string; from: Tier; to: Tier; reason: string }
  | { kind: "guardrail"; ts: string; tool: string; rule: string; action: string; detail?: unknown }
  | {
      kind: "prewarm";
      ts: string;
      tier: Tier;
      model: string;
      hardware_profile: string;
      success: boolean;
      elapsed_ms: number;
      residency: Residency | null;
      error?: string;
    };

export interface Logger {
  log(event: LogEvent): Promise<void>;
}

export class NdjsonLogger implements Logger {
  private readyPromise: Promise<void> | null = null;

  constructor(private path: string = DEFAULT_LOG_PATH) {}

  private ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    }
    return this.readyPromise;
  }

  async log(event: LogEvent): Promise<void> {
    try {
      await this.ready();
      await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // observability failures must never break tool calls
    }
  }
}

/** No-op logger for tests. */
export class NullLogger implements Logger {
  public events: LogEvent[] = [];
  async log(event: LogEvent): Promise<void> {
    this.events.push(event);
  }
}

export function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Bucket a string by character length. Discrete buckets are the right
 * similarity semantic for "these were the same kind of job".
 */
function stringBucket(length: number): "tiny" | "small" | "medium" | "large" | "huge" {
  if (length < 100) return "tiny";
  if (length < 1_000) return "small";
  if (length < 10_000) return "medium";
  if (length < 100_000) return "large";
  return "huge";
}

/**
 * Summarize a tool's input object as a normalized shape record —
 * presence, counts, and buckets only. NEVER logs raw text, path contents,
 * or user-supplied strings. Object keys are sorted so the shape is stable
 * across call sites.
 */
export function summarizeInputShape(input: unknown): InputShape {
  const out: InputShape = {};
  if (input === null || input === undefined || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined) {
      out[key] = { kind: "absent" };
    } else if (typeof value === "string") {
      out[key] = { kind: "string", bucket: stringBucket(value.length) };
    } else if (Array.isArray(value)) {
      out[key] = { kind: "array", length: value.length };
    } else if (typeof value === "boolean") {
      out[key] = { kind: "boolean", value };
    } else if (typeof value === "number") {
      out[key] = { kind: "number" };
    } else if (value !== null && typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      out[key] = { kind: "object", keys };
    } else {
      out[key] = { kind: "other" };
    }
  }
  return out;
}

/**
 * Build a LogEvent for a completed tool call. Pass `input` to get a
 * privacy-safe input-shape record logged alongside the envelope — Phase 2.5
 * proposer uses this to detect recurring ad-hoc workflows.
 */
export function callEvent(tool: string, envelope: Envelope<unknown>, input?: unknown): LogEvent {
  const base: LogEvent = { kind: "call", ts: timestamp(), tool, envelope };
  if (input !== undefined) {
    base.input_shape = summarizeInputShape(input);
  }
  return base;
}
