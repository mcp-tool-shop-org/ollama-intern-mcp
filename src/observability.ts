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

export type LogEvent =
  | { kind: "call"; ts: string; tool: string; envelope: Envelope<unknown> }
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
      // Swallow mkdir rejection — observability failures (e.g. EACCES) must
      // never hang the process via unhandled rejection. log() catches append
      // errors too, so a disabled log dir degrades silently.
      this.readyPromise = mkdir(dirname(this.path), { recursive: true })
        .then(() => undefined)
        .catch(() => undefined);
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

/** Build a LogEvent for a completed tool call from its envelope. */
export function callEvent(tool: string, envelope: Envelope<unknown>): LogEvent {
  return { kind: "call", ts: timestamp(), tool, envelope };
}
