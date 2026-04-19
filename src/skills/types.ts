/**
 * Skill types — a Skill is a named, versioned pipeline of existing tool calls.
 *
 * Skills sit ABOVE atoms and packs. A pack is a fixed pipeline authored by the
 * product team; a skill is captured-or-authored and can be revised by the
 * learning layer in Phase 2. v0.1 runs hand-authored skills with receipts.
 */

import { z } from "zod";

/** Project overrides global by id. */
export type SkillScope = "global" | "project";

export const skillStatusSchema = z.enum(["draft", "candidate", "approved", "deprecated"]);
export type SkillStatus = z.infer<typeof skillStatusSchema>;

/**
 * `tool` is the MCP tool name as registered on the server.
 * `inputs` values may use `${step_id.result.path}` or `${input.name}` templates.
 */
export const skillStepSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  inputs: z.record(z.unknown()),
  /** If true, step errors don't abort the skill — the failure is recorded and `null` flows downstream. */
  optional: z.boolean().optional(),
});
export type SkillStep = z.infer<typeof skillStepSchema>;

export const skillTriggerSchema = z.object({
  keywords: z.array(z.string().min(1)).default([]),
  input_shape: z.record(z.string()).default({}),
});
export type SkillTrigger = z.infer<typeof skillTriggerSchema>;

export const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive().default(1),
  status: skillStatusSchema.default("draft"),
  trigger: skillTriggerSchema,
  pipeline: z.array(skillStepSchema).min(1),
  /** ID of the step whose `envelope.result` becomes the skill result. */
  result_from: z.string().min(1),
  provenance: z
    .object({
      created_at: z.string(),
      source: z.enum(["hand_authored", "captured", "revised"]).default("hand_authored"),
      runs: z.number().int().nonnegative().default(0),
      promotion_history: z
        .array(
          z.object({
            from: skillStatusSchema.optional(),
            to: skillStatusSchema,
            at: z.string(),
            reason: z.string().min(1),
          }),
        )
        .default([]),
    })
    .default({
      created_at: new Date(0).toISOString(),
      source: "hand_authored",
      runs: 0,
      promotion_history: [],
    }),
});
export type Skill = z.infer<typeof skillSchema>;

export interface LoadedSkill {
  skill: Skill;
  scope: SkillScope;
  source_path: string;
}

export interface StepRecord {
  step_id: string;
  tool: string;
  ok: boolean;
  elapsed_ms: number;
  /**
   * The step's inputs after ${input.x} / ${step_id.result.path} resolution,
   * as actually passed to the handler. Phase 2 learning needs this so a
   * "this skill revision helped" signal can be attributed to an input shape
   * change vs a prompt change vs a model tier change.
   */
  resolved_inputs?: unknown;
  envelope?: unknown;
  error?: { code: string; message: string; hint: string };
  skipped?: boolean;
}

export interface SkillReceipt {
  skill_id: string;
  skill_version: number;
  skill_source_path: string;
  started_at: string;
  elapsed_ms: number;
  hardware_profile: string;
  inputs: Record<string, unknown>;
  steps: StepRecord[];
  result: unknown;
  ok: boolean;
  receipt_path: string;
}

export interface SkillMatch {
  id: string;
  name: string;
  description: string;
  status: SkillStatus;
  scope: SkillScope;
  score: number;
  reasons: string[];
}
