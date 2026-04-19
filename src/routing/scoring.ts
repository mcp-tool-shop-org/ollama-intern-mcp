/**
 * Score candidates against a RoutingContext.
 *
 * Every signal addition is named and reason-backed so the decision trace
 * is auditable end-to-end. A score is just the sum of signal weights; the
 * band is a function of score AND evidence coverage (we don't let a
 * well-scored candidate with thin evidence be labelled "high").
 *
 * Phase 3D-D: scoring accepts an optional CalibrationOverlay. Overlay
 * overrides merge deterministically into the default weights, band floors,
 * and pack keyword sets. Shape-targeted signals from the overlay are
 * appended after primary scoring so receipts show every overlay-sourced
 * signal with a clear calibration reason.
 */

import type {
  ConfidenceBand,
  RouteCandidate,
  RoutingContext,
  RoutingSignal,
} from "./types.js";
import { PACK_TOOL_FINGERPRINTS } from "./candidates.js";
import type { CalibrationOverlay, WeightKey } from "./calibration/types.js";
import { EMPTY_OVERLAY } from "./calibration/types.js";
import { shapeSignature } from "./audit/cluster.js";

// ── Calibration defaults ─────────────────────────────────────

export const ROUTING_WEIGHTS = {
  skill_keyword_hit_per_token: 0.5,
  skill_input_shape_match: 1.0,
  skill_status_approved: 0.4,
  skill_status_candidate: 0.2,
  skill_runs_bonus_per_run: 0.05,
  skill_runs_cap: 1.0,
  memory_success_same_skill: 0.8,
  memory_similar_neighbor: 0.3,
  memory_similar_cap: 1.0,
  candidate_proposal_support: 0.25,
  pack_shape_fit: 0.9,
  pack_supplementary_hit: 0.2,
  pack_keyword_hit_per_token: 0.4,
  corpus_available_bonus: 0.3,
  deprecated_penalty: -5.0,
  missing_required_input_penalty: -1.2,
  weak_evidence_penalty: -0.5,
  abstain_baseline: 0.2,
} as const;

export const PACK_KEYWORDS: Record<"incident_pack" | "repo_pack" | "change_pack", string[]> = {
  incident_pack: ["incident", "outage", "triage", "error", "deadlock", "stack trace"],
  repo_pack: ["repo", "repository", "orient", "oriented", "onboarding", "onboard", "understand the codebase"],
  change_pack: ["change", "review", "pr", "pull request", "diff", "breakpoint", "release note"],
};

export const ROUTING_SUGGEST_FLOOR = 0.8;

/** Default band thresholds — overlay can raise these. */
const DEFAULT_BANDS = {
  high_score: 2.0,
  high_evidence: 2,
  medium_score: 1.2,
} as const;

// ── Effective knobs (overlay-aware) ──────────────────────────

type EffectiveWeights = Readonly<Record<WeightKey, number>>;

function effectiveWeights(overlay: CalibrationOverlay): EffectiveWeights {
  return { ...ROUTING_WEIGHTS, ...overlay.weights } as EffectiveWeights;
}

function effectiveBands(overlay: CalibrationOverlay) {
  return {
    high_score: overlay.band_thresholds.high_score ?? DEFAULT_BANDS.high_score,
    high_evidence: overlay.band_thresholds.high_evidence ?? DEFAULT_BANDS.high_evidence,
    medium_score: overlay.band_thresholds.medium_score ?? DEFAULT_BANDS.medium_score,
  };
}

function effectivePackKeywords(name: keyof typeof PACK_KEYWORDS, overlay: CalibrationOverlay): string[] {
  const extra = overlay.pack_keyword_additions[name] ?? [];
  return [...new Set([...PACK_KEYWORDS[name], ...extra])];
}

/** Canonical identity for a candidate, in the same form proposals use. */
function candidateIdentity(candidate: RouteCandidate): string {
  const { kind, ref } = candidate.target;
  if (kind === "pack") return `pack:ollama_${ref}`;
  if (kind === "atoms") return `atoms:${ref}`;
  if (kind === "skill") return `skill:${ref}`;
  return "no_suggestion:";
}

// ── Skill scoring ────────────────────────────────────────────

function scoreSkillInputShape(
  skill: RoutingContext["available_skills"][number],
  ctx: RoutingContext,
  W: EffectiveWeights,
): RoutingSignal[] {
  const signals: RoutingSignal[] = [];
  const declared = Object.keys(skill.trigger.input_shape ?? {});
  if (declared.length === 0) return signals;
  let missing = 0;
  let present = 0;
  for (const key of declared) {
    const v = ctx.input_shape[key];
    const hasIt = v && v.kind !== "absent" && !(v.kind === "array" && v.length === 0);
    if (hasIt) present++;
    else missing++;
  }
  if (present > 0) {
    signals.push({
      name: "input_shape_match",
      weight: W.skill_input_shape_match * (present / declared.length),
      reason: `${present}/${declared.length} declared skill inputs present in call shape`,
    });
  }
  if (missing > 0) {
    signals.push({
      name: "missing_required_input",
      weight: W.missing_required_input_penalty * (missing / declared.length),
      reason: `${missing}/${declared.length} declared skill inputs missing`,
    });
  }
  return signals;
}

function scoreSkillKeywords(skill: RoutingContext["available_skills"][number], ctx: RoutingContext, W: EffectiveWeights): RoutingSignal[] {
  if (!ctx.job_hint || skill.trigger.keywords.length === 0) return [];
  const hint = ctx.job_hint.toLowerCase();
  const hits = skill.trigger.keywords.filter((k) => hint.includes(k.toLowerCase()));
  if (hits.length === 0) return [];
  return [{
    name: "skill_keyword_hit",
    weight: W.skill_keyword_hit_per_token * hits.length,
    reason: `${hits.length} trigger keyword(s) matched in job_hint: ${hits.slice(0, 4).join(", ")}`,
  }];
}

function scoreSkillStatus(skill: RoutingContext["available_skills"][number], W: EffectiveWeights): RoutingSignal[] {
  if (skill.status === "approved") return [{ name: "skill_status_bump", weight: W.skill_status_approved, reason: "skill status=approved" }];
  if (skill.status === "candidate") return [{ name: "skill_status_bump", weight: W.skill_status_candidate, reason: "skill status=candidate" }];
  if (skill.status === "deprecated") return [{ name: "deprecated_penalty", weight: W.deprecated_penalty, reason: "skill status=deprecated" }];
  return [];
}

function scoreSkillRunsHistory(skill: RoutingContext["available_skills"][number], W: EffectiveWeights): RoutingSignal[] {
  const runs = skill.provenance.runs ?? 0;
  if (runs === 0) return [];
  const raw = W.skill_runs_bonus_per_run * runs;
  const capped = Math.min(W.skill_runs_cap, raw);
  return [{ name: "memory_success_history", weight: capped, reason: `skill has ${runs} run(s) of history (capped contribution)` }];
}

function scoreSkillMemorySupport(
  skill: RoutingContext["available_skills"][number],
  ctx: RoutingContext,
  W: EffectiveWeights,
): { signals: RoutingSignal[]; provenance: RouteCandidate["provenance"] } {
  const signals: RoutingSignal[] = [];
  const provenance: RouteCandidate["provenance"] = [];
  const matchingHits = ctx.memory_hits.filter((r) => r.kind === "skill_receipt" && r.facets.skill_id === skill.id);
  if (matchingHits.length > 0) {
    const ok = matchingHits.filter((r) => r.facets.ok === true);
    signals.push({
      name: "memory_success_history",
      weight: W.memory_success_same_skill * Math.min(1, ok.length / 3),
      reason: `${ok.length}/${matchingHits.length} similar memory hits ran this skill successfully`,
    });
    for (const h of matchingHits.slice(0, 3)) provenance.push({ kind: "memory", ref: h.id, detail: `ok=${h.facets.ok}` });
  }
  const neighborHits = ctx.memory_hits.filter((r) => r.kind !== "skill_receipt" || r.facets.skill_id !== skill.id);
  if (neighborHits.length > 0) {
    const raw = W.memory_similar_neighbor * neighborHits.length;
    const capped = Math.min(W.memory_similar_cap, raw);
    signals.push({ name: "memory_similar_neighbor", weight: capped, reason: `${neighborHits.length} related memory neighbor(s) in context` });
  }
  return { signals, provenance };
}

function corpusBonus(ctx: RoutingContext, W: EffectiveWeights): RoutingSignal[] {
  if (!ctx.input_flags.has_corpus) return [];
  return [{ name: "corpus_available", weight: W.corpus_available_bonus, reason: "caller provided a corpus handle — grounded tools gain precision" }];
}

function buildSkillCandidateScore(
  skill: RoutingContext["available_skills"][number],
  base: RouteCandidate,
  ctx: RoutingContext,
  W: EffectiveWeights,
  overlay: CalibrationOverlay,
): RouteCandidate {
  const signals: RoutingSignal[] = [];
  const provenance: RouteCandidate["provenance"] = [{ kind: "skill", ref: skill.id, detail: skill.status }];
  signals.push(...scoreSkillInputShape(skill, ctx, W));
  signals.push(...scoreSkillKeywords(skill, ctx, W));
  signals.push(...scoreSkillStatus(skill, W));
  signals.push(...scoreSkillRunsHistory(skill, W));
  const memory = scoreSkillMemorySupport(skill, ctx, W);
  signals.push(...memory.signals);
  provenance.push(...memory.provenance);
  const usesGroundedTool = skill.pipeline.some((p) =>
    ["ollama_research", "ollama_corpus_answer", "ollama_incident_brief", "ollama_repo_brief", "ollama_change_brief"].includes(p.tool),
  );
  if (usesGroundedTool) signals.push(...corpusBonus(ctx, W));
  const missing = missingForSkill(skill, ctx);
  const score = sumSignals(signals);
  return {
    ...base,
    score,
    signals: signals.sort((a, b) => b.weight - a.weight),
    missing_signals: missing,
    provenance,
    band: bandFor(score, signals, overlay),
  };
}

function missingForSkill(skill: RoutingContext["available_skills"][number], ctx: RoutingContext): string[] {
  const missing: string[] = [];
  const declared = Object.keys(skill.trigger.input_shape ?? {});
  for (const key of declared) {
    const v = ctx.input_shape[key];
    const absent = !v || v.kind === "absent" || (v.kind === "array" && v.length === 0);
    if (absent) missing.push(`input.${key}`);
  }
  if (ctx.memory_hits.length === 0) missing.push("memory_support");
  return missing;
}

// ── Pack scoring ─────────────────────────────────────────────

function scorePackKeywords(name: keyof typeof PACK_KEYWORDS, ctx: RoutingContext, W: EffectiveWeights, overlay: CalibrationOverlay): RoutingSignal[] {
  if (!ctx.job_hint) return [];
  const hint = ctx.job_hint.toLowerCase();
  const keywords = effectivePackKeywords(name, overlay);
  const hits = keywords.filter((k) => hint.includes(k));
  if (hits.length === 0) return [];
  return [{
    name: "pack_supplementary_hit",
    weight: W.pack_keyword_hit_per_token * hits.length,
    reason: `${hits.length} ${name} keyword(s) matched in job_hint: ${hits.slice(0, 3).join(", ")}`,
  }];
}

function scorePack(base: RouteCandidate, ctx: RoutingContext, W: EffectiveWeights, overlay: CalibrationOverlay): RouteCandidate {
  const name = base.target.ref as keyof typeof PACK_TOOL_FINGERPRINTS;
  const signals: RoutingSignal[] = [];
  const missing: string[] = [];
  const provenance: RouteCandidate["provenance"] = [];
  let fit = false;
  switch (name) {
    case "incident_pack":
      if (ctx.input_flags.has_log_text) { fit = true; signals.push({ name: "pack_shape_fit", weight: W.pack_shape_fit, reason: "incident_pack expects log_text — present" }); }
      else missing.push("input.log_text");
      if (ctx.input_flags.has_source_paths) signals.push({ name: "pack_supplementary_hit", weight: W.pack_supplementary_hit, reason: "source_paths enrich the incident brief" });
      break;
    case "repo_pack":
      if (ctx.input_flags.has_source_paths) { fit = true; signals.push({ name: "pack_shape_fit", weight: W.pack_shape_fit, reason: "repo_pack expects source_paths — present" }); }
      else missing.push("input.source_paths");
      if (ctx.input_flags.has_corpus) signals.push({ name: "pack_supplementary_hit", weight: W.pack_supplementary_hit, reason: "corpus enriches onboarding orientation" });
      break;
    case "change_pack":
      if (ctx.input_flags.has_diff_text || ctx.input_flags.has_source_paths) {
        fit = true;
        signals.push({ name: "pack_shape_fit", weight: W.pack_shape_fit, reason: `change_pack expects diff_text or source_paths — ${ctx.input_flags.has_diff_text ? "diff_text" : "source_paths"} present` });
      } else missing.push("input.diff_text|source_paths");
      if (ctx.input_flags.has_log_text) signals.push({ name: "pack_supplementary_hit", weight: W.pack_supplementary_hit, reason: "log_text triggers triage inside change_pack" });
      break;
  }
  if (!fit) signals.push({ name: "missing_required_input", weight: W.missing_required_input_penalty, reason: `pack ${name} shape not matched` });
  signals.push(...scorePackKeywords(name, ctx, W, overlay));
  signals.push(...corpusBonus(ctx, W));
  const score = sumSignals(signals);
  return {
    ...base,
    score,
    signals: signals.sort((a, b) => b.weight - a.weight),
    missing_signals: missing,
    provenance,
    band: bandFor(score, signals, overlay),
  };
}

// ── Atom-chain scoring ──────────────────────────────────────

function scoreAtomChain(base: RouteCandidate, ctx: RoutingContext, W: EffectiveWeights, overlay: CalibrationOverlay): RouteCandidate {
  const signature = base.target.ref;
  const signals: RoutingSignal[] = [];
  const provenance: RouteCandidate["provenance"] = [];
  const supporting = ctx.candidate_proposals.filter((r) => r.provenance.ref === signature);
  if (supporting.length === 0) {
    signals.push({ name: "weak_evidence", weight: W.weak_evidence_penalty, reason: "no supporting candidate_proposal records" });
  } else {
    let bestSupport = 0;
    for (const r of supporting) {
      const supp = Number(r.facets.support ?? 0);
      const rate = Number(r.facets.success_rate ?? 0);
      const contribution = W.candidate_proposal_support * supp * rate;
      bestSupport = Math.max(bestSupport, contribution);
      provenance.push({ kind: "candidate_proposal", ref: r.id, detail: `support=${supp} rate=${rate}` });
    }
    signals.push({ name: "candidate_proposal_support", weight: bestSupport, reason: `captured workflow with support × success_rate = ${bestSupport.toFixed(2)}` });
  }
  signals.push(...corpusBonus(ctx, W));
  const score = sumSignals(signals);
  return {
    ...base,
    score,
    signals: signals.sort((a, b) => b.weight - a.weight),
    missing_signals: supporting.length === 0 ? ["candidate_proposal_record"] : [],
    provenance,
    band: bandFor(score, signals, overlay),
  };
}

// ── Abstain baseline ────────────────────────────────────────

function scoreAbstain(base: RouteCandidate, W: EffectiveWeights): RouteCandidate {
  const signals: RoutingSignal[] = [{ name: "weak_evidence", weight: W.abstain_baseline, reason: "abstain baseline — the router prefers silence over a weak guess" }];
  return { ...base, score: sumSignals(signals), signals, band: "abstain" };
}

// ── Shape-signal overlay application ────────────────────────

/**
 * After primary scoring, apply any overlay-sourced signals whose
 * (route_identity, shape_sig) matches this candidate. Each applied signal
 * records reason="calibration: ..." so receipts show the source clearly.
 */
function applyShapeSignals(candidate: RouteCandidate, ctx: RoutingContext, overlay: CalibrationOverlay): RouteCandidate {
  if (overlay.shape_signals.length === 0) return candidate;
  const sig = shapeSignature(ctx.input_shape);
  const id = candidateIdentity(candidate);
  const matches = overlay.shape_signals.filter((s) => s.route_identity === id && s.shape_sig === sig);
  if (matches.length === 0) return candidate;
  const extra: RoutingSignal[] = matches.map((m) => ({
    // Only names that exist in the enum are valid. Map the calibration's
    // declared `signal_name` through to a known enum value; fall back to
    // `input_shape_match` when the declared name isn't in the enum.
    name: (m.signal_name === "input_shape_match" || m.signal_name === "skill_keyword_hit"
      || m.signal_name === "pack_shape_fit" || m.signal_name === "pack_supplementary_hit"
      || m.signal_name === "corpus_available") ? m.signal_name : "input_shape_match",
    weight: m.weight,
    reason: `calibration (${overlay.version}): ${m.reason}`,
  }));
  const signals = [...candidate.signals, ...extra].sort((a, b) => b.weight - a.weight);
  const score = sumSignals(signals);
  return { ...candidate, signals, score, band: bandFor(score, signals, overlay) };
}

// ── Dispatch ────────────────────────────────────────────────

export function scoreCandidate(base: RouteCandidate, ctx: RoutingContext, overlay: CalibrationOverlay = EMPTY_OVERLAY): RouteCandidate {
  const W = effectiveWeights(overlay);
  let scored: RouteCandidate;
  switch (base.target.kind) {
    case "skill": {
      const skill = ctx.available_skills.find((s) => s.id === base.target.ref);
      if (!skill) return { ...base, score: -Infinity, band: "abstain" };
      scored = buildSkillCandidateScore(skill, base, ctx, W, overlay);
      break;
    }
    case "pack":
      scored = scorePack(base, ctx, W, overlay);
      break;
    case "atoms":
      scored = scoreAtomChain(base, ctx, W, overlay);
      break;
    case "no_suggestion":
      scored = scoreAbstain(base, W);
      break;
  }
  return applyShapeSignals(scored, ctx, overlay);
}

// ── Helpers ─────────────────────────────────────────────────

function sumSignals(signals: RoutingSignal[]): number {
  let s = 0;
  for (const sig of signals) s += sig.weight;
  return s;
}

/**
 * Band derivation. Score alone isn't enough — we also require evidence
 * coverage (a positive-weight signal beyond the status bump) to call a
 * candidate "high" or "medium".
 */
export function bandFor(score: number, signals: RoutingSignal[], overlay: CalibrationOverlay = EMPTY_OVERLAY): ConfidenceBand {
  if (score < ROUTING_SUGGEST_FLOOR) return "abstain";
  const evidence = signals.filter((s) => s.weight > 0 && s.name !== "skill_status_bump");
  if (evidence.length === 0) return "low";
  const bands = effectiveBands(overlay);
  if (score >= bands.high_score && evidence.length >= bands.high_evidence) return "high";
  if (score >= bands.medium_score) return "medium";
  return "low";
}
