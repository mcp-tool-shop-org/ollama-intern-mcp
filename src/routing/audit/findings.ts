/**
 * Findings — typed, operator-meaningful diagnoses grounded in evidence.
 *
 * Each generator returns zero or more findings. A report with no findings
 * is a legitimate answer: the router is behaving reasonably. Findings are
 * never recommendations for *this* audit run to act on — they're what
 * Phase 3D-D's calibration pass will operate on, with operator approval.
 *
 * Five finding kinds:
 *   - promotion_gap       — same pack repeatedly succeeds on same shape → skill candidate
 *   - override_hotspot    — operator keeps picking different route than suggested
 *   - abstain_cluster     — router has no opinion on recurring shape
 *   - missed_abstain      — subset: abstain + same actual route keeps winning
 *   - unused_candidate    — strong candidate_proposal never surfaces as top suggestion
 *   - overconfident_route — router suggested high-band X; operator went Y; Y kept succeeding
 */

import type { LoadedSkill } from "../../skills/types.js";
import type { MemoryRecord } from "../../memory/types.js";
import type { RoutingReceipt } from "../receipts.js";
import { shapeSignature } from "./cluster.js";
import type { AuditFinding, AuditThresholds, FindingEvidence } from "./types.js";

export interface GenerateFindingsInput {
  receipts: RoutingReceipt[];
  approved_skills: LoadedSkill[];
  candidate_proposals: MemoryRecord[];
  thresholds: AuditThresholds;
}

// ── Helpers ─────────────────────────────────────────────────

function groupBy<T, K>(items: T[], keyFn: (x: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const it of items) {
    const k = keyFn(it);
    const list = map.get(k) ?? [];
    list.push(it);
    map.set(k, list);
  }
  return map;
}

function successRate(rs: RoutingReceipt[]): number {
  if (rs.length === 0) return 0;
  const ok = rs.filter((r) => r.outcome.ok).length;
  return ok / rs.length;
}

function artifactRefsOf(rs: RoutingReceipt[]): FindingEvidence["artifact_refs"] {
  const refs: NonNullable<FindingEvidence["artifact_refs"]> = [];
  const seen = new Set<string>();
  for (const r of rs) {
    const ref = r.outcome.artifact_ref;
    if (!ref) continue;
    const key = `${ref.pack}:${ref.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ pack: ref.pack, slug: ref.slug, json_path: ref.json_path });
  }
  return refs.length > 0 ? refs : undefined;
}

function receiptPathsOf(rs: RoutingReceipt[]): string[] {
  return rs.map((r) => r.receipt_path).filter((p) => p.length > 0).slice(0, 20);
}

function pipelineSigOfSkill(s: LoadedSkill["skill"]): string {
  return s.pipeline.map((p) => p.tool).join("→");
}

// ── Finding: promotion_gap ──────────────────────────────────
// Same pack chosen N+ times with high success on same input shape, and no
// approved/candidate skill already encodes that pipeline.

function findPromotionGaps(input: GenerateFindingsInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const packRuns = input.receipts.filter((r) => r.actual.route_identity.startsWith("pack:") && r.outcome.ok);
  const buckets = groupBy(packRuns, (r) => `${r.actual.route_identity}|${shapeSignature(r.decision.context.input_shape)}`);

  const skillPipelines = new Set(input.approved_skills.map((ls) => pipelineSigOfSkill(ls.skill)));

  for (const [key, rs] of buckets) {
    if (rs.length < input.thresholds.min_cluster_size) continue;
    const sRate = successRate(rs);
    if (sRate < input.thresholds.promotion_gap_success_rate) continue;

    const [routeIdentity, shapeSig] = key.split("|");
    const packName = routeIdentity.replace(/^pack:ollama_/, "");

    // Infer the candidate pipeline from what the router expected. Use the
    // decision's suggested.expected_tools if it matched; else fall back to
    // the pack fingerprint captured in any candidate.
    const packCandidate = rs[0].decision.candidates.find((c) => c.target.ref === packName);
    const pipelineSig = packCandidate?.target.expected_tools.join("→") ?? "";

    // Skip if an approved/candidate skill already encodes this pipeline —
    // that's NOT a promotion gap, that's the skill either unused or
    // out-competed elsewhere.
    if (pipelineSig && skillPipelines.has(pipelineSig)) continue;

    findings.push({
      kind: "promotion_gap",
      severity: sRate === 1 && rs.length >= 5 ? "high" : "medium",
      title: `Pack ${packName} succeeded ${rs.length} times on a recurring shape — promote to a skill?`,
      detail: `On input shape \`${shapeSig}\`, the pack \`${packName}\` succeeded ${rs.length}/${rs.length === 1 ? 1 : rs.length} runs at ${(sRate * 100).toFixed(0)}% success. No approved or candidate skill encodes this exact pipeline. Promoting the captured pipeline to a named skill would give operators a reusable, revisable route for this workflow.`,
      evidence: {
        receipt_paths: receiptPathsOf(rs),
        artifact_refs: artifactRefsOf(rs),
        shape_sig: shapeSig,
        success_rate: sRate,
      },
      recommended_next_action: `Author a skill with pipeline \`${pipelineSig}\`, trigger on input shape \`${shapeSig}\`. See ollama_skill_propose include_new_skills=true for an automated draft.`,
    });
  }
  return findings;
}

// ── Finding: override_hotspot ───────────────────────────────
// For the same shape_sig, suggested route differs from actual and both
// appear consistently. Operators are telling the router it's wrong.

function findOverrideHotspots(input: GenerateFindingsInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const grouped = groupBy(input.receipts, (r) => shapeSignature(r.decision.context.input_shape));

  for (const [shapeSig, rs] of grouped) {
    if (rs.length < input.thresholds.min_cluster_size) continue;
    // Where the router suggested something non-null AND it didn't match.
    const mismatches = rs.filter((r) => r.decision.suggested !== null && !r.match.matched);
    if (mismatches.length < input.thresholds.min_overrides_for_hotspot) continue;

    // Group the mismatches by (suggested, actual) pair.
    const pairGroups = groupBy(
      mismatches,
      (r) => {
        const s = r.decision.suggested;
        const suggestedId = s ? `${s.kind}:${s.ref}` : "no_suggestion";
        return `${suggestedId}→${r.actual.route_identity}`;
      },
    );

    for (const [pair, pairRs] of pairGroups) {
      if (pairRs.length < input.thresholds.min_overrides_for_hotspot) continue;
      const [suggested, actual] = pair.split("→");
      const sRate = successRate(pairRs);
      findings.push({
        kind: "override_hotspot",
        severity: sRate >= 0.8 ? "high" : "medium",
        title: `Operator overrides ${suggested} → ${actual} ${pairRs.length}× on shape \`${shapeSig}\``,
        detail: `On input shape \`${shapeSig}\`, the router suggested \`${suggested}\` but the operator picked \`${actual}\` in ${pairRs.length} run(s), with ${(sRate * 100).toFixed(0)}% success. The repeated override is a signal that scoring weights for this shape need calibration.`,
        evidence: {
          receipt_paths: receiptPathsOf(pairRs),
          shape_sig: shapeSig,
          success_rate: sRate,
        },
        recommended_next_action: `Inspect the scoring weights that produce \`${suggested}\` on this shape — likely an over-eager pack_shape_fit or a missing skill_keyword_hit. Phase 3D-D calibration territory.`,
      });
    }
  }
  return findings;
}

// ── Finding: abstain_cluster (umbrella) + missed_abstain (specific) ─

function findAbstainClusters(input: GenerateFindingsInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const abstains = input.receipts.filter((r) => r.match.kind === "abstain");
  const byShape = groupBy(abstains, (r) => shapeSignature(r.decision.context.input_shape));

  for (const [shapeSig, rs] of byShape) {
    if (rs.length < input.thresholds.min_missed_abstain_cluster) continue;

    // Are the actual routes consistent? That's the "missed_abstain" lens.
    const routeCounts = new Map<string, number>();
    for (const r of rs) {
      routeCounts.set(r.actual.route_identity, (routeCounts.get(r.actual.route_identity) ?? 0) + 1);
    }
    const sortedRoutes = [...routeCounts.entries()].sort((a, b) => b[1] - a[1]);
    const topRoute = sortedRoutes[0];
    const dominance = topRoute ? topRoute[1] / rs.length : 0;

    const sRate = successRate(rs);

    if (dominance >= 0.8 && topRoute) {
      findings.push({
        kind: "missed_abstain",
        severity: sRate >= 0.8 ? "high" : "medium",
        title: `Router abstained ${rs.length}× on shape \`${shapeSig}\` — operators consistently chose \`${topRoute[0]}\``,
        detail: `On this recurring shape, the router had no opinion but the operator ran \`${topRoute[0]}\` in ${topRoute[1]}/${rs.length} cases at ${(sRate * 100).toFixed(0)}% success. The scoring signals that would have nominated this route are missing; this is where the router should learn a route, not stay silent.`,
        evidence: {
          receipt_paths: receiptPathsOf(rs),
          shape_sig: shapeSig,
          success_rate: sRate,
        },
        recommended_next_action: `Add a calibration signal that rewards \`${topRoute[0]}\` on shape \`${shapeSig}\` — either a skill trigger that matches this shape, or a pack_shape_fit expansion. Do NOT auto-promote.`,
      });
    } else {
      findings.push({
        kind: "abstain_cluster",
        severity: "low",
        title: `Router abstained ${rs.length}× on shape \`${shapeSig}\` — no dominant actual route`,
        detail: `${rs.length} abstentions on this shape, but operator choice was varied (top route held ${(dominance * 100).toFixed(0)}% of runs). This may be a legitimately ambiguous shape, or operator behavior is still settling.`,
        evidence: {
          receipt_paths: receiptPathsOf(rs),
          shape_sig: shapeSig,
        },
        recommended_next_action: `Watch this shape for another ~${input.thresholds.min_missed_abstain_cluster * 2} runs. If a dominant route emerges, the finding will upgrade to missed_abstain.`,
      });
    }
  }

  return findings;
}

// ── Finding: unused_candidate ───────────────────────────────
// Memory carries a strong candidate_proposal that never surfaces as the
// router's top suggestion in any receipt in the window.

function findUnusedCandidates(input: GenerateFindingsInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const surfacedSigs = new Set<string>();
  for (const r of input.receipts) {
    const top = r.decision.suggested;
    if (top && top.kind === "atoms") surfacedSigs.add(top.ref);
  }

  for (const p of input.candidate_proposals) {
    const support = Number(p.facets.support ?? 0);
    const agreement = Number(p.facets.shape_agreement ?? 0);
    if (support < input.thresholds.unused_candidate_min_support) continue;
    if (agreement < input.thresholds.unused_candidate_min_shape_agreement) continue;

    const sig = p.provenance.ref;
    if (surfacedSigs.has(sig)) continue;

    findings.push({
      kind: "unused_candidate",
      severity: support >= 5 && agreement >= 0.8 ? "medium" : "low",
      title: `Candidate proposal \`${sig}\` has strong support (${support}×, ${(agreement * 100).toFixed(0)}% shape agreement) but never surfaces as a route`,
      detail: `This captured workflow has \`support=${support}\` and \`shape_agreement=${agreement.toFixed(2)}\` in the memory index, but no routing receipt in the window shows the router suggesting it as the top candidate. Either the proposer's shape doesn't align with live inputs, or the scoring weights for atom chains need a floor.`,
      evidence: {
        receipt_paths: [],
        proposal_refs: [p.id],
      },
      recommended_next_action: `Hand-author a skill draft for \`${sig}\` with approved status, or raise the \`candidate_proposal_support\` weight in calibration. Compare live input shapes to the proposal's first_step_shape to find the gap.`,
    });
  }
  return findings;
}

// ── Finding: overconfident_route ────────────────────────────
// Router suggested a high-band route; operator picked something else; the
// operator's pick kept succeeding. Strong signal that confidence is miscal.

function findOverconfidentRoutes(input: GenerateFindingsInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const rs = input.receipts.filter(
    (r) => r.decision.suggested !== null
      && !r.match.matched
      && r.decision.candidates[0]?.band === "high"
      && r.outcome.ok,
  );
  if (rs.length < input.thresholds.min_overrides_for_hotspot) return findings;

  // Group by the suggested route that lost.
  const byLoser = groupBy(rs, (r) => {
    const s = r.decision.suggested!;
    return `${s.kind}:${s.ref}`;
  });

  for (const [loser, group] of byLoser) {
    if (group.length < input.thresholds.min_overrides_for_hotspot) continue;
    const actualRoutes = new Set(group.map((r) => r.actual.route_identity));
    findings.push({
      kind: "overconfident_route",
      severity: "high",
      title: `High-band suggestion \`${loser}\` was overridden ${group.length}× with success`,
      detail: `The router labeled \`${loser}\` as high-confidence but the operator picked ${[...actualRoutes].join(", ")} instead, and those runs succeeded. High-band scoring over-weighted something for this pattern.`,
      evidence: {
        receipt_paths: receiptPathsOf(group),
        success_rate: successRate(group),
      },
      recommended_next_action: `Audit the scoring signals that produced "high" band for \`${loser}\`. Likely culprits: status_bump + one shape_fit signal inflating score without real evidence coverage.`,
    });
  }
  return findings;
}

// ── Orchestrator ────────────────────────────────────────────

const SEVERITY_ORDER: Record<AuditFinding["severity"], number> = { high: 0, medium: 1, low: 2 };

export function generateFindings(input: GenerateFindingsInput): AuditFinding[] {
  const findings: AuditFinding[] = [];
  findings.push(...findPromotionGaps(input));
  findings.push(...findOverrideHotspots(input));
  findings.push(...findAbstainClusters(input));
  findings.push(...findUnusedCandidates(input));
  findings.push(...findOverconfidentRoutes(input));
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.kind < b.kind ? -1 : 1));
  return findings;
}
