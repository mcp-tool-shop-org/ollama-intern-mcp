/**
 * ollama_skill_list — enumerate available skills (global + project).
 *
 * No model call, no tier. Pure filesystem metadata, wrapped in the standard
 * envelope so it composes with the rest of the surface.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { loadSkills } from "../skills/store.js";
import type { SkillScope, SkillStatus } from "../skills/types.js";

export const skillListSchema = z.object({
  scope: z.enum(["global", "project", "all"]).optional().describe("Filter by where the skill lives. Default: all."),
  status: z
    .enum(["draft", "candidate", "approved", "deprecated"])
    .optional()
    .describe("Filter by lifecycle status."),
});

export type SkillListInput = z.infer<typeof skillListSchema>;

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  version: number;
  status: SkillStatus;
  scope: SkillScope;
  source_path: string;
  pipeline_tools: string[];
  runs: number;
}

export interface SkillListResult {
  skills: SkillListItem[];
  warnings: Array<{ path: string; reason: string }>;
  global_dir: string;
  project_dir: string;
}

export async function handleSkillList(
  input: SkillListInput,
  ctx: RunContext,
): Promise<Envelope<SkillListResult>> {
  const startedAt = Date.now();
  const { skills, warnings } = await loadSkills();
  const scopeFilter = input.scope ?? "all";
  const items: SkillListItem[] = skills
    .filter((s) => scopeFilter === "all" || s.scope === scopeFilter)
    .filter((s) => !input.status || s.skill.status === input.status)
    .map((s) => ({
      id: s.skill.id,
      name: s.skill.name,
      description: s.skill.description,
      version: s.skill.version,
      status: s.skill.status,
      scope: s.scope,
      source_path: s.source_path,
      pipeline_tools: s.skill.pipeline.map((p) => p.tool),
      runs: s.skill.provenance.runs,
    }));

  const { globalSkillsDir, projectSkillsDir } = await import("../skills/store.js");
  const result: SkillListResult = {
    skills: items,
    warnings,
    global_dir: globalSkillsDir(),
    project_dir: projectSkillsDir(),
  };

  const envelope = buildEnvelope<SkillListResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(warnings.length > 0
      ? { warnings: warnings.map((w) => `${w.path}: ${w.reason}`) }
      : {}),
  });
  await ctx.logger.log(callEvent("ollama_skill_list", envelope, input));
  return envelope;
}
