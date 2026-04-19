/**
 * Phase 3D-C — audit types.
 *
 * Read-only surface over routing receipts joined to artifacts / memory /
 * skills / proposals. Produces a triple of (summary, findings, provenance)
 * that tells the truth about where the router is right, where it's weak,
 * where it's too timid, and where it's confidently wrong.
 *
 * Design lock: findings are first-class. Summary tells you what happened;
 * findings tell you what to do next in Phase 3D-D. A report without any
 * findings is a legitimate answer — "the router is behaving reasonably."
 */

export const AUDIT_SCHEMA_VERSION = 1 as const;

// ── Match kinds (matching RoutingReceipt.match.kind) ────────

export type AuditMatchKind =
  | "exact"
  | "kind_match"
  | "mismatch"
  | "legit_abstain"  // router abstained; actual route is a one-off / primitive with no recurring pattern
  | "missed_abstain"; // router abstained; actual route keeps recurring on the same shape cluster

export type FindingKind =
  | "promotion_gap"        // repeated pack/atom success → likely skill candidate
  | "override_hotspot"     // operator consistently picks a different route than the suggestion
  | "abstain_cluster"      // router has no opinion on a recurring shape where outcomes are consistent
  | "missed_abstain"       // specific case: abstain + recurring same actual route
  | "unused_candidate"     // candidate_proposal with strong support, never surfaced as top suggestion
  | "overconfident_route"; // router suggested high-band X; operator picked Y; Y kept succeeding

export type FindingSeverity = "high" | "medium" | "low";

// ── Summary (metrics) ───────────────────────────────────────

export interface AuditSummary {
  receipts_considered: number;
  time_window: { since: string | null; earliest_recorded: string | null; latest_recorded: string | null };
  match_breakdown: Record<AuditMatchKind, number>;
  route_family_distribution: {
    atom: number;
    pack: number;
  };
  /** Per actual invoked route, how often each match kind landed. */
  by_actual_route: Array<{
    route_identity: string;
    count: number;
    match_kinds: Record<AuditMatchKind, number>;
  }>;
  /** Top recurring shape signatures where the router abstained. */
  top_abstain_shapes: Array<{
    shape_sig: string;
    count: number;
    actual_routes: string[];
  }>;
  /** Runtime distribution for later calibration correlation. */
  runtime_breakdown: {
    think_on: number;
    think_off: number;
    think_unknown: number;
    by_model: Record<string, number>;
    by_hardware_profile: Record<string, number>;
  };
}

// ── Findings (operator-meaningful diagnoses) ────────────────

export interface FindingEvidence {
  /** Routing receipt file paths the finding rests on. */
  receipt_paths: string[];
  /** Pack artifacts produced by supporting runs. */
  artifact_refs?: Array<{ pack: string; slug: string; json_path?: string }>;
  /** Existing skills referenced by the finding. */
  skill_refs?: string[];
  /** candidate_proposal memory record ids referenced. */
  proposal_refs?: string[];
  /** Input-shape signature that ties the receipts together, when applicable. */
  shape_sig?: string;
  /** Aggregate success signal for the finding, 0..1 when meaningful. */
  success_rate?: number;
}

export interface AuditFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  /** One to three plain sentences describing the finding, grounded in evidence. */
  detail: string;
  evidence: FindingEvidence;
  /**
   * Operator-meaningful next step. READ-ONLY surface — never executed
   * here. Phase 3D-D is where these become actual calibration calls.
   */
  recommended_next_action: string;
}

// ── Report (the full audit output) ──────────────────────────

export interface AuditReport {
  schema_version: typeof AUDIT_SCHEMA_VERSION;
  produced_at: string;
  summary: AuditSummary;
  findings: AuditFinding[];
}

export interface AuditThresholds {
  /** Minimum count for a shape cluster to be considered "recurring." */
  min_cluster_size: number;
  /** Minimum success rate for promotion_gap to fire. */
  promotion_gap_success_rate: number;
  /** Minimum overrides in cluster for override_hotspot to fire. */
  min_overrides_for_hotspot: number;
  /** Candidate_proposal support + shape_agreement thresholds (mirror skill-layer). */
  unused_candidate_min_support: number;
  unused_candidate_min_shape_agreement: number;
  /** Minimum cluster size for a missed_abstain finding. */
  min_missed_abstain_cluster: number;
}

export const DEFAULT_AUDIT_THRESHOLDS: AuditThresholds = {
  min_cluster_size: 3,
  promotion_gap_success_rate: 0.8,
  min_overrides_for_hotspot: 3,
  unused_candidate_min_support: 3,
  unused_candidate_min_shape_agreement: 0.6,
  min_missed_abstain_cluster: 3,
};
