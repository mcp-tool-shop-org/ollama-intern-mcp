/**
 * Shared batch runner — one coherent job result instead of N mini-transcripts.
 *
 * Batch design law:
 *   - ONE envelope for the whole batch. tokens/elapsed/residency are at the
 *     envelope level. Per-item entries stay tight: {id, ok, result|error}.
 *   - Stable, caller-provided item ids. Duplicates are rejected up front
 *     so results join back to source inputs cleanly even under retries
 *     and partial failures.
 *   - Partial failure is first-class. A single bad item never explodes
 *     the batch — errors surface per item and ok_count/error_count give
 *     Claude an at-a-glance triage.
 *   - Serial processing. Simpler to reason about (no per-item head-of-line
 *     contention with concurrent single-call users) and the existing
 *     Ollama semaphore already bounds concurrency globally. If throughput
 *     ever matters more than clarity, bounded batch concurrency is a
 *     follow-up, not this commit.
 *
 * The per-item shape deliberately omits per-item tokens/elapsed. Adding
 * them would turn the batch back into a bundle of receipts. The NDJSON
 * log is the place for per-call accounting.
 */

import type { GenerateRequest } from "../ollama.js";
import type { Tier } from "../tiers.js";
import { resolveTier, resolveNumCtx } from "../tiers.js";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { runWithTimeoutAndFallback } from "../guardrails/timeouts.js";
import { getRoutingInfo, type Backend } from "../routing.js";
import { countTokens } from "../ollama.js";
import { InternError, toErrorShape, type ErrorShape } from "../errors.js";
import type { RunContext } from "../runContext.js";
import {
  withRunContext as withRunCorrelation,
  mintRunId,
  getRunContext as getRunCorrelation,
} from "../runContext.js";
import {
  withCallContext,
  mintCallId,
  getCallContext,
} from "./_runContext.js";

export interface BatchItem {
  /** Caller-provided, stable, unique within the batch. Required. */
  id: string;
}

export interface BatchItemOk<R> {
  id: string;
  ok: true;
  result: R;
}

export interface BatchItemError {
  id: string;
  ok: false;
  error: { code: ErrorShape["code"]; message: string; hint: string };
}

export type BatchItemEntry<R> = BatchItemOk<R> | BatchItemError;

export interface BatchResult<R> {
  items: BatchItemEntry<R>[];
}

export interface RunBatchInput<I extends BatchItem, R> {
  tool: string;
  tier: Tier;
  ctx: RunContext;
  items: I[];
  /** Build the generate request for one item. Runs before the LLM call. */
  build: (item: I, tier: Tier, model: string) => GenerateRequest;
  /** Turn the raw model response into a per-item result. Throw to mark the item failed. */
  parse: (raw: string, item: I) => R;
  /** Optional pre-flight check. Throw with an InternError to fail fast on malformed items without an LLM call. */
  preValidate?: (item: I) => void;
  /** Whether to attempt tier fallback on timeout per item. */
  allowFallback?: boolean;
  /** Override thinking mode on every per-item generate call. See RunToolInput.think. */
  think?: boolean;
  /**
   * Optional per-call model override (atom tools only — added v2.3.0).
   * Applies to the initial-tier attempt for EVERY item in the batch.
   * Fallback retries still resolve their model from the fallback tier.
   * Propagates to `envelope.model_requested` on the batch envelope.
   */
  modelOverride?: string;
  /**
   * R-019 (v2.6.0) — optional per-call tier-budget override in milliseconds.
   *
   * Same semantics as the single-call runner's `tierBudgetMsOverride`:
   * applied uniformly to every tier the cascade visits (initial + fallback)
   * for EVERY item in the batch. Validated upstream at the schema layer;
   * trusted here.
   */
  tierBudgetMsOverride?: number;
}

/**
 * Assert every item has a unique id. Duplicates corrupt the join back to
 * source inputs and are almost always caller mistakes; fail loud rather
 * than silently de-duping.
 */
function assertUniqueIds(items: BatchItem[]): void {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const item of items) {
    if (seen.has(item.id)) dupes.push(item.id);
    seen.add(item.id);
  }
  if (dupes.length > 0) {
    const uniqueDupes = [...new Set(dupes)];
    const listed = uniqueDupes.map((id) => `'${id}'`).join(", ");
    throw new InternError(
      "SCHEMA_INVALID",
      `Batch has duplicate item id(s): [${listed}] (${uniqueDupes.length} unique duplicate${uniqueDupes.length === 1 ? "" : "s"} across ${dupes.length} collision${dupes.length === 1 ? "" : "s"})`,
      `Rename the repeated id(s) so every item in the batch has a unique caller-provided id — duplicates break the join back to source inputs on retry. Collided ids: [${listed}].`,
      false,
    );
  }
}

export async function runBatch<I extends BatchItem, R>(
  input: RunBatchInput<I, R>,
): Promise<Envelope<BatchResult<R>>> {
  // FT-010 correlation: inherit existing run_id from backend-core's ALS
  // when present; otherwise mint one (test invocations that skip the
  // outer wrap). Mint a fresh call_id at THIS scope so per-item nested
  // events see the batch's call_id as their parent_call_id.
  const existingRun = getRunCorrelation();
  if (existingRun) {
    return withCallContext({ call_id: mintCallId() }, () => runBatchInner(input));
  }
  const run_id = mintRunId();
  return withRunCorrelation({ run_id, started_at: new Date().toISOString() }, () =>
    withCallContext({ call_id: mintCallId() }, () => runBatchInner(input)),
  );
}

async function runBatchInner<I extends BatchItem, R>(
  input: RunBatchInput<I, R>,
): Promise<Envelope<BatchResult<R>>> {
  assertUniqueIds(input.items);
  const startedAt = Date.now();
  const { ctx } = input;

  const entries: BatchItemEntry<R>[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let okCount = 0;
  let errorCount = 0;
  let lastModel: string =
    input.modelOverride !== undefined ? input.modelOverride : resolveTier(input.tier, ctx.tiers);
  let sawFallback: Tier | undefined;
  const initialTier: Tier = input.tier;
  // Per-tier num_ctx for the batch's primary tier (v2.4.0). All items in a
  // batch run on the same tier (per-item fallback affects num_ctx for the
  // INDIVIDUAL fallback attempt, but the envelope's batch-level
  // num_ctx_used reports the primary tier's value — that's the value
  // actually sent for ok items that didn't fall back). Resolved once
  // outside the loop so the envelope reflects the batch's primary
  // context budget consistently.
  const batchNumCtx = resolveNumCtx(input.tier, ctx.tiers);

  // R-019 — when a per-call tier-budget override is supplied, replace EVERY
  // tier's budget with the operator's value so the cascade honors the
  // operator's intent on initial AND fallback tiers (same semantics as
  // runner.ts). Computed once outside the loop because every batch item
  // shares the same per-call budget.
  const effectiveTimeouts: Record<Tier, number> =
    input.tierBudgetMsOverride !== undefined
      ? {
          instant: input.tierBudgetMsOverride,
          workhorse: input.tierBudgetMsOverride,
          deep: input.tierBudgetMsOverride,
          embed: input.tierBudgetMsOverride,
        }
      : ctx.cloud
        ? {
            instant: ctx.cloud.timeouts.instant + ctx.timeouts.instant,
            workhorse: ctx.cloud.timeouts.workhorse + ctx.timeouts.workhorse,
            deep: ctx.cloud.timeouts.deep + ctx.timeouts.deep,
            embed: ctx.cloud.timeouts.embed + ctx.timeouts.embed,
          }
        : ctx.timeouts;

  // Backend routing aggregates across the batch (cloud-primary mode). A batch
  // may serve some items from cloud and some from local fallback; we surface
  // the last backend + whether ANY item degraded, plus the last reason.
  let lastBackend: Backend | undefined;
  let anyDegraded = false;
  let lastDegradeReason: string | undefined;
  let lastNumCtx: number | undefined;

  for (const item of input.items) {
    try {
      if (input.preValidate) input.preValidate(item);
      const { value, actualTier, fallbackFrom } = await runWithTimeoutAndFallback({
        tool: input.tool,
        tier: input.tier,
        logger: ctx.logger,
        allowFallback: input.allowFallback,
        timeoutOverrideMs: effectiveTimeouts,
        run: async (tier, signal) => {
          // Per-call model override: same rule as the single-call runner —
          // override applies only on the initial tier; fallback resolves
          // from the fallback tier so the degradation contract is stable.
          const model =
            input.modelOverride !== undefined && tier === initialTier
              ? input.modelOverride
              : resolveTier(tier, ctx.tiers);
          // Per-tier num_ctx: resolved per ACTIVE tier so a fallback
          // attempt uses the fallback tier's value. Same "absent when
          // unset" contract as runner.ts — never substitute a default.
          const numCtx = resolveNumCtx(tier, ctx.tiers);
          const built = input.build(item, tier, model);
          const withNumCtx: GenerateRequest =
            numCtx !== undefined
              ? { ...built, options: { ...(built.options ?? {}), num_ctx: numCtx } }
              : built;
          const req = input.think === undefined ? withNumCtx : { ...withNumCtx, think: input.think };
          // Pass `tier` so the RoutingOllamaClient can resolve cloud vs local.
          const resp = await ctx.client.generate(req, signal, tier);
          return { resp, model };
        },
      });
      const { resp, model } = value;
      const routing = getRoutingInfo(resp);
      const tokens = countTokens(resp);
      tokensIn += tokens.in;
      tokensOut += tokens.out;
      lastModel = routing?.model ?? model;
      if (routing?.backend) lastBackend = routing.backend;
      if (routing?.degraded) {
        anyDegraded = true;
        lastDegradeReason = routing.degrade_reason;
      }
      if (routing?.num_ctx !== undefined) lastNumCtx = routing.num_ctx;
      if (fallbackFrom && !sawFallback) sawFallback = fallbackFrom;
      const parsed = input.parse(resp.response, item);
      entries.push({ id: item.id, ok: true, result: parsed });
      okCount += 1;
      // actualTier is per-item metadata that the NDJSON log captures via
      // runWithTimeoutAndFallback; we deliberately don't surface it per
      // item to keep the batch shape tight.
      void actualTier;
    } catch (err) {
      const shape = toErrorShape(err);
      entries.push({
        id: item.id,
        ok: false,
        error: { code: shape.code, message: shape.message, hint: shape.hint },
      });
      errorCount += 1;
    }
  }

  // Cloud-served items have no local residency; only probe when the last
  // served item ran locally.
  const residency = lastBackend === "cloud" ? null : await ctx.client.residency(lastModel);
  const numCtxUsed = lastNumCtx ?? batchNumCtx;
  const envelope = buildEnvelope<BatchResult<R>>({
    result: { items: entries },
    tier: input.tier,
    model: lastModel,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut,
    startedAt,
    residency,
    ...(sawFallback ? { fallbackFrom: sawFallback } : {}),
    ...(lastBackend ? { backend: lastBackend } : {}),
    ...(anyDegraded ? { degraded: true } : {}),
    ...(anyDegraded && lastDegradeReason ? { degradeReason: lastDegradeReason } : {}),
    ...(input.modelOverride !== undefined ? { modelRequested: input.modelOverride } : {}),
    ...(numCtxUsed !== undefined ? { numCtxUsed } : {}),
  });
  envelope.batch_count = input.items.length;
  envelope.ok_count = okCount;
  envelope.error_count = errorCount;

  // FT-010: echo run_id + call_id on the batch envelope (additive).
  const runCtx = getRunCorrelation();
  const callCtx = getCallContext();
  if (runCtx?.run_id) {
    (envelope as unknown as Record<string, unknown>).run_id = runCtx.run_id;
  }
  if (callCtx?.call_id) {
    (envelope as unknown as Record<string, unknown>).call_id = callCtx.call_id;
  }

  await ctx.logger.log(callEvent(input.tool, envelope));
  return envelope;
}
