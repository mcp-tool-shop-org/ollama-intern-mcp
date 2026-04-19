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
import type { ChatMessage } from "../ollama.js";
import { countTokens } from "../ollama.js";
import { resolveTier, TEMPERATURE_BY_SHAPE } from "../tiers.js";
import type { RunContext } from "../runContext.js";

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
  const model = resolveTier("workhorse", ctx.tiers);

  const messages: ChatMessage[] = input.system
    ? [{ role: "system", content: input.system }, ...input.messages]
    : input.messages;

  const resp = await ctx.client.chat({
    model,
    messages,
    options: { temperature: TEMPERATURE_BY_SHAPE.chat, num_predict: 1024 },
  });
  const tokens = countTokens(resp);
  const residency = await ctx.client.residency(model);

  const envelope = buildEnvelope<ChatResult>({
    result: { reply: resp.message.content, last_resort: true },
    tier: "workhorse",
    model,
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: tokens.in,
    tokensOut: tokens.out,
    startedAt,
    residency,
  });

  await ctx.logger.log(callEvent("ollama_chat", envelope, input));
  return envelope;
}
