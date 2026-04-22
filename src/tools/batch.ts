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
import { resolveTier } from "../tiers.js";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { runWithTimeoutAndFallback } from "../guardrails/timeouts.js";
import { countTokens } from "../ollama.js";
import { InternError, toErrorShape, type ErrorShape } from "../errors.js";
import type { RunContext } from "../runContext.js";

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
  assertUniqueIds(input.items);
  const startedAt = Date.now();
  const { ctx } = input;

  const entries: BatchItemEntry<R>[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let okCount = 0;
  let errorCount = 0;
  let lastModel: string = resolveTier(input.tier, ctx.tiers);
  let sawFallback: Tier | undefined;

  for (const item of input.items) {
    try {
      if (input.preValidate) input.preValidate(item);
      const { value, actualTier, fallbackFrom } = await runWithTimeoutAndFallback({
        tool: input.tool,
        tier: input.tier,
        logger: ctx.logger,
        allowFallback: input.allowFallback,
        timeoutOverrideMs: ctx.timeouts,
        run: async (tier, signal) => {
          const model = resolveTier(tier, ctx.tiers);
          const built = input.build(item, tier, model);
          const req = input.think === undefined ? built : { ...built, think: input.think };
          const resp = await ctx.client.generate(req, signal);
          return { resp, model };
        },
      });
      const { resp, model } = value;
      const tokens = countTokens(resp);
      tokensIn += tokens.in;
      tokensOut += tokens.out;
      lastModel = model;
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

  const residency = await ctx.client.residency(lastModel);
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
  });
  envelope.batch_count = input.items.length;
  envelope.ok_count = okCount;
  envelope.error_count = errorCount;

  await ctx.logger.log(callEvent(input.tool, envelope));
  return envelope;
}
