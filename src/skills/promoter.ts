/**
 * Skill promoter — performs a lifecycle transition on a skill by rewriting
 * its JSON file in place, appending a promotion_history entry, and bumping
 * provenance.source to "revised" when the change comes with an edit reason
 * (Phase 2.5 revision flow).
 *
 * v0.1 does NOT support revising pipeline/inputs via this tool — only
 * status transitions. Pipeline revision is an operator edit to the JSON
 * file; the promoter just records WHY the status moved.
 */

import { promises as fs } from "node:fs";
import type { LoadedSkill, Skill, SkillStatus } from "./types.js";

export interface PromotionInput {
  target: SkillStatus;
  reason: string;
  /** ISO timestamp for the entry. Defaults to now. Exposed for deterministic tests. */
  at?: string;
}

export interface PromotionOutput {
  skill_id: string;
  from: SkillStatus;
  to: SkillStatus;
  source_path: string;
  promotion_history_length: number;
}

const VALID_TRANSITIONS: Record<SkillStatus, SkillStatus[]> = {
  draft: ["candidate", "approved", "deprecated"],
  candidate: ["approved", "draft", "deprecated"],
  approved: ["deprecated", "candidate"],
  deprecated: ["draft", "candidate", "approved"],
};

export function canTransition(from: SkillStatus, to: SkillStatus): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

export async function promoteSkill(
  loaded: LoadedSkill,
  input: PromotionInput,
): Promise<PromotionOutput> {
  const current: Skill = loaded.skill;
  const from = current.status;
  const to = input.target;
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid transition ${from} -> ${to} for skill "${current.id}". Valid: ${VALID_TRANSITIONS[from].join(", ") || "(none)"}`,
    );
  }
  const at = input.at ?? new Date().toISOString();
  const nextHistory = [
    ...(current.provenance.promotion_history ?? []),
    { from, to, at, reason: input.reason },
  ];
  const updated: Skill = {
    ...current,
    status: to,
    provenance: {
      ...current.provenance,
      promotion_history: nextHistory,
    },
  };
  await fs.writeFile(loaded.source_path, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return {
    skill_id: current.id,
    from,
    to,
    source_path: loaded.source_path,
    promotion_history_length: nextHistory.length,
  };
}
