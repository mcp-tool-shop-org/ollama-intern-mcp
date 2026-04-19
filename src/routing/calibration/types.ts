/**
 * Phase 3D-D — calibration types.
 *
 * Design law: no invisible tuning. Every calibration change is:
 *   - inspectable    (fully serialized proposal + rationale + evidence)
 *   - attributable   (sourced from a specific audit finding)
 *   - replayable     (the replay harness shows before/after deltas)
 *   - reversible     (versioned, with a rollback path)
 *
 * Shadow stays shadow: after apply, the router still only suggests. D
 * makes the shadow smarter and more honest, not active.
 */

import type { AuditFinding, FindingKind } from "../audit/types.js";
import type { ROUTING_WEIGHTS } from "../scoring.js";

export const CALIBRATION_SCHEMA_VERSION = 1 as const;

// ── Proposal kinds ──────────────────────────────────────────

/** The kinds of calibration we can propose today. Tight on purpose. */
export type CalibrationKind =
  | "add_shape_signal"   // Reward a specific route on a specific shape
  | "adjust_weight"      // Bump a named ROUTING_WEIGHTS key up or down
  | "raise_band_floor"   // Require more score/evidence for a band
  | "add_pack_keyword";  // Extend PACK_KEYWORDS for one pack

export type CalibrationStatus = "proposed" | "approved" | "rejected" | "superseded";

export type WeightKey = keyof typeof ROUTING_WEIGHTS;

// ── The proposal ────────────────────────────────────────────

export interface CalibrationProposal {
  id: string;
  schema_version: typeof CALIBRATION_SCHEMA_VERSION;
  generated_at: string;
  source_finding: FindingKind;
  /**
   * Receipts the proposal is grounded in — the same receipts that drove
   * the originating audit finding. Replay uses these for the primary
   * before/after delta.
   */
  source_receipt_paths: string[];

  kind: CalibrationKind;

  /** What the proposal targets. Shape varies by kind. */
  target: {
    route_identity?: string;
    shape_sig?: string;
    weight_key?: WeightKey;
    pack_name?: string;
    band?: "high" | "medium";
  };

  /** The concrete change, typed per kind. */
  change:
    | { kind: "add_shape_signal"; signal_name: string; weight: number; reason: string }
    | { kind: "adjust_weight"; weight_key: WeightKey; from: number; to: number }
    | { kind: "raise_band_floor"; band: "high" | "medium"; from: { score: number; evidence: number }; to: { score: number; evidence: number } }
    | { kind: "add_pack_keyword"; pack_name: string; keywords_added: string[] };

  /** Grounded rationale — one to three sentences. */
  rationale: string;

  /**
   * Expected effect if approved. Populated by the replay harness AFTER
   * `proposeCalibrations` returns — the generator itself only gives a
   * qualitative prediction.
   */
  expected_effect: {
    qualitative: string;
    /** Populated post-replay. */
    replay?: ReplayDelta;
  };

  /** Lifecycle. Mutable over time — but every change is recorded in history. */
  status: CalibrationStatus;
  history: Array<{
    at: string;
    transition: CalibrationStatus;
    reason: string;
    superseded_by?: string;
  }>;
}

// ── The calibration overlay (what scoring actually consumes) ─

export interface ShapeSignalOverride {
  /** Exact canonical route identity: "atom:ollama_classify" | "pack:ollama_incident_pack" */
  route_identity: string;
  shape_sig: string;
  signal_name: string;
  weight: number;
  reason: string;
}

export interface CalibrationOverlay {
  /** Version stamp written onto every receipt that used this overlay. "0" = no overlay. */
  version: string;
  /** Proposal ids baked into this overlay — receipts can back-trace every signal. */
  proposal_ids: string[];
  /** Weight overrides merged into ROUTING_WEIGHTS. */
  weights: Partial<Record<WeightKey, number>>;
  /** Additional band thresholds (raises floor of high/medium bands). */
  band_thresholds: {
    high_score?: number;
    high_evidence?: number;
    medium_score?: number;
  };
  /** Shape-targeted signal boosts. */
  shape_signals: ShapeSignalOverride[];
  /** Pack keyword additions, keyed by pack name (without ollama_ prefix). */
  pack_keyword_additions: Record<string, string[]>;
}

export const EMPTY_OVERLAY: CalibrationOverlay = {
  version: "0",
  proposal_ids: [],
  weights: {},
  band_thresholds: {},
  shape_signals: [],
  pack_keyword_additions: {},
};

// ── Replay delta ────────────────────────────────────────────

export interface ReceiptReplayDelta {
  receipt_path: string;
  shape_sig: string;
  before: { top_ref: string | null; top_score: number; top_band: string; matched: boolean };
  after: { top_ref: string | null; top_score: number; top_band: string; matched: boolean };
  transition:
    | "unchanged"
    | "promoted_from_abstain"
    | "flipped_to_match"
    | "flipped_away_from_match"
    | "rank_shift"
    | "band_change";
}

export interface ReplayDelta {
  receipts_considered: number;
  unchanged: number;
  promoted_from_abstain: number;
  flipped_to_match: number;
  flipped_away_from_match: number;
  rank_shift: number;
  band_change: number;
  /** Sample of changed receipts — bounded to keep output readable. */
  examples: ReceiptReplayDelta[];
}

// ── Store shape ─────────────────────────────────────────────

export interface CalibrationStoreFile {
  schema_version: typeof CALIBRATION_SCHEMA_VERSION;
  written_at: string;
  proposals: CalibrationProposal[];
  /** Id of the currently-active overlay version, or null when none applied. */
  active_version: string | null;
}

// Re-export a convenience for proposal generators.
export type { AuditFinding };
