/**
 * Tool-layer correlation helpers — call_id sub-ID + event builders (FT-010).
 *
 * The CANONICAL run-level context lives in `../runContext.js`
 * (`CorrelationContext` + `withRunContext` + `getRunContext` +
 * `mintRunId`). That module is backend-core's domain and owns the
 * top-level ALS scope. This module owns a SECOND, narrower correlation
 * concern that's specific to the tools layer: the per-wire-call
 * `call_id` and the per-pack-step `parent_call_id` linkage.
 *
 * Why a separate ALS holder? Backend-core's `CorrelationContext` is
 * intentionally small (run_id + started_at + optional progress_token) —
 * adding `call_id` to it would couple their per-tool-call entry-point
 * code to a sub-detail (per-HTTP-call ID) that only matters inside the
 * tools layer. The split keeps backend-core's wrap path simple and lets
 * us evolve call_id semantics (per-attempt, per-step) without touching
 * `src/runContext.ts`.
 *
 * Event-shape contract (from the FT-010 dispatch — DO NOT DEVIATE):
 *   - ALS run context shape: { run_id, progress_token?, started_at } — owned by ../runContext.js
 *   - NDJSON event shape per event: { run_id, call_id?, parent_call_id?, op, ... }
 *   - `op` enum (closed): 'chat' | 'embeddings' | 'pack_step' |
 *     'semaphore_wait' | 'guardrail' | 'shutdown' | 'startup'
 *   - parent_call_id is for nested events (pack_step has parent_call_id
 *     equal to the runner-level call_id)
 *   - All snake_case
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getRunContext as getRunCorrelation } from "../runContext.js";
import type { LogEvent } from "../observability.js";

/**
 * Closed `op` enum — matches the FT-010 spec. New events MUST pick from
 * this list. If a genuinely new op category surfaces (rare), extend the
 * enum once with a doctrine line on why it deserves to be top-level.
 */
export type Op =
  | "chat"
  | "embeddings"
  | "pack_step"
  | "semaphore_wait"
  | "guardrail"
  | "shutdown"
  | "startup";

/**
 * Per-wire-call sub-context. Pack steps + guardrail strips + abstention
 * events read `call_id` here as their `parent_call_id`. `started_at`
 * lets a deep helper compute elapsed against the call's start (NOT the
 * run's start, which lives in the run-level context).
 */
export interface CallContextData {
  call_id: string;
  started_at: string;
}

const CALL_ALS: AsyncLocalStorage<CallContextData> = new AsyncLocalStorage();

/**
 * Install a call-level context for the duration of `fn`. Every nested
 * `runTool` (e.g., a pack handler calling triage + brief sequentially)
 * enters its own scope so their setCallId mutations don't leak back
 * into the parent pack scope. The pack handler's pack_step events fire
 * IN the pack's scope (between nested tool calls), so they see the
 * pack-level call_id as their parent_call_id.
 */
export function withCallContext<T>(
  ctx: { call_id: string },
  fn: () => Promise<T>,
): Promise<T> {
  const data: CallContextData = {
    call_id: ctx.call_id,
    started_at: new Date().toISOString(),
  };
  return CALL_ALS.run(data, fn);
}

/** Read the ambient call context, if any. */
export function getCallContext(): CallContextData | undefined {
  return CALL_ALS.getStore();
}

/**
 * Mint a fresh call_id of the form `call_<6-hex>`. The HTTP-attempt
 * `call_id` minted in `src/ollama.ts` uses an 8-hex `call_<...>` shape
 * — we use 6 hex here so a quick eyeball can distinguish the two
 * scopes (tool-call vs. HTTP-attempt) even when they share a prefix.
 * `Math.random()` is plenty for a local correlation handle (same
 * rationale as `mintRunId` in runContext.ts).
 */
export function mintCallId(): string {
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `call_${hex}`;
}

/**
 * Build a pack_step LogEvent that carries the FT-010 correlation fields.
 *
 * The canonical packStepEvent in src/observability.ts ships the legacy
 * shape only ({ pack, step, step_index, total_steps }). FT-010 requires
 * `run_id` + `parent_call_id` + `op: 'pack_step'` + snake_case fields on
 * every event. Until backend-core widens the LogEvent union, we attach
 * the extra fields via an object cast — the NDJSON serializer doesn't
 * care (JSON.stringify includes own enumerable properties), and a
 * logger that pretty-prints the union picks up the new fields the
 * moment the type widens.
 *
 * `step_name` mirrors the spec wording. The legacy `step` field stays
 * for backward-compat with consumers that already parse pack_step
 * events. Loggers can de-dup on whichever they prefer.
 *
 * run_id pulled from backend-core's ALS (../runContext.js); call_id (as
 * parent_call_id for the step) pulled from our tools-layer ALS.
 */
export function buildPackStepEventWithCorrelation(args: {
  pack: "incident" | "repo" | "change";
  step: string;
  step_index: number;
  total_steps: number;
}): LogEvent {
  const run = getRunCorrelation();
  const call = CALL_ALS.getStore();
  const base: LogEvent = {
    kind: "pack_step",
    ts: new Date().toISOString(),
    pack: args.pack,
    step: args.step,
    step_index: args.step_index,
    total_steps: args.total_steps,
  };
  const augmented = base as unknown as Record<string, unknown>;
  augmented.op = "pack_step";
  augmented.step_name = args.step;
  if (run?.run_id) augmented.run_id = run.run_id;
  if (call?.call_id) augmented.parent_call_id = call.call_id;
  return base;
}

/**
 * Build a guardrail LogEvent that carries the FT-010 correlation fields.
 * Use in place of constructing the bare `{ kind: 'guardrail', ... }`
 * literal so every guardrail event in this tool surface picks up
 * `op: 'guardrail'` + `run_id` + `parent_call_id` automatically.
 */
export function buildGuardrailEventWithCorrelation(args: {
  tool: string;
  rule: string;
  action: string;
  detail?: unknown;
}): LogEvent {
  const run = getRunCorrelation();
  const call = CALL_ALS.getStore();
  const base: LogEvent = {
    kind: "guardrail",
    ts: new Date().toISOString(),
    tool: args.tool,
    rule: args.rule,
    action: args.action,
    ...(args.detail !== undefined ? { detail: args.detail } : {}),
  };
  const augmented = base as unknown as Record<string, unknown>;
  augmented.op = "guardrail";
  if (run?.run_id) augmented.run_id = run.run_id;
  if (call?.call_id) augmented.parent_call_id = call.call_id;
  return base;
}

/**
 * Read the run_id from backend-core's ALS. Convenience wrapper so
 * tools-layer callers don't have to import from two places.
 */
export function getRunId(): string | undefined {
  return getRunCorrelation()?.run_id;
}
