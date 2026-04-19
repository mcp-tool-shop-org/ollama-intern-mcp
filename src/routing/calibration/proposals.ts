/**
 * Proposal generator — audit findings → structured calibration proposals.
 *
 * Four mappings today, each concrete and narrow:
 *   missed_abstain       → add_shape_signal (reward dominant route on this shape)
 *   override_hotspot     → adjust_weight   (damp the signal the suggestion over-weighted)
 *   overconfident_route  → raise_band_floor (demand more evidence for "high")
 *   unused_candidate     → adjust_weight   (bump candidate_proposal_support)
 *
 * Every proposal carries:
 *   - id        (stable hash of kind + target + change)
 *   - source_finding + source_receipt_paths  (attribution)
 *   - rationale (grounded sentence the operator reads)
 *   - qualitative expected_effect  (replay fills in the numbers later)
 *
 * Generator is PURE: it never reads disk, never mutates state.
 */

import { createHash } from "node:crypto";
import type { AuditFinding } from "../audit/types.js";
import {
  CALIBRATION_SCHEMA_VERSION,
  type CalibrationProposal,
  type WeightKey,
} from "./types.js";

function hash(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

function proposalId(parts: Record<string, unknown>): string {
  return `calibration:${hash(parts)}`;
}

function baseProposal(f: AuditFinding, now: string): Omit<CalibrationProposal, "id" | "kind" | "target" | "change" | "rationale" | "expected_effect"> {
  return {
    schema_version: CALIBRATION_SCHEMA_VERSION,
    generated_at: now,
    source_finding: f.kind,
    source_receipt_paths: [...(f.evidence.receipt_paths ?? [])],
    status: "proposed",
    history: [{ at: now, transition: "proposed", reason: `generated from audit finding: ${f.kind}` }],
  };
}

// ── missed_abstain → add_shape_signal ───────────────────────

function fromMissedAbstain(f: AuditFinding, now: string): CalibrationProposal | null {
  const shapeSig = f.evidence.shape_sig;
  if (!shapeSig) return null;
  // The finding's title names the actual route (e.g. "atom:ollama_classify").
  // Parse it out — the finding's schema guarantees the pattern.
  const routeMatch = f.title.match(/chose `([^`]+)`/);
  const routeIdentity = routeMatch?.[1];
  if (!routeIdentity) return null;

  const weight = 1.0; // starting floor — replay will quantify effect
  const parts = { kind: "add_shape_signal", route_identity: routeIdentity, shape_sig: shapeSig, weight };
  const base = baseProposal(f, now);
  return {
    ...base,
    id: proposalId(parts),
    kind: "add_shape_signal",
    target: { route_identity: routeIdentity, shape_sig: shapeSig },
    change: {
      kind: "add_shape_signal",
      signal_name: "input_shape_match", // we're strengthening shape matching for this route
      weight,
      reason: `calibration: shape match for ${routeIdentity}`,
    },
    rationale: `Router abstained on shape \`${shapeSig}\` across ${base.source_receipt_paths.length} receipts where the operator successfully ran \`${routeIdentity}\`. Adding a shape-targeted reward lets the router nominate this route without being blind to the pattern.`,
    expected_effect: {
      qualitative: `Receipts matching this shape should flip from "abstain" to a suggestion of ${routeIdentity}. Non-matching shapes unaffected.`,
    },
  };
}

// ── override_hotspot → adjust_weight ────────────────────────

/**
 * When operators consistently override a pack suggestion with another pack,
 * the most common cause is `pack_shape_fit` firing too readily. Propose a
 * modest down-adjustment. The replay harness quantifies the effect.
 */
function fromOverrideHotspot(f: AuditFinding, now: string): CalibrationProposal | null {
  // The finding's title encodes "suggested → actual".
  const match = f.title.match(/overrides\s+(\S+)\s*→\s*(\S+)\s/);
  if (!match) return null;
  const suggested = match[1];
  if (!suggested.startsWith("pack:")) return null; // scope: only handle pack-suggestion overrides today

  const weightKey: WeightKey = "pack_shape_fit";
  const fromValue = 0.9;   // Current default (mirrors ROUTING_WEIGHTS.pack_shape_fit)
  const toValue = 0.7;
  const parts = { kind: "adjust_weight", weight_key: weightKey, from: fromValue, to: toValue, suggested };
  const base = baseProposal(f, now);
  return {
    ...base,
    id: proposalId(parts),
    kind: "adjust_weight",
    target: { weight_key: weightKey, route_identity: suggested, shape_sig: f.evidence.shape_sig },
    change: { kind: "adjust_weight", weight_key: weightKey, from: fromValue, to: toValue },
    rationale: `Operators overrode the suggestion \`${suggested}\` ${base.source_receipt_paths.length} time(s) on shape \`${f.evidence.shape_sig ?? "(unknown)"}\`. The pack_shape_fit weight is firing on shapes where the fit isn't strong; damping it gives competing routes a chance to score higher.`,
    expected_effect: {
      qualitative: `Mismatches where pack_shape_fit was the deciding signal should narrow. Correctly-suggested packs with strong evidence beyond shape_fit remain on top.`,
    },
  };
}

// ── overconfident_route → raise_band_floor ──────────────────

function fromOverconfidentRoute(f: AuditFinding, now: string): CalibrationProposal | null {
  // Current bandFor requires score >= 2.0 AND evidence.length >= 2 for "high".
  // Raise the evidence bar.
  const fromThresh = { score: 2.0, evidence: 2 };
  const toThresh = { score: 2.2, evidence: 3 };
  const parts = { kind: "raise_band_floor", band: "high" as const, from: fromThresh, to: toThresh };
  const base = baseProposal(f, now);
  return {
    ...base,
    id: proposalId(parts),
    kind: "raise_band_floor",
    target: { band: "high" },
    change: { kind: "raise_band_floor", band: "high", from: fromThresh, to: toThresh },
    rationale: `A high-band suggestion was overridden ${base.source_receipt_paths.length} time(s) with operator success. Raising the high-band evidence floor from 2 to 3 distinct positive signals (and score floor 2.0→2.2) reduces over-confident suggestions without changing medium/low behavior.`,
    expected_effect: {
      qualitative: `Candidates currently at "high" band with just 2 positive signals drop to "medium". Medium-band candidates and below are unaffected. Low-confidence suggestions are NOT promoted.`,
    },
  };
}

// ── unused_candidate → adjust_weight ────────────────────────

function fromUnusedCandidate(f: AuditFinding, now: string): CalibrationProposal | null {
  const weightKey: WeightKey = "candidate_proposal_support";
  const fromValue = 0.25;
  const toValue = 0.4;
  const parts = { kind: "adjust_weight", weight_key: weightKey, from: fromValue, to: toValue };
  const base = baseProposal(f, now);
  return {
    ...base,
    id: proposalId(parts),
    kind: "adjust_weight",
    target: { weight_key: weightKey },
    change: { kind: "adjust_weight", weight_key: weightKey, from: fromValue, to: toValue },
    rationale: `A candidate proposal with strong support never surfaced as a top suggestion — the ${weightKey} weight is too conservative relative to pack_shape_fit and skill status bumps. Bumping ${fromValue} → ${toValue} gives captured workflows a fairer shot without crowding out approved skills.`,
    expected_effect: {
      qualitative: `Ad-hoc chain candidates with support × success_rate ≥ ~${toValue / 0.25 * 0.5} score high enough to win ties with weak packs. No effect when skills or strong packs already dominate.`,
    },
  };
}

// ── Orchestrator ────────────────────────────────────────────

const GENERATORS: Partial<Record<AuditFinding["kind"], (f: AuditFinding, now: string) => CalibrationProposal | null>> = {
  missed_abstain: fromMissedAbstain,
  override_hotspot: fromOverrideHotspot,
  overconfident_route: fromOverconfidentRoute,
  unused_candidate: fromUnusedCandidate,
  // abstain_cluster is handled by watching → wait for more data; no proposal today.
  // promotion_gap is a skill-authoring task, not a scoring tune; emitted as a
  // "next_action" hint in audit, not as a calibration proposal.
};

export function proposeCalibrations(findings: AuditFinding[], now: string = new Date().toISOString()): CalibrationProposal[] {
  const proposals: CalibrationProposal[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const gen = GENERATORS[f.kind];
    if (!gen) continue;
    const p = gen(f, now);
    if (!p) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    proposals.push(p);
  }
  return proposals;
}
