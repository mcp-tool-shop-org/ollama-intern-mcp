import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  proposeCalibrations,
  overlayFromProposals,
  replayOverlay,
  replayReceipt,
  loadStore,
  addProposals,
  transition,
  activeOverlay,
  EMPTY_OVERLAY,
  type CalibrationProposal,
} from "../../src/routing/calibration/index.js";
import type { AuditFinding } from "../../src/routing/audit/index.js";
import type { RoutingReceipt } from "../../src/routing/receipts.js";
import type { RoutingDecision } from "../../src/routing/types.js";
import { scoreCandidate, bandFor } from "../../src/routing/scoring.js";
import type { RouteCandidate, RoutingContext } from "../../src/routing/types.js";

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), "cal-")); }

function mkFinding(overrides: Partial<AuditFinding>): AuditFinding {
  return {
    kind: "missed_abstain",
    severity: "high",
    title: "default",
    detail: "default",
    evidence: { receipt_paths: ["/tmp/r1.json", "/tmp/r2.json", "/tmp/r3.json"] },
    recommended_next_action: "",
    ...overrides,
  } as AuditFinding;
}

function mkCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    schema_version: 1,
    built_at: "2026-04-18T20:00:00Z",
    job_hint: null,
    input_shape: {},
    input_flags: {
      has_log_text: false, has_source_paths: false, has_diff_text: false,
      has_corpus: false, has_question: false, has_text: false, has_items_batch: false,
    },
    available_skills: [],
    memory_hits: [],
    candidate_proposals: [],
    ...overrides,
  } as RoutingContext;
}

describe("calibration/proposals", () => {
  it("missed_abstain finding → add_shape_signal proposal naming the dominant route", () => {
    const f = mkFinding({
      kind: "missed_abstain",
      title: "Router abstained 5× on shape `labels=arr:few|text=str:tiny` — operators consistently chose `pack:ollama_incident_pack`",
      evidence: { receipt_paths: ["/tmp/r.json"], shape_sig: "labels=arr:few|text=str:tiny" },
    });
    const [p] = proposeCalibrations([f], "2026-04-18T20:00:00Z");
    expect(p.kind).toBe("add_shape_signal");
    expect(p.target.route_identity).toBe("pack:ollama_incident_pack");
    expect(p.target.shape_sig).toBe("labels=arr:few|text=str:tiny");
    expect(p.status).toBe("proposed");
    expect(p.history[0].transition).toBe("proposed");
  });

  it("override_hotspot finding → adjust_weight proposal damping pack_shape_fit", () => {
    const f = mkFinding({
      kind: "override_hotspot",
      title: "Operator overrides pack:ollama_change_pack → pack:ollama_repo_pack 4× on shape `source_paths=arr:few`",
      evidence: { receipt_paths: ["/tmp/r.json"], shape_sig: "source_paths=arr:few" },
    });
    const [p] = proposeCalibrations([f], "2026-04-18T20:00:00Z");
    expect(p.kind).toBe("adjust_weight");
    if (p.change.kind === "adjust_weight") {
      expect(p.change.weight_key).toBe("pack_shape_fit");
      expect(p.change.to).toBeLessThan(p.change.from);
    }
  });

  it("overconfident_route finding → raise_band_floor proposal", () => {
    const f = mkFinding({ kind: "overconfident_route" });
    const [p] = proposeCalibrations([f]);
    expect(p.kind).toBe("raise_band_floor");
    if (p.change.kind === "raise_band_floor") {
      expect(p.change.to.evidence).toBeGreaterThan(p.change.from.evidence);
    }
  });

  it("unused_candidate finding → adjust_weight proposal bumping candidate_proposal_support", () => {
    const f = mkFinding({ kind: "unused_candidate" });
    const [p] = proposeCalibrations([f]);
    if (p.change.kind === "adjust_weight") {
      expect(p.change.weight_key).toBe("candidate_proposal_support");
      expect(p.change.to).toBeGreaterThan(p.change.from);
    }
  });

  it("promotion_gap + abstain_cluster findings do NOT produce calibrations", () => {
    const findings = [
      mkFinding({ kind: "promotion_gap" }),
      mkFinding({ kind: "abstain_cluster" }),
    ];
    expect(proposeCalibrations(findings)).toHaveLength(0);
  });

  it("proposal ids are deterministic — same finding produces same id", () => {
    const f = mkFinding({
      kind: "missed_abstain",
      title: "Router abstained on shape `x` — operators consistently chose `atom:ollama_classify`",
      evidence: { receipt_paths: [], shape_sig: "x" },
    });
    const a = proposeCalibrations([f]);
    const b = proposeCalibrations([f]);
    expect(a[0].id).toBe(b[0].id);
  });
});

describe("calibration/overlay", () => {
  function mkProp(overrides: Partial<CalibrationProposal>): CalibrationProposal {
    return {
      id: "p",
      schema_version: 1,
      generated_at: "t",
      source_finding: "missed_abstain",
      source_receipt_paths: [],
      kind: "adjust_weight",
      target: { weight_key: "pack_shape_fit" },
      change: { kind: "adjust_weight", weight_key: "pack_shape_fit", from: 0.9, to: 0.5 },
      rationale: "test",
      expected_effect: { qualitative: "t" },
      status: "approved",
      history: [],
      ...overrides,
    } as CalibrationProposal;
  }

  it("EMPTY_OVERLAY when no proposals", () => {
    expect(overlayFromProposals([]).version).toBe("0");
  });

  it("adjust_weight proposals override the named weight", () => {
    const overlay = overlayFromProposals([mkProp({})]);
    expect(overlay.weights.pack_shape_fit).toBe(0.5);
    expect(overlay.version).not.toBe("0");
  });

  it("raise_band_floor proposals lift the band thresholds", () => {
    const p = mkProp({
      id: "band",
      kind: "raise_band_floor",
      target: { band: "high" },
      change: { kind: "raise_band_floor", band: "high", from: { score: 2.0, evidence: 2 }, to: { score: 2.5, evidence: 4 } },
    });
    const overlay = overlayFromProposals([p]);
    expect(overlay.band_thresholds.high_score).toBe(2.5);
    expect(overlay.band_thresholds.high_evidence).toBe(4);
  });

  it("only proposals in allowed statuses contribute", () => {
    const approved = mkProp({ id: "a", status: "approved" });
    const proposed = mkProp({ id: "b", status: "proposed", change: { kind: "adjust_weight", weight_key: "skill_status_approved", from: 0.4, to: 0.9 } });
    const overlay = overlayFromProposals([approved, proposed], ["approved"]);
    expect(overlay.weights.pack_shape_fit).toBe(0.5);
    expect(overlay.weights.skill_status_approved).toBeUndefined();
  });
});

describe("calibration/scoring — overlay influences output", () => {
  it("raised band floor demotes a would-be-high candidate to medium", () => {
    const signals = [
      { name: "pack_shape_fit" as const, weight: 1.2, reason: "" },
      { name: "pack_supplementary_hit" as const, weight: 0.9, reason: "" },
    ];
    const defaultBand = bandFor(2.1, signals);
    expect(defaultBand).toBe("high");
    const overlay = { ...EMPTY_OVERLAY, band_thresholds: { high_score: 2.5, high_evidence: 3 } };
    const raisedBand = bandFor(2.1, signals, overlay);
    expect(raisedBand).toBe("medium");
  });

  it("shape_signal overlay adds a signal to a matching candidate", () => {
    const candidate: RouteCandidate = {
      target: { kind: "pack", ref: "incident_pack", expected_tools: [] },
      score: 0, band: "low", signals: [], missing_signals: [], provenance: [],
    };
    const ctx = mkCtx({
      input_shape: { log_text: { kind: "string", bucket: "medium" } },
      input_flags: { ...mkCtx().input_flags, has_log_text: true },
    });
    const overlay = {
      ...EMPTY_OVERLAY,
      version: "v1",
      shape_signals: [{
        route_identity: "pack:ollama_incident_pack",
        shape_sig: "log_text=str:medium",
        signal_name: "pack_shape_fit",
        weight: 0.5,
        reason: "calibration test boost",
      }],
    };
    const before = scoreCandidate(candidate, ctx);
    const after = scoreCandidate(candidate, ctx, overlay);
    expect(after.score).toBeGreaterThan(before.score);
    expect(after.signals.some((s) => s.reason.includes("calibration (v1)"))).toBe(true);
  });
});

describe("calibration/replay", () => {
  function mkDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
    return {
      schema_version: 1, decided_at: "t",
      candidates: [], suggested: null, abstain_reason: "thin",
      context: {
        schema_version: 1, built_at: "t", job_hint: null, input_shape: {},
        input_flags: {
          has_log_text: false, has_source_paths: false, has_diff_text: false,
          has_corpus: false, has_question: false, has_text: false, has_items_batch: false,
        },
        available_skills: [], memory_hits: [], candidate_proposals: [],
      },
      ...overrides,
    };
  }

  function mkReceipt(decision: RoutingDecision, actual: string): RoutingReceipt {
    return {
      schema_version: 1, recorded_at: "2026-04-18T20:00:00Z",
      actual: { route_identity: actual, tool: actual.replace(/^(atom|pack):/, ""), job_hint: null },
      decision,
      match: { matched: false, kind: "abstain" },
      outcome: { ok: true, elapsed_ms: 100 },
      runtime: { hardware_profile: "dev-rtx5080", think: false },
      receipt_path: "/tmp/x.json",
    };
  }

  it("overlay that lifts pack_shape_fit flips an abstain to a suggestion", () => {
    const decision = mkDecision({
      context: {
        ...mkDecision().context,
        input_shape: { log_text: { kind: "string", bucket: "medium" } },
        input_flags: {
          ...mkDecision().context.input_flags,
          has_log_text: true,
        },
      },
    });
    const receipt = mkReceipt(decision, "pack:ollama_incident_pack");
    const overlay = {
      ...EMPTY_OVERLAY,
      version: "v1",
      shape_signals: [{
        route_identity: "pack:ollama_incident_pack",
        shape_sig: "log_text=str:medium",
        signal_name: "pack_shape_fit",
        weight: 2.0,
        reason: "calibration boost",
      }],
    };
    const delta = replayReceipt(receipt, overlay);
    expect(delta).toBeTruthy();
    expect(["promoted_from_abstain", "flipped_to_match"]).toContain(delta!.transition);
    expect(delta!.after.top_ref).toBe("pack:ollama_incident_pack");
  });

  it("replayOverlay aggregates counts across many receipts", () => {
    const decision = mkDecision();
    const receipts = Array.from({ length: 5 }, () => mkReceipt(decision, "atom:ollama_classify"));
    const delta = replayOverlay(receipts, EMPTY_OVERLAY);
    // No overlay = every receipt unchanged.
    expect(delta.receipts_considered).toBe(5);
    expect(delta.unchanged).toBe(5);
  });
});

describe("calibration/store — lifecycle", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function mkProp(id: string, status: CalibrationProposal["status"] = "proposed"): CalibrationProposal {
    return {
      id,
      schema_version: 1,
      generated_at: "2026-04-18T10:00:00Z",
      source_finding: "missed_abstain",
      source_receipt_paths: [],
      kind: "adjust_weight",
      target: { weight_key: "pack_shape_fit" },
      change: { kind: "adjust_weight", weight_key: "pack_shape_fit", from: 0.9, to: 0.7 },
      rationale: "r",
      expected_effect: { qualitative: "q" },
      status,
      history: [{ at: "t", transition: status, reason: "seeded" }],
    };
  }

  it("addProposals dedups by id", async () => {
    const p = mkProp("alpha");
    const a = await addProposals([p], { dir });
    expect(a.added).toEqual(["alpha"]);
    const b = await addProposals([p], { dir });
    expect(b.added).toEqual([]);
    expect(b.existing).toEqual(["alpha"]);
  });

  it("valid transition proposed → approved updates status and lifts activeOverlay version", async () => {
    await addProposals([mkProp("alpha")], { dir });
    await transition("alpha", "approved", { dir, reason: "sensible" });
    const overlay = await activeOverlay({ dir });
    expect(overlay.version).not.toBe("0");
    const store = await loadStore({ dir });
    const p = store.proposals.find((x) => x.id === "alpha");
    expect(p?.status).toBe("approved");
    expect(p?.history.at(-1)?.transition).toBe("approved");
    expect(store.active_version).toBe(overlay.version);
  });

  it("invalid transition approved → proposed rejects loudly", async () => {
    await addProposals([mkProp("alpha")], { dir });
    await transition("alpha", "approved", { dir, reason: "x" });
    await expect(transition("alpha", "proposed", { dir, reason: "nope" })).rejects.toThrow(/Invalid transition/);
  });

  it("rollback path: approved → superseded removes from active overlay", async () => {
    await addProposals([mkProp("alpha")], { dir });
    await transition("alpha", "approved", { dir, reason: "ok" });
    const before = await activeOverlay({ dir });
    expect(before.version).not.toBe("0");
    await transition("alpha", "superseded", { dir, reason: "too aggressive" });
    const after = await activeOverlay({ dir });
    expect(after.version).toBe("0");
    const store = await loadStore({ dir });
    expect(store.active_version).toBeNull();
  });
});

// Stub so TypeScript is happy about the unused import above.
import type { CalibrationProposal as _CP } from "../../src/routing/calibration/types.js";
void (null as _CP | null);
