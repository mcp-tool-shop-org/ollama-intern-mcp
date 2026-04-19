/**
 * Shadow runtime — wraps atom + pack invocations with the router brain.
 *
 * Law 1 (pre-execution snapshot): the RoutingContext is built BEFORE the
 * actual tool runs. Post-run state never feeds the suggestion.
 *
 * Law 2 (no live interception): the actual call runs exactly as invoked.
 * A router failure is swallowed into the receipt as `decision: null`; the
 * tool still executes. A receipt-write failure never breaks the caller.
 *
 * Law 3 (explicit actual route): the canonical identity is stamped from
 * the tool name, not inferred from outputs.
 *
 * Law 4 (skip skill-layer + meta tools): `SHADOW_TARGET_ATOMS` + the three
 * pack names are the allowlist. Everything else bypasses the shadow layer.
 */

import type { Envelope, Residency } from "../envelope.js";
import type { RunContext } from "../runContext.js";
import { toErrorShape } from "../errors.js";
import { summarizeInputShape } from "../observability.js";
import { buildRoutingContext } from "./context.js";
import { route } from "./router.js";
import { canonicalActualRoute, isShadowTargetTool } from "./actualRoute.js";
import { activeOverlay } from "./calibration/store.js";
import { EMPTY_OVERLAY } from "./calibration/types.js";
import {
  ROUTING_RECEIPT_SCHEMA_VERSION,
  classifyMatch,
  extractArtifactRef,
  extractJobHint,
  writeRoutingReceipt,
  type RoutingReceipt,
} from "./receipts.js";
import { THINK_BY_SHAPE } from "../tiers.js";

interface ShadowOptions {
  /** Override the receipts dir — test isolation only. */
  receiptsDir?: string;
  /** When true, return the completed receipt on result for tests. Default false. */
  returnReceipt?: boolean;
}

/**
 * Rough map from tool name to the THINK_BY_SHAPE key it drives. Lets the
 * receipt record whether the invocation ran with thinking ON, which Phase
 * 3D-D will want when correlating mismatches with runtime conditions.
 */
const TOOL_SHAPE: Record<string, keyof typeof THINK_BY_SHAPE> = {
  ollama_classify: "classify",
  ollama_triage_logs: "triage",
  ollama_summarize_fast: "summarize",
  ollama_summarize_deep: "summarize",
  ollama_draft: "draft",
  ollama_extract: "extract",
  ollama_chat: "chat",
  ollama_research: "research",
  ollama_corpus_search: "research",
  ollama_corpus_answer: "research",
  ollama_incident_brief: "research",
  ollama_repo_brief: "research",
  ollama_change_brief: "research",
  ollama_embed_search: "extract",
  ollama_incident_pack: "research",
  ollama_repo_pack: "research",
  ollama_change_pack: "research",
};

export async function shadowRun<T>(
  tool: string,
  input: unknown,
  ctx: RunContext,
  invoke: () => Promise<Envelope<T>>,
  opts: ShadowOptions = {},
): Promise<Envelope<T>> {
  // Skill-layer, memory-layer, artifact, corpus-management: pass through.
  if (!isShadowTargetTool(tool)) return invoke();

  const startedAt = Date.now();

  // ── Pre-execution: build context + route (best-effort) ───
  let decision = null;
  let overlayVersion: string = EMPTY_OVERLAY.version;
  try {
    const inputShape = summarizeInputShape(input);
    const jobHint = extractJobHint(input);
    const context = await buildRoutingContext({
      input_shape: inputShape,
      job_hint: jobHint ?? undefined,
    });
    let overlay = EMPTY_OVERLAY;
    try {
      overlay = await activeOverlay();
      overlayVersion = overlay.version;
    } catch {
      overlay = EMPTY_OVERLAY;
    }
    decision = route(context, overlay);
  } catch {
    decision = null;
  }

  // ── Actual execution — unchanged. Errors rethrow after receipt. ──
  let envelope: Envelope<T> | null = null;
  let ok = false;
  let errorCode: string | null = null;
  let thrown: unknown = null;
  try {
    envelope = await invoke();
    ok = true;
  } catch (err) {
    errorCode = toErrorShape(err).code;
    thrown = err;
  }

  // ── Write receipt (best-effort; never breaks the caller) ─
  if (decision) {
    try {
      const actualIdentity = canonicalActualRoute(tool);
      const match = classifyMatch(decision.suggested, actualIdentity);
      const shape = TOOL_SHAPE[tool];
      const thinkValue = shape === undefined ? null : THINK_BY_SHAPE[shape];

      const receiptBody: Omit<RoutingReceipt, "receipt_path"> = {
        schema_version: ROUTING_RECEIPT_SCHEMA_VERSION,
        recorded_at: new Date().toISOString(),
        actual: {
          route_identity: actualIdentity,
          tool,
          job_hint: extractJobHint(input),
        },
        decision,
        match,
        outcome: {
          ok,
          elapsed_ms: Date.now() - startedAt,
          ...(envelope?.tier_used ? { tier_used: envelope.tier_used } : {}),
          ...(envelope?.model ? { model: envelope.model } : {}),
          ...(envelope?.tokens_in !== undefined ? { tokens_in: envelope.tokens_in } : {}),
          ...(envelope?.tokens_out !== undefined ? { tokens_out: envelope.tokens_out } : {}),
          ...(envelope ? (() => {
            const ref = extractArtifactRef(tool, envelope as Envelope<unknown>);
            return ref ? { artifact_ref: ref } : {};
          })() : {}),
          ...(errorCode ? { error_code: errorCode } : {}),
        },
        runtime: {
          hardware_profile: ctx.hardwareProfile,
          think: thinkValue,
          calibration_version: overlayVersion,
        },
      };
      const written = await writeRoutingReceipt(receiptBody, { dir: opts.receiptsDir });
      // Attach to envelope for test inspection only when explicitly asked.
      if (opts.returnReceipt && envelope) {
        (envelope as Envelope<T> & { __routing_receipt?: RoutingReceipt }).__routing_receipt = written;
      }
    } catch {
      // Receipt-write failures must never break the caller.
    }
  }

  if (thrown !== null) throw thrown;
  return envelope!;
}

// Silence unused-var lint when Residency gets pulled in indirectly.
void ({} as Residency | null);
