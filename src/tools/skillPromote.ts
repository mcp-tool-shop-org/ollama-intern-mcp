/**
 * ollama_skill_promote — move a skill between lifecycle statuses with a
 * reason recorded in provenance.promotion_history. v0.1 handles status
 * transitions only; pipeline revisions are direct JSON edits by the
 * operator (the "why" is still tracked here by re-promoting with a reason).
 *
 * The in-place file rewrite is deliberately scoped: only status and
 * promotion_history change. Other fields are untouched.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { InternError } from "../errors.js";
import { getSkill } from "../skills/store.js";
import { promoteSkill, type PromotionOutput } from "../skills/promoter.js";

export const skillPromoteSchema = z.object({
  skill_id: z.string().min(1).describe("Id of the skill to transition."),
  target: z.enum(["draft", "candidate", "approved", "deprecated"]).describe("Status to transition to."),
  reason: z.string().min(1).describe("Why this transition is happening — recorded in provenance.promotion_history for later review."),
});

export type SkillPromoteInput = z.infer<typeof skillPromoteSchema>;

export async function handleSkillPromote(
  input: SkillPromoteInput,
  ctx: RunContext,
): Promise<Envelope<PromotionOutput>> {
  const startedAt = Date.now();
  const loaded = await getSkill(input.skill_id);
  if (!loaded) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Unknown skill "${input.skill_id}".`,
      "Call ollama_skill_list to see available skills.",
      false,
    );
  }
  let result: PromotionOutput;
  try {
    result = await promoteSkill(loaded, { target: input.target, reason: input.reason });
  } catch (err) {
    throw new InternError(
      "SCHEMA_INVALID",
      err instanceof Error ? err.message : String(err),
      "Lifecycle transitions must be valid: draft→candidate/approved/deprecated, candidate→approved/draft/deprecated, approved→candidate/deprecated, deprecated→draft/candidate/approved.",
      false,
    );
  }
  const envelope = buildEnvelope<PromotionOutput>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_skill_promote", envelope, input));
  return envelope;
}
