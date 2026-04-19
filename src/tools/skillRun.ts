/**
 * ollama_skill_run — execute a known skill by id with caller-supplied inputs.
 *
 * Returns the skill's final result plus a receipt record. The receipt is also
 * written to disk at <cwd>/artifacts/skill-receipts/ so Phase 2's learning
 * loop has a durable trace to revise from.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { InternError } from "../errors.js";
import { getSkill } from "../skills/store.js";
import { runSkill } from "../skills/runner.js";
import type { SkillReceipt } from "../skills/types.js";

export const skillRunSchema = z.object({
  skill_id: z.string().min(1).describe("Id of the skill to execute (match via ollama_skill_match or list via ollama_skill_list)."),
  inputs: z.record(z.unknown()).optional().describe("Caller-supplied inputs referenced in the skill's pipeline as ${input.name}."),
});

export type SkillRunInput = z.infer<typeof skillRunSchema>;

export interface SkillRunResult {
  skill_id: string;
  skill_version: number;
  ok: boolean;
  result: unknown;
  receipt: SkillReceipt;
}

export async function handleSkillRun(
  input: SkillRunInput,
  ctx: RunContext,
): Promise<Envelope<SkillRunResult>> {
  const startedAt = Date.now();
  const loaded = await getSkill(input.skill_id);
  if (!loaded) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Unknown skill "${input.skill_id}".`,
      "Call ollama_skill_list to see available skills, or author one in <cwd>/skills/<id>.json.",
      false,
    );
  }

  const { result, receipt } = await runSkill(loaded, ctx, { inputs: input.inputs ?? {} });

  const envelope = buildEnvelope<SkillRunResult>({
    result: {
      skill_id: loaded.skill.id,
      skill_version: loaded.skill.version,
      ok: receipt.ok,
      result,
      receipt,
    },
    tier: "instant", // skill runner doesn't call a model itself; per-step envelopes carry tier info
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(receipt.ok
      ? {}
      : { warnings: ["skill run ended with ok=false — see receipt.steps for the failing step"] }),
  });
  await ctx.logger.log(callEvent("ollama_skill_run", envelope, input));
  return envelope;
}
