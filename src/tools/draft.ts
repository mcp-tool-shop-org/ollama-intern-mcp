/**
 * ollama_draft — DRAFT code/prose stubs. Tier: Workhorse.
 *
 * Always marked DRAFT — Claude reviews before writing to disk.
 * - target_path + protected-path rules: refuses without confirm_write: true
 * - language known: compile check runs and {compiles, checker, stderr_tail} rides the envelope
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { assertWriteAllowed } from "../guardrails/writeConfirm.js";
import { compileCheck, type CompileCheckResult } from "../guardrails/compileCheck.js";
import { findBannedPhrases, type BannedPhraseMatch } from "../guardrails/bannedPhrases.js";
import { InternError } from "../errors.js";
import { timestamp } from "../observability.js";
import type { RunContext } from "../runContext.js";

const DOC_MAX_ATTEMPTS = 3;

export const draftSchema = z.object({
  prompt: z.string().min(1).describe("What to draft. Be concrete."),
  language: z
    .enum(["typescript", "javascript", "python", "rust", "go"])
    .optional()
    .describe("If set, compile check runs and compiles/stderr_tail ride the envelope."),
  style: z.enum(["concise", "doc"]).optional().describe("'concise' for code-only, 'doc' for docstrings/prose."),
  target_path: z.string().optional().describe("If this draft is destined for a file, declare it — protected paths enforce confirm_write."),
  confirm_write: z.boolean().optional().describe("Required when target_path is inside a protected path."),
});

export type DraftInput = z.infer<typeof draftSchema>;

export interface DraftResult {
  draft: string;
  is_draft: true;
  compile_check?: CompileCheckResult;
  /** Number of regeneration rounds triggered by the banned-phrase guard (style="doc" only). 0 means the first attempt passed. */
  regenerations_triggered?: number;
  /** Phrases detected in rejected attempts, deduped in order of first appearance. */
  detected_phrases?: string[];
}

function buildPrompt(input: DraftInput): string {
  const style = input.style ?? "concise";
  const codeRules = input.language
    ? [
        `Return only the code — no prose, no markdown fences, no commentary.`,
        `Language: ${input.language}.`,
      ].join("\n")
    : style === "doc"
    ? `Return polished prose. No preamble.`
    : `Return the shortest complete answer that satisfies the request.`;
  return [codeRules, ``, `Request:`, input.prompt].join("\n");
}

export async function handleDraft(
  input: DraftInput,
  ctx: RunContext,
): Promise<Envelope<DraftResult>> {
  try {
    assertWriteAllowed({ target_path: input.target_path, confirm_write: input.confirm_write });
  } catch (err) {
    await ctx.logger.log({
      kind: "guardrail",
      ts: timestamp(),
      tool: "ollama_draft",
      rule: "writeConfirm",
      action: "blocked",
      detail: { target_path: input.target_path },
    });
    throw err;
  }

  const runOnce = async (): Promise<Envelope<DraftResult>> =>
    runTool<DraftResult>({
      tool: "ollama_draft",
      tier: "workhorse",
      ctx,
      logInput: input,
      think: false,
      build: (_tier, model) => ({
        model,
        prompt: buildPrompt(input),
        options: { temperature: TEMPERATURE_BY_SHAPE.draft, num_predict: 1024 },
      }),
      parse: (raw) => ({ draft: stripCodeFence(raw), is_draft: true }),
    });

  let envelope: Envelope<DraftResult>;
  const detectedPhraseLog: string[] = [];
  let regenerations = 0;

  if (input.style === "doc") {
    let attempt = 0;
    let lastMatches: BannedPhraseMatch[] = [];
    envelope = await runOnce();
    attempt = 1;
    lastMatches = findBannedPhrases(envelope.result.draft);
    while (lastMatches.length > 0 && attempt < DOC_MAX_ATTEMPTS) {
      for (const m of lastMatches) {
        if (!detectedPhraseLog.includes(m.phrase)) detectedPhraseLog.push(m.phrase);
      }
      await ctx.logger.log({
        kind: "guardrail",
        ts: timestamp(),
        tool: "ollama_draft",
        rule: "bannedPhrases",
        action: "regenerated",
        detail: { attempt, detected: lastMatches.map((m) => m.phrase) },
      });
      regenerations += 1;
      envelope = await runOnce();
      attempt += 1;
      lastMatches = findBannedPhrases(envelope.result.draft);
    }

    if (lastMatches.length > 0) {
      for (const m of lastMatches) {
        if (!detectedPhraseLog.includes(m.phrase)) detectedPhraseLog.push(m.phrase);
      }
      await ctx.logger.log({
        kind: "guardrail",
        ts: timestamp(),
        tool: "ollama_draft",
        rule: "bannedPhrases",
        action: "blocked",
        detail: { attempts: attempt, detected: detectedPhraseLog },
      });
      throw new InternError(
        "DRAFT_BANNED_PHRASE",
        `draft(style="doc") produced banned marketing phrases after ${attempt} attempts: ${detectedPhraseLog.join(", ")}`,
        `Rewrite the prompt to demand concrete, falsifiable claims — e.g. "name a specific capability and a measurable outcome; avoid words like 'seamless', 'effortless', 'leverage'". Consider style="concise" if brevity matters more than tone.`,
        true,
      );
    }

    if (regenerations > 0) envelope.result.regenerations_triggered = regenerations;
    if (detectedPhraseLog.length > 0) envelope.result.detected_phrases = detectedPhraseLog;
  } else {
    envelope = await runOnce();
  }

  if (input.language) {
    envelope.result.compile_check = await compileCheck(envelope.result.draft, input.language);
  }

  return envelope;
}

function stripCodeFence(s: string): string {
  const t = s.trim();
  const fenceMatch = t.match(/^```(?:[a-zA-Z0-9]*)\n([\s\S]*?)\n```$/);
  return fenceMatch ? fenceMatch[1] : t;
}
