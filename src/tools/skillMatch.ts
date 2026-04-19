/**
 * ollama_skill_match — given a free-text task description, return candidate
 * skills ranked by fit. v0 uses keyword-overlap scoring; Phase 2 adds
 * embedding-based similarity on top.
 *
 * Callers (including Claude) can use this as the "do I already know how to
 * do this?" check before falling back to a generic atom/pack sequence.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { loadSkills } from "../skills/store.js";
import { matchSkills } from "../skills/matcher.js";
import type { SkillMatch } from "../skills/types.js";

export const skillMatchSchema = z.object({
  task: z.string().min(1).describe("Free-text description of what the caller wants to do."),
  limit: z.number().int().min(1).max(25).optional().describe("Cap on returned matches (default 5)."),
  include_drafts: z.boolean().optional().describe("Include draft-status skills in results. Default false."),
});

export type SkillMatchInput = z.infer<typeof skillMatchSchema>;

export interface SkillMatchResult {
  matches: SkillMatch[];
  /** How many skills were considered before scoring. */
  considered: number;
}

export async function handleSkillMatch(
  input: SkillMatchInput,
  ctx: RunContext,
): Promise<Envelope<SkillMatchResult>> {
  const startedAt = Date.now();
  const { skills } = await loadSkills();
  const pool = input.include_drafts ? skills : skills.filter((s) => s.skill.status !== "draft");
  const matches = matchSkills(pool, input.task, input.limit ?? 5);
  const envelope = buildEnvelope<SkillMatchResult>({
    result: { matches, considered: pool.length },
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_skill_match", envelope, input));
  return envelope;
}
