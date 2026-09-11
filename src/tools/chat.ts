/**
 * ollama_chat — LAST RESORT catch-all. Tier: Workhorse.
 *
 * Visibly second-class. The product wins when people think in *jobs*, not chats.
 * If you find yourself reaching for this often, a specialty tool is missing
 * and should be added. Do not treat this as the normal entrypoint.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { ChatMessage, ChatRequest, ChatResponse } from "../ollama.js";
import { countTokens } from "../ollama.js";
import { resolveTier, resolveNumCtx, TEMPERATURE_BY_SHAPE, THINK_BY_SHAPE } from "../tiers.js";
import { runWithTimeoutAndFallback } from "../guardrails/timeouts.js";
import { getRoutingInfo, setRouteDirective } from "../routing.js";
import { cloudMayServe } from "../profiles.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import { backendField } from "./_helpers.js";

export const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1)
    .describe("Chat messages. Last-resort shape — prefer a specialty tool when one fits."),
  system: z.string().optional().describe("Optional system preface; merged with any existing system message."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional per-call model override. When provided, overrides the " +
        "tool's tier-resolved (workhorse) model for this single attempt. " +
        "The workhorse-tier timeout (TIER_TIMEOUT_MS) applies; on timeout the " +
        "call fails with TIER_TIMEOUT — chat is single-attempt, with no tier " +
        "fallback. Use for receipt-backed orchestration that requires explicit " +
        "model identity (e.g., research-os reviewer profiles).",
    ),
  // F2c: the describe text now lives in _helpers.backendField, shared
  // verbatim with the twelve tools that gained the knob in v2.9.2. chat
  // shipped it first; it is no longer the only tool that has it.
  backend: backendField,
});

export type ChatInput = z.infer<typeof chatSchema>;

export interface ChatResult {
  reply: string;
  last_resort: true;
}

export async function handleChat(
  input: ChatInput,
  ctx: RunContext,
): Promise<Envelope<ChatResult>> {
  const startedAt = Date.now();

  // F2b: refuse a cloud escalation when no cloud is configured — mirror of
  // the runner's gate, since chat drives the client directly.
  if (input.backend === "cloud" && !ctx.cloud) {
    throw new InternError(
      "CLOUD_NOT_CONFIGURED",
      "ollama_chat requested backend:'cloud' but no Ollama Cloud is configured.",
      "Set OLLAMA_API_KEY (create a key at https://ollama.com/settings/keys) to arm cloud standby — calls stay local unless they request backend:'cloud'. Optionally set OLLAMA_CLOUD_PRIMARY=1 for cloud-primary routing. This call was refused, not silently served by the local model.",
      false,
    );
  }

  // Per-call model override (v2.3.0). Falls back to tier-resolved model when
  // omitted. chat is a single workhorse attempt — no TIER_FALLBACK — so the
  // override (or the resolved workhorse model) is the only model used.
  const model = input.model ?? resolveTier("workhorse", ctx.tiers);

  const messages: ChatMessage[] = input.system
    ? [{ role: "system", content: input.system }, ...input.messages]
    : input.messages;

  // Per-tier num_ctx (v2.4.0). chat runs on workhorse; a single resolved value
  // covers the call. Absent when the profile doesn't set workhorse num_ctx.
  const numCtx = resolveNumCtx("workhorse", ctx.tiers);
  // 4096 (was 1024): chat is the catch-all long-form jobs fall back to.
  const options: { temperature?: number; num_predict?: number; num_ctx?: number } = {
    temperature: TEMPERATURE_BY_SHAPE.chat,
    num_predict: 4096,
    ...(numCtx !== undefined ? { num_ctx: numCtx } : {}),
  };

  // H4: previously ctx.client.chat(req) ran with NO tier and NO AbortSignal.
  // Without a tier, cloud-primary routing served local unconditionally (chat
  // never used cloud, carried no backend provenance); without a signal, a
  // wedged local model held a global semaphore permit for minutes while the
  // schema falsely claimed a timeout applied. Run the single workhorse attempt
  // through runWithTimeoutAndFallback so it carries a tier-bounded AbortSignal,
  // and pass tier='workhorse' so routing can reach cloud. allowFallback:false
  // preserves chat's deliberate single-attempt shape (no tier cascade).
  //
  // When cloud may serve this call (primary mode, or a per-call escalation —
  // F2), the outer budget must cover BOTH the cloud attempt and the local
  // fallback the RoutingOllamaClient runs inside one chat() call (mirrors
  // runToolInner's effectiveTimeouts) — sum cloud+local. Standby-without-
  // directive and local-only: just the local workhorse budget.
  const budgetMs = cloudMayServe(ctx.cloud, input.backend)
    ? ctx.cloud!.timeouts.workhorse + ctx.timeouts.workhorse
    : ctx.timeouts.workhorse;
  const { value: resp } = await runWithTimeoutAndFallback<ChatResponse>({
    tool: "ollama_chat",
    tier: "workhorse",
    logger: ctx.logger,
    allowFallback: false,
    modelFor: () => model,
    timeoutOverrideMs: { instant: budgetMs, workhorse: budgetMs, deep: budgetMs, embed: budgetMs },
    // chat was the ONLY generate-shaped tool not passing `think`; on a thinking
    // model CoT consumed the whole num_predict and content came back empty (the
    // 2026-06-09 minimax-m3:cloud incident). Suppress CoT like draft/extract.
    run: (tier, signal) => {
      const chatReq: ChatRequest = { model, messages, options, think: THINK_BY_SHAPE.chat };
      // F2b: per-call directive — backend escalation/pin, and mark an
      // explicit caller model so the cloud path honors it instead of
      // clobbering it with the tier map (the v2.3.0-override audit fix).
      const modelExplicit = input.model !== undefined;
      if (input.backend !== undefined || modelExplicit) {
        setRouteDirective(chatReq, {
          ...(input.backend !== undefined ? { backend: input.backend } : {}),
          ...(modelExplicit ? { modelExplicit: true } : {}),
        });
      }
      return ctx.client.chat(chatReq, signal, tier);
    },
  });

  // Backend routing provenance (cloud-primary). Undefined on the local-only
  // path — every field below then behaves exactly as before.
  const routing = getRoutingInfo(resp);
  const actualModel = routing?.model ?? model;
  const tokens = countTokens(resp);
  // Residency is a local-VRAM concept: a cloud-served call has none.
  const residency = routing?.backend === "cloud" ? null : await ctx.client.residency(actualModel);
  // num_ctx_used must report the num_ctx actually SENT — the cloud cap on a
  // cloud-served call — matching runner.ts, not the local resolved value.
  const numCtxUsed = routing?.num_ctx ?? numCtx;

  const envelope = buildEnvelope<ChatResult>({
    result: { reply: resp.message.content, last_resort: true },
    tier: "workhorse",
    model: actualModel,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: tokens.in,
    tokensOut: tokens.out,
    startedAt,
    residency,
    ...(routing?.backend ? { backend: routing.backend } : {}),
    ...(routing?.degraded ? { degraded: true } : {}),
    ...(routing?.degrade_reason ? { degradeReason: routing.degrade_reason } : {}),
    ...(input.model !== undefined ? { modelRequested: input.model } : {}),
    ...(numCtxUsed !== undefined ? { numCtxUsed } : {}),
  });

  await ctx.logger.log(callEvent("ollama_chat", envelope));
  return envelope;
}
