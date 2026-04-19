/**
 * ollama_skill_propose — read recent skill-run receipts and surface
 * actionable lifecycle proposals: promote reliable skills, flag dominant
 * step-level failures for revision, deprecate low-success or idle skills.
 *
 * This is the learning loop's read path. It does NOT mutate skills — each
 * proposal names the next action (typically ollama_skill_promote) so the
 * operator decides whether to act.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { loadSkills } from "../skills/store.js";
import { loadReceipts, aggregateStats, type SkillTraceStats } from "../skills/traces.js";
import {
  DEFAULT_THRESHOLDS,
  proposeAll,
  type Proposal,
  type ProposalThresholds,
} from "../skills/proposer.js";
import { reconstructChains } from "../skills/chains.js";
import {
  DEFAULT_NEW_SKILL_THRESHOLDS,
  proposeNewSkills,
  type NewSkillProposal,
  type NewSkillThresholds,
} from "../skills/newSkillProposer.js";

export const skillProposeSchema = z.object({
  since: z.string().optional().describe("ISO timestamp. Consider only receipts and log events with ts >= since."),
  skill_id: z.string().optional().describe("Filter lifecycle proposals to a single skill."),
  kind: z.enum(["promote", "revise", "deprecate"]).optional().describe("Filter lifecycle proposals to one kind."),
  include_new_skills: z.boolean().optional().describe("When true (default), also reconstruct ad-hoc workflow chains from the NDJSON log and propose new skills. Set false to skip chain analysis."),
  thresholds: z
    .object({
      min_runs_for_lifecycle: z.number().int().min(1).optional(),
      promote_success_rate: z.number().min(0).max(1).optional(),
      deprecate_success_rate: z.number().min(0).max(1).optional(),
      idle_days_for_deprecation: z.number().int().min(1).optional(),
      revise_failure_count: z.number().int().min(1).optional(),
    })
    .optional()
    .describe("Override default lifecycle thresholds."),
  new_skill_thresholds: z
    .object({
      min_support: z.number().int().min(1).optional(),
      min_success_rate: z.number().min(0).max(1).optional(),
      min_shape_agreement: z.number().min(0).max(1).optional(),
      min_sequence_length: z.number().int().min(1).optional(),
    })
    .optional()
    .describe("Override defaults for new-skill detection from ad-hoc chains."),
  chain_gap_ms: z.number().int().min(1000).optional().describe("Silence gap (ms) that splits chains. Default 180000 (3 min)."),
});

export type SkillProposeInput = z.infer<typeof skillProposeSchema>;

export interface SkillProposeResult {
  proposals: Proposal[];
  /** Aggregated stats for every skill the receipts cover — useful even when no proposals fire. */
  stats: SkillTraceStats[];
  thresholds: ProposalThresholds;
  receipts_considered: number;
  /** Candidate skills detected from recurring ad-hoc workflows in the NDJSON call log. */
  new_skill_proposals: NewSkillProposal[];
  new_skill_thresholds: NewSkillThresholds;
  chains_considered: number;
}

export async function handleSkillPropose(
  input: SkillProposeInput,
  ctx: RunContext,
): Promise<Envelope<SkillProposeResult>> {
  const startedAt = Date.now();
  const receipts = await loadReceipts({ since: input.since, skill_id: input.skill_id });
  const stats = aggregateStats(receipts);
  const { skills } = await loadSkills();
  const filteredSkills = input.skill_id ? skills.filter((s) => s.skill.id === input.skill_id) : skills;
  const thresholds: ProposalThresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const now = new Date().toISOString();
  let proposals = proposeAll(filteredSkills, stats, now, thresholds);
  if (input.kind) proposals = proposals.filter((p) => p.kind === input.kind);

  const newSkillThresholds: NewSkillThresholds = {
    ...DEFAULT_NEW_SKILL_THRESHOLDS,
    ...(input.new_skill_thresholds ?? {}),
  };
  const includeNew = input.include_new_skills !== false;
  let newSkillProposals: NewSkillProposal[] = [];
  let chainsConsidered = 0;
  if (includeNew) {
    const chains = await reconstructChains({ since: input.since, gapMs: input.chain_gap_ms });
    chainsConsidered = chains.length;
    newSkillProposals = proposeNewSkills(chains, skills, newSkillThresholds);
  }

  const result: SkillProposeResult = {
    proposals,
    stats,
    thresholds,
    receipts_considered: receipts.length,
    new_skill_proposals: newSkillProposals,
    new_skill_thresholds: newSkillThresholds,
    chains_considered: chainsConsidered,
  };

  const warnings: string[] = [];
  if (receipts.length === 0) warnings.push("No skill receipts found — run ollama_skill_run to build history first.");
  if (includeNew && chainsConsidered === 0) warnings.push("No ad-hoc chains reconstructed — NDJSON log may be empty or pre-dates input-shape logging (Phase 2.5).");

  const envelope = buildEnvelope<SkillProposeResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  await ctx.logger.log(callEvent("ollama_skill_propose", envelope, input));
  return envelope;
}
