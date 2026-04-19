/**
 * Skill proposer — reads trace stats and emits actionable proposals.
 *
 * v0.1 scope is DELIBERATELY NARROW. The proposer inspects existing skills
 * and surfaces three signal types, each with a reason and a concrete next
 * action the operator can take via ollama_skill_promote:
 *
 *   1. PROMOTION candidates — skills with run_count ≥ threshold and
 *      success_rate ≥ threshold, still sitting at draft/candidate status.
 *   2. REVISION candidates — skills with a dominant step-level failure
 *      (e.g. brief step fails 4/5 times with SCHEMA_INVALID). The proposer
 *      names the step and error class so the operator knows where to look.
 *   3. DEPRECATION candidates — skills with run_count ≥ threshold and
 *      success_rate < floor, or skills approved but unused for N days.
 *
 * It does NOT yet propose NEW skills from ad-hoc atom chains — that needs
 * input-shape logging in the NDJSON trace, which is Phase 2.5.
 */

import type { LoadedSkill } from "./types.js";
import type { SkillTraceStats } from "./traces.js";

export type ProposalKind = "promote" | "revise" | "deprecate";

export interface Proposal {
  kind: ProposalKind;
  skill_id: string;
  current_status: string;
  suggested_status?: string;
  reason: string;
  /** Structured evidence so operators can verify before acting. */
  evidence: {
    run_count: number;
    success_rate: number;
    median_elapsed_ms: number;
    last_run_at: string | null;
    dominant_failure?: { step_id: string; tool: string; error_code: string; count: number };
    idle_days?: number;
  };
}

export interface ProposalThresholds {
  /** Minimum runs before promotion/deprecation is considered. */
  min_runs_for_lifecycle: number;
  /** Success rate floor for promotion (draft/candidate → approved). */
  promote_success_rate: number;
  /** Success rate below which approved skills become deprecation candidates. */
  deprecate_success_rate: number;
  /** A skill approved but unused for this many days becomes a deprecation candidate. */
  idle_days_for_deprecation: number;
  /** A step is a revision candidate when it fails this many times AND is ≥60% of that skill's failures. */
  revise_failure_count: number;
}

export const DEFAULT_THRESHOLDS: ProposalThresholds = {
  min_runs_for_lifecycle: 3,
  promote_success_rate: 0.8,
  deprecate_success_rate: 0.3,
  idle_days_for_deprecation: 30,
  revise_failure_count: 2,
};

function daysBetween(a: string, b: string): number {
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) return 0;
  return Math.abs(mb - ma) / (1000 * 60 * 60 * 24);
}

export function proposeForSkill(
  loaded: LoadedSkill,
  stats: SkillTraceStats | undefined,
  now: string,
  t: ProposalThresholds = DEFAULT_THRESHOLDS,
): Proposal[] {
  const proposals: Proposal[] = [];
  const status = loaded.skill.status;
  if (!stats || stats.run_count === 0) return proposals;

  const baseEvidence = {
    run_count: stats.run_count,
    success_rate: stats.success_rate,
    median_elapsed_ms: stats.median_elapsed_ms,
    last_run_at: stats.last_run_at,
  };

  // PROMOTE — reliably succeeding skills should graduate.
  if (
    (status === "draft" || status === "candidate") &&
    stats.run_count >= t.min_runs_for_lifecycle &&
    stats.success_rate >= t.promote_success_rate
  ) {
    proposals.push({
      kind: "promote",
      skill_id: loaded.skill.id,
      current_status: status,
      suggested_status: status === "draft" ? "candidate" : "approved",
      reason: `Skill has succeeded ${stats.success_count}/${stats.run_count} times (${(stats.success_rate * 100).toFixed(0)}%) — threshold is ${(t.promote_success_rate * 100).toFixed(0)}% at ${t.min_runs_for_lifecycle}+ runs.`,
      evidence: baseEvidence,
    });
  }

  // REVISE — dominant step-level failures.
  if (stats.failure_profile.length > 0) {
    const dominant = stats.failure_profile[0];
    const dominantShare = stats.failure_count === 0 ? 0 : dominant.failure_count / stats.failure_count;
    if (dominant.failure_count >= t.revise_failure_count && dominantShare >= 0.6) {
      proposals.push({
        kind: "revise",
        skill_id: loaded.skill.id,
        current_status: status,
        reason: `Step "${dominant.step_id}" (${dominant.tool}) fails ${dominant.failure_count} times, ${(dominantShare * 100).toFixed(0)}% of this skill's failures — dominant error code: ${dominant.top_error_code}.`,
        evidence: {
          ...baseEvidence,
          dominant_failure: {
            step_id: dominant.step_id,
            tool: dominant.tool,
            error_code: dominant.top_error_code,
            count: dominant.failure_count,
          },
        },
      });
    }
  }

  // DEPRECATE — low-success or idle-approved skills.
  if (
    status === "approved" &&
    stats.run_count >= t.min_runs_for_lifecycle &&
    stats.success_rate < t.deprecate_success_rate
  ) {
    proposals.push({
      kind: "deprecate",
      skill_id: loaded.skill.id,
      current_status: status,
      suggested_status: "deprecated",
      reason: `Skill succeeds only ${(stats.success_rate * 100).toFixed(0)}% of the time over ${stats.run_count} runs — below floor of ${(t.deprecate_success_rate * 100).toFixed(0)}%.`,
      evidence: baseEvidence,
    });
  } else if (status === "approved" && stats.last_run_at) {
    const idleDays = daysBetween(stats.last_run_at, now);
    if (idleDays >= t.idle_days_for_deprecation) {
      proposals.push({
        kind: "deprecate",
        skill_id: loaded.skill.id,
        current_status: status,
        suggested_status: "deprecated",
        reason: `Approved skill has not run in ${idleDays.toFixed(0)} days (threshold ${t.idle_days_for_deprecation}). Confirm it is still useful or deprecate to keep the catalog honest.`,
        evidence: { ...baseEvidence, idle_days: Math.round(idleDays) },
      });
    }
  }

  return proposals;
}

export function proposeAll(
  loaded: LoadedSkill[],
  stats: SkillTraceStats[],
  now: string,
  t: ProposalThresholds = DEFAULT_THRESHOLDS,
): Proposal[] {
  const byId = new Map<string, SkillTraceStats>();
  for (const s of stats) byId.set(s.skill_id, s);
  const all: Proposal[] = [];
  for (const l of loaded) {
    all.push(...proposeForSkill(l, byId.get(l.skill.id), now, t));
  }
  // Sort: revise first (most actionable), then promote, then deprecate; within kind by skill id.
  const order: Record<ProposalKind, number> = { revise: 0, promote: 1, deprecate: 2 };
  return all.sort((a, b) => order[a.kind] - order[b.kind] || (a.skill_id < b.skill_id ? -1 : 1));
}
