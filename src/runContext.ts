/**
 * Shared dependencies every tool handler needs.
 *
 * Passing one RunContext is cleaner than threading 3+ positional args,
 * and gives us a stable shape to extend later (metrics, tracing, etc.)
 * without touching 8 call sites.
 *
 * Phase 7 / FT-001 adds a SECOND, distinct concern: a per-call correlation
 * context (`CorrelationContext`) propagated via Node's `AsyncLocalStorage`.
 * That context carries the server-minted `run_id` (one per MCP tool call)
 * plus the optional client-supplied MCP `progress_token`, so deep helpers
 * (`OllamaClient.generate`, semaphore wait, `NdjsonLogger.event`) can stamp
 * every NDJSON event with the run_id without threading a parameter through
 * every signature. The two concerns are deliberately separate: `RunContext`
 * is wiring (logger, tiers, profile); `CorrelationContext` is per-call
 * identity. They do not nest, do not share a store, and do not collide.
 *
 * Naming follows the v0.8/v2.4 layering convention: snake_case field names
 * on the wire (NDJSON, envelope JSON), camelCase on TypeScript identifiers.
 *
 * The ALS holder is intentionally module-local — there is no public setter
 * for the store. Callers wrap a function with `withRunContext(ctx, fn)` and
 * reads happen through `getRunContext()`. Direct mutation would defeat the
 * "request-scoped" invariant that makes ALS safe.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { OllamaClient } from "./ollama.js";
import type { Tier, TierConfig } from "./tiers.js";
import type { Logger } from "./observability.js";
import type { CloudConfig } from "./profiles.js";

export interface RunContext {
  client: OllamaClient;
  /** Concrete tier→model picks from the active Profile (the LOCAL fallback ladder). */
  tiers: TierConfig;
  /** Per-tier timeouts in ms, sized for the active profile's hardware. */
  timeouts: Record<Tier, number>;
  /** Profile name written onto every envelope + NDJSON line. */
  hardwareProfile: string;
  logger: Logger;
  /**
   * Cloud configuration when cloud-primary mode is opted into (null/undefined
   * otherwise — the default local-only path). When set, `client` is a
   * RoutingOllamaClient and the runner uses `cloud.timeouts` as the per-tier
   * budget. Embeddings always stay local regardless.
   */
  cloud?: CloudConfig | null;
}

/**
 * Per-tool-call correlation context propagated through `AsyncLocalStorage`.
 *
 * One `CorrelationContext` is minted at every MCP tool-call entry in
 * `index.ts` and remains in scope for the full lifetime of that call —
 * across nested awaits, semaphore queueing, Ollama HTTP retries, pack
 * sub-steps, and envelope build. Deep helpers read it via
 * `getRunContext()` and emit it as top-level NDJSON / envelope fields.
 *
 * The shape is deliberately small: only IDs and a timestamp. Anything
 * call-specific (tool name, model, tier) lives on the envelope, not here.
 *
 * Reserved future field names — `trace_id`, `span_id` — are NOT added now
 * to avoid semantic drift when (if) a future W3C TraceContext exporter
 * lands. Adding them later is a strictly-additive change.
 */
export interface CorrelationContext {
  /**
   * Server-minted correlation ID. Format: `run_<ISO-date>_<6-hex>`, e.g.
   * `run_2026-05-15T14-22-33_a3f9c2`. One per MCP tool call (NOT per
   * session, NOT per process). Sortable + greppable. Use `mintRunId()`
   * to generate.
   */
  run_id: string;
  /**
   * Optional MCP `progressToken` supplied by the client. Kept SEPARATE
   * from `run_id` so the two correlation handles never collide: the
   * client owns its token's semantics, the server owns `run_id`. May be
   * a string or number per MCP spec.
   */
  progress_token?: string | number;
  /** ISO-8601 timestamp marking when the context was opened. */
  started_at: string;
  /**
   * Runner-level `call_id` for the current HTTP-attempt. Set by
   * `runTool` (or `runBatch`'s per-item branch) right before the wire
   * call begins via `setCallId()`. Nested events (pack steps, guardrail
   * strips that happen mid-call) read this and emit it as their
   * `parent_call_id` so the log forms a proper parent/child tree under
   * the top-level `run_id`.
   *
   * Optional because top-of-handler entry points (the `wrap` helper in
   * `index.ts`) install the context BEFORE the first HTTP call mints a
   * call_id; events emitted between those two moments correctly omit
   * `parent_call_id` rather than synthesizing one.
   */
  call_id?: string;
}

/**
 * ALS instance — single store, single key (the CorrelationContext). Kept
 * module-private; callers go through `withRunContext` / `getRunContext`.
 *
 * Overhead measured at ~5-7% per call on Node 22 (Platformatic 2025); on
 * Node 24 with AsyncContextFrame it drops to ~5%. Dwarfed by Ollama HTTP
 * latency, so the trade-off is correct for this codebase.
 */
const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Run `fn` with the supplied `CorrelationContext` active for all async
 * descendants. Intended to be called ONCE per MCP tool-call dispatch in
 * `index.ts` — every helper invoked from `fn` (including deep ones) can
 * call `getRunContext()` to read the same context without parameter
 * threading.
 *
 * The return value of `fn` is returned through. Errors propagate normally;
 * the ALS scope exits cleanly on either resolution path.
 */
export function withRunContext<T>(ctx: CorrelationContext, fn: () => T | Promise<T>): T | Promise<T> {
  return correlationStorage.run(ctx, fn);
}

/**
 * Read the active correlation context. Returns `undefined` when called
 * outside any `withRunContext` scope — startup code, prewarm,
 * shutdown-signal handlers, and tests that don't wrap. Callers that
 * merge the context into events MUST tolerate the `undefined` case
 * (omit the field entirely; don't synthesize a fake `run_id`).
 */
export function getRunContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

/**
 * Mint a fresh `run_id` of the form `run_<ISO-date-with-hyphens>_<6-hex>`.
 *
 * The ISO-date prefix (sortable lexicographically) makes log-tail
 * filtering trivial and lets an operator spot "this call came in late
 * 2026-05-15 around 14:22" without parsing JSON. The 6-character random
 * suffix is collision-safe at the per-second rate this server operates
 * at (16M values per second of clock resolution).
 *
 * Uses `Math.random()` rather than `crypto.randomUUID()` because the
 * IDs are correlation handles inside a local-only NDJSON log, not
 * security-bearing tokens. Avoiding the crypto module also keeps the
 * mint path off the critical path of every tool call.
 */
export function mintRunId(): string {
  // ISO 8601 → 2026-05-15T14:22:33.123Z → strip ms+Z, swap `:` for `-`
  // so the result is filesystem/URL-safe and the lexicographic sort
  // matches chronological order.
  const iso = new Date().toISOString();
  const datePart = iso.slice(0, 19).replace(/:/g, "-"); // 2026-05-15T14-22-33
  // 24-bit random → 6 lowercase hex chars. padStart guards against the
  // (rare) case where Math.random() returns a value that hex-encodes
  // shorter than 6 chars after Math.floor.
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `run_${datePart}_${hex}`;
}

/**
 * Mint a fresh `call_id` — the sub-ID for one HTTP-attempt (or pack
 * sub-step). Format: `call_<8-hex>`. Shorter than `run_id` because
 * call_ids are many-per-run; the join key for greppy humans is run_id.
 *
 * `Math.random()` is sufficient — these are local-only correlation
 * handles, not security tokens. Avoiding `crypto.randomUUID()` keeps
 * the mint path off the critical path of every HTTP call.
 */
export function mintCallId(): string {
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `call_${hex}`;
}

/**
 * Set the `call_id` on the active `CorrelationContext` in place. Called
 * by `runTool` (and `runBatch`'s per-item loop) right before the wire
 * call begins so nested pack-step / guardrail events see the correct
 * `parent_call_id` via `getRunContext()?.call_id`.
 *
 * No-op when called outside any `withRunContext` scope — keeps the
 * helper safe to invoke from utility code paths the tools agent hasn't
 * fully wrapped yet. Direct mutation of the store is the documented
 * AsyncLocalStorage extension pattern (the store object reference
 * persists for the lifetime of the `als.run` scope).
 */
export function setCallId(call_id: string): void {
  const store = correlationStorage.getStore();
  if (store) store.call_id = call_id;
}

// Test seam — surfaces the ALS instance so tests can confirm context
// isolation without touching production code paths.
export const __correlationInternals = {
  storage: correlationStorage,
};
