/**
 * Shared tool-runner — wires timeout/fallback, Ollama generate, envelope,
 * residency probe, and NDJSON logging so each tool handler stays thin.
 *
 * Tools describe *what* they want; the runner handles *how*.
 */

import type { GenerateRequest } from "../ollama.js";
import { countTokens } from "../ollama.js";
import type { Tier } from "../tiers.js";
import { resolveTier, resolveNumCtx } from "../tiers.js";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent, timestamp } from "../observability.js";
import { runWithTimeoutAndFallback } from "../guardrails/timeouts.js";
import type { RunContext } from "../runContext.js";

/**
 * Order-of-magnitude prompt-size estimator.
 *
 * Ollama silently truncates prompts that exceed num_ctx, producing
 * confidently-wrong answers with no operator signal. This estimator
 * lets us emit a guardrail warning BEFORE the wire call when the
 * prompt is plausibly over budget. The estimate is intentionally
 * conservative (rounds up) — we want a false-positive warning more
 * than a false-negative silent truncation.
 *
 * Heuristic: chars/4 is the standard rough rule for prose (one token
 * ≈ 4 chars in BPE tokenizers for English prose). Code is denser
 * (chars/3) because identifier names and operators tokenize finer.
 * Ollama's actual tokenizer differs by model, but for the "are we
 * blowing past num_ctx by an order of magnitude" check this is enough.
 *
 * Returns a single integer estimate in tokens.
 */
function estimatePromptTokens(prompt: string): number {
  // Cheap code-vs-prose split: density of non-alphanumerics is a decent
  // proxy. >25% non-alphanum suggests code (operators, brackets, punct).
  if (prompt.length === 0) return 0;
  let nonAlnum = 0;
  // Sample at most 4000 chars to keep this O(1) for huge prompts. The
  // sampled ratio is good enough for the order-of-magnitude check.
  const sampleSize = Math.min(prompt.length, 4000);
  for (let i = 0; i < sampleSize; i++) {
    const c = prompt.charCodeAt(i);
    // ASCII alphanumeric range check — skips the Unicode/locale tax.
    const isAlnum =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122); // a-z
    if (!isAlnum) nonAlnum++;
  }
  const codeLike = nonAlnum / sampleSize > 0.25;
  const divisor = codeLike ? 3 : 4;
  return Math.ceil(prompt.length / divisor);
}

export interface RunToolInput<T> {
  tool: string;
  tier: Tier;
  ctx: RunContext;
  allowFallback?: boolean;
  /** Build the generate request for the given (possibly-fallback) tier. */
  build: (tier: Tier, model: string) => GenerateRequest;
  /** Turn the raw model response into the tool's result shape. */
  parse: (raw: string) => T;
  /** Optional extra warnings from guardrails (e.g. stripped citations). */
  warnings?: string[];
  /**
   * Override `think` on the generate request. If unset, inherits whatever
   * build() set. Recommended: tools set it explicitly per shape via
   * THINK_BY_SHAPE so Qwen 3 thinking behavior is predictable. Non-thinking
   * models (hermes3:8b) ignore the field.
   */
  think?: boolean;
  /**
   * Optional per-call model override (atom tools only — added v2.3.0). When
   * set, the FIRST attempt on the requested tier runs against this model
   * instead of the tier-resolved default. On timeout, fallback retries
   * resolve their model from the fallback tier — NOT this override. The
   * caller-asked model is propagated to `envelope.model_requested` so
   * receipt-backed orchestrators can detect substitution by comparing
   * `model_requested` vs `model`.
   */
  modelOverride?: string;
}

export async function runTool<T>(input: RunToolInput<T>): Promise<Envelope<T>> {
  const startedAt = Date.now();
  const { ctx } = input;
  const initialTier = input.tier;
  // Track the num_ctx that actually went on the wire for the final
  // (successful) attempt. Per-tier, so a fallback from workhorse→instant
  // picks up the instant num_ctx (or undefined if instant has none set).
  // Important: undefined means "we did NOT send num_ctx" — envelope
  // surfaces that as num_ctx_used absent, never a fake default.
  let lastNumCtx: number | undefined;

  const { value, actualTier, fallbackFrom } = await runWithTimeoutAndFallback({
    tool: input.tool,
    tier: input.tier,
    logger: ctx.logger,
    allowFallback: input.allowFallback,
    timeoutOverrideMs: ctx.timeouts,
    run: async (tier, signal) => {
      // Per-call model override applies ONLY to the initial attempt. Any
      // fallback retry resolves its model from the fallback tier so the
      // degraded path remains predictable (caller's chosen model may not
      // even fit the cheaper tier's role).
      const model =
        input.modelOverride !== undefined && tier === initialTier
          ? input.modelOverride
          : resolveTier(tier, ctx.tiers);
      // Per-tier num_ctx (v2.4.0). Resolved against the ACTIVE tier so a
      // fallback inherits the fallback tier's num_ctx (or unset). The
      // model override does not affect num_ctx — it's a model identity
      // knob, not a context-budget knob.
      const numCtx = resolveNumCtx(tier, ctx.tiers);
      const built = input.build(tier, model);
      // Merge num_ctx into the options block when set. CRITICAL: when
      // numCtx is undefined we must NOT include the key — Ollama then
      // uses its model-loaded default, which is the v2.3.0 behavior we
      // need to preserve for back-compat.
      const withNumCtx: GenerateRequest =
        numCtx !== undefined
          ? { ...built, options: { ...(built.options ?? {}), num_ctx: numCtx } }
          : built;
      const req: GenerateRequest = input.think === undefined ? withNumCtx : { ...withNumCtx, think: input.think };
      // Pre-flight context-window check — emit a guardrail event when
      // the estimated prompt tokens exceed the active num_ctx. Ollama
      // silently truncates over-budget prompts (no error, no warning)
      // and synthesizes a confidently-wrong answer from the tail; this
      // gives the operator a fighting chance to spot the truncation
      // in observability before chasing a hallucinated answer. Fire-
      // and-forget — call proceeds either way (operator may have set
      // num_ctx deliberately tight). Only checks when num_ctx is set
      // by the profile, because absent means "let Ollama choose" and
      // we have no number to compare against.
      if (numCtx !== undefined) {
        const estimatedTokens = estimatePromptTokens(req.prompt);
        if (estimatedTokens > numCtx) {
          void ctx.logger.log({
            kind: "guardrail",
            ts: timestamp(),
            tool: input.tool,
            rule: "context_window_estimate",
            action: "exceeded_estimated",
            detail: {
              estimated_tokens: estimatedTokens,
              num_ctx: numCtx,
              tier,
              prompt_chars: req.prompt.length,
            },
          });
        }
      }
      const resp = await ctx.client.generate(req, signal);
      lastNumCtx = numCtx;
      return { resp, model };
    },
  });

  const { resp, model } = value;
  const tokens = countTokens(resp);
  const result = input.parse(resp.response);
  const residency = await ctx.client.residency(model);

  const envelope = buildEnvelope<T>({
    result,
    tier: actualTier,
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: tokens.in,
    tokensOut: tokens.out,
    startedAt,
    residency,
    ...(fallbackFrom ? { fallbackFrom } : {}),
    ...(input.modelOverride !== undefined ? { modelRequested: input.modelOverride } : {}),
    ...(lastNumCtx !== undefined ? { numCtxUsed: lastNumCtx } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
  });

  await ctx.logger.log(callEvent(input.tool, envelope));
  return envelope;
}
