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
import { getRunContext } from "./runContext.js";

/**
 * Closed enum for the `op` field on NDJSON events (Phase 7 / FT-001).
 *
 * Values borrowed from OpenTelemetry's `gen_ai.operation.name` semantic
 * convention (v1.37 Experimental) so a future OTel exporter can map
 * cleanly without renaming. The set is closed — adding a new value is
 * a deliberate schema change. `startup` / `shutdown` are MCP-server
 * concerns not covered by OTel's GenAI vocab; they live here as the
 * minimum-needed extensions for lifecycle events.
 *
 * - `chat`         — Ollama /api/chat HTTP call
 * - `embeddings`   — Ollama /api/embed HTTP call (mapped from generate
 *                    for non-chat completions per OTel mapping)
 * - `pack_step`    — One step in an incident/repo/change pack pipeline
 * - `semaphore_wait` — Operator wait on the global semaphore
 * - `guardrail`    — A guardrail rule fired (warn / deny / strip)
 * - `shutdown`     — Server received SIGTERM/SIGINT (lifecycle)
 * - `startup`      — Server startup-probe failure (lifecycle)
 */
export type CorrelationOp =
  | "chat"
  | "embeddings"
  | "pack_step"
  | "semaphore_wait"
  | "guardrail"
  | "shutdown"
  | "startup";

const DEFAULT_LOG_DIR = join(homedir(), ".ollama-intern");
const DEFAULT_LOG_PATH = process.env.INTERN_LOG_PATH || join(DEFAULT_LOG_DIR, "log.ndjson");

/**
 * Phase 7 / FT-001 — correlation fields that may appear on ANY LogEvent
 * variant. These are populated by:
 *   - `run_id` — auto-stamped from the active `CorrelationContext` via
 *     `withCorrelation()` on every `log()` call.
 *   - `call_id` / `parent_call_id` / `op` — explicitly set by emitters
 *     that own the HTTP-attempt or pack-sub-step granularity (ollama.ts
 *     for HTTP `op:'chat'|'embeddings'`, pack handlers for the
 *     `op:'pack_step'` + parent linkage).
 *
 * Lifted onto every variant via intersection so the discriminated union
 * stays intact (TypeScript narrows by `kind`) while new fields don't
 * require a parallel-types explosion. Operators can grep ANY event line
 * for `run_id` regardless of `kind`.
 */
export interface CorrelationFields {
  run_id?: string;
  call_id?: string;
  parent_call_id?: string;
  op?: CorrelationOp;
}

export type LogEvent = CorrelationFields &
  (
    | { kind: "call"; ts: string; tool: string; envelope: Envelope<unknown> }
    | {
        kind: "timeout";
        ts: string;
        tool: string;
        tier: Tier;
        timeout_ms: number;
        /** Concrete model that timed out (pulled from ctx.tiers[tier]). */
        model?: string;
        /** Active profile name — lets operators diff timeouts across profiles. */
        profile_name?: string;
      }
    | {
        kind: "fallback";
        ts: string;
        tool: string;
        from: Tier;
        to: Tier;
        reason: string;
        profile_name?: string;
      }
    // Emitted when the routing layer (cloud-primary mode) serves a call from
    // the LOCAL backend instead of cloud — because the cloud attempt failed
    // (timeout/5xx/429/network), the breaker was open, or the cloud key is
    // misconfigured. ORTHOGONAL to `fallback` (which is tier-degradation on a
    // single backend). Lets `log_tail` surface the cloud→local fallback RATE,
    // the early-warning that cloud is degrading.
    | {
        kind: "backend_fallback";
        ts: string;
        from: "cloud";
        to: "local";
        /** cloud_timeout | cloud_5xx | cloud_rate_limited | cloud_unreachable | cloud_auth_failed | circuit_open */
        reason: string;
        tier?: Tier;
        model?: string;
      }
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
      }
    // Emitted when a tool call arrives while prewarm is still running. Lets an
    // operator reading the log correlate "first call was slow" with cold-start
    // instead of blaming the tool. Purely informational — the call proceeds
    // normally (semaphore + Ollama keep_alive serialize it behind prewarm).
    | { kind: "prewarm:in_progress_request"; ts: string; tool: string }
    // Emitted when a semaphore acquire has to wait (permits exhausted). Gives
    // an operator debugging "why was this slow?" the queue depth and a rough
    // expected-wait estimate based on the longest in-flight request. One event
    // per acquire that actually queues; release events omitted to keep volume
    // bounded on hot paths.
    | {
        kind: "semaphore:wait";
        ts: string;
        tier: Tier | "unknown";
        queue_depth: number;
        in_flight: number;
        expected_wait_ms: number;
        profile_name?: string;
      }
    // Emitted BEFORE each step of a pack's fixed pipeline starts. Gives
    // operators a coarse "what stage is this long-running pack in" signal
    // without promising mid-step streaming (that needs MCP streaming
    // support the server doesn't have yet). `step_index` is 1-based.
    | {
        kind: "pack_step";
        ts: string;
        pack: "incident" | "repo" | "change";
        step: string;
        step_index: number;
        total_steps: number;
      }
  );

export interface Logger {
  log(event: LogEvent): Promise<void>;
}

/**
 * Auto-merge correlation fields (`run_id`) into an outgoing event when
 * a `CorrelationContext` is active for the calling async tree (Phase 7 /
 * FT-001). Callers do NOT need to pass `run_id` manually — that defeats
 * the AsyncLocalStorage point. The merge is conservative: if the event
 * already carries `run_id` (e.g., the caller wants to stamp a specific
 * value for a synthetic test event), the caller's value wins.
 *
 * Field ordering note: JSON.stringify emits keys in insertion order; we
 * spread `run_id` first so it lands near the top of every line, which is
 * what makes `log_tail` greppable for an operator joining envelope back
 * to events.
 */
function withCorrelation(event: LogEvent): LogEvent {
  const ctx = getRunContext();
  if (!ctx) return event;
  const ev = event as LogEvent & { run_id?: string };
  // Caller-supplied run_id wins (deterministic test paths).
  if (ev.run_id) return event;
  // Spread is safe — LogEvent is a discriminated union and run_id is an
  // additive optional field on every variant per the FT-001 spec.
  return { run_id: ctx.run_id, ...event } as LogEvent;
}

export class NdjsonLogger implements Logger {
  private readyPromise: Promise<void> | null = null;
  /**
   * Logger failures (EACCES, ENOSPC, read-only fs) used to be fully silent —
   * observability would quietly disable itself and the operator had no way
   * to know. Emit ONCE to stderr on the first write failure so the operator
   * sees "log disabled because of X" without drowning them in per-call noise.
   * Subsequent failures still swallow; tool calls never break on log writes.
   */
  private warnedOnFailure = false;

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
    // Auto-stamp run_id from the active ALS context before serializing.
    // Tools using runTool inherit this transparently — they emit the
    // event with their normal fields, the run_id appears alongside.
    const enriched = withCorrelation(event);
    try {
      await this.ready();
      await appendFile(this.path, JSON.stringify(enriched) + "\n", "utf8");
    } catch (err) {
      // observability failures must never break tool calls, but the
      // operator deserves to know observability is disabled. Emit once,
      // on stderr (never the envelope so callers don't see log noise).
      if (!this.warnedOnFailure) {
        this.warnedOnFailure = true;
        const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(
          `ollama-intern: observability log disabled (${code}: ${message}) — path=${this.path}. Tool calls continue; subsequent log errors suppressed.`,
        );
      }
    }
  }
}

/** No-op logger for tests. */
export class NullLogger implements Logger {
  public events: LogEvent[] = [];
  async log(event: LogEvent): Promise<void> {
    // NullLogger preserves the same auto-correlation contract as
    // NdjsonLogger so tests that read events back can assert on
    // `run_id` without special-casing in-memory vs on-disk.
    this.events.push(withCorrelation(event));
  }
}

export function timestamp(): string {
  return new Date().toISOString();
}

/** Build a LogEvent for a completed tool call from its envelope. */
export function callEvent(tool: string, envelope: Envelope<unknown>): LogEvent {
  return { kind: "call", ts: timestamp(), tool, envelope };
}

/**
 * Build a pack_step progress event. Emitted by packs before entering
 * each deterministic step — coarse-grained progress that costs a single
 * NDJSON line per step, not mid-step streaming.
 */
export function packStepEvent(args: {
  pack: "incident" | "repo" | "change";
  step: string;
  step_index: number;
  total_steps: number;
}): LogEvent {
  return {
    kind: "pack_step",
    ts: timestamp(),
    pack: args.pack,
    step: args.step,
    step_index: args.step_index,
    total_steps: args.total_steps,
  };
}
