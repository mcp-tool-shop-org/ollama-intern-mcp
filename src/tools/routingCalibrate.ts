/**
 * ollama_routing_calibrate — Phase 3D-D calibration surface.
 *
 * One tool, action-typed. The six verbs map to the four parts of the
 * calibration lifecycle:
 *   propose  — generate proposals from current audit findings (writes none)
 *   list     — show stored proposals by status
 *   replay   — dry-run a proposal (by id) over stored receipts
 *   approve  — transition proposed → approved (landing into active overlay)
 *   reject   — transition proposed → rejected (recorded but never applied)
 *   rollback — transition approved → superseded (removes from active overlay)
 *
 * Laws held:
 *   - No mutation on propose/list/replay (READ-ONLY surfaces)
 *   - No automatic application — every landed calibration is operator-approved
 *   - Versioned + reversible — every transition is recorded in history
 *   - Shadow-only — approved calibrations shape suggestions, never take control
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import { runAudit } from "../routing/audit/index.js";
import { proposeCalibrations } from "../routing/calibration/proposals.js";
import { loadStore, addProposals, transition, activeOverlay } from "../routing/calibration/store.js";
import { overlayFromProposals } from "../routing/calibration/overlay.js";
import { replayOverlay } from "../routing/calibration/replay.js";
import { loadRoutingReceipts } from "../routing/audit/loader.js";
import type { CalibrationProposal, CalibrationStatus } from "../routing/calibration/types.js";

export const routingCalibrateSchema = z.object({
  action: z
    .enum(["propose", "list", "replay", "approve", "reject", "rollback"])
    .describe("Which step of the calibration lifecycle to perform."),
  proposal_id: z
    .string()
    .optional()
    .describe("Required for replay / approve / reject / rollback."),
  reason: z
    .string()
    .optional()
    .describe("Required for approve / reject / rollback — becomes part of the permanent history entry."),
  status_filter: z
    .array(z.enum(["proposed", "approved", "rejected", "superseded"]))
    .optional()
    .describe("For list action: filter proposals by status."),
  since: z
    .string()
    .optional()
    .describe("ISO timestamp. For propose, limit audit to receipts after this time. For replay, limit receipts scanned."),
  persist: z
    .boolean()
    .optional()
    .describe("For propose: when true, write new proposals to the store (default false — preview only)."),
});

export type RoutingCalibrateInput = z.infer<typeof routingCalibrateSchema>;

interface ProposeResult {
  action: "propose";
  proposals: CalibrationProposal[];
  added_ids?: string[];
  existing_ids?: string[];
}

interface ListResult {
  action: "list";
  active_version: string | null;
  proposals: CalibrationProposal[];
}

interface ReplayResult {
  action: "replay";
  proposal: CalibrationProposal;
  overlay_version: string;
  receipts_considered: number;
  delta: ReturnType<typeof replayOverlay>;
}

interface TransitionResult {
  action: "approve" | "reject" | "rollback";
  proposal: CalibrationProposal;
  previous_status: CalibrationStatus;
  new_status: CalibrationStatus;
  active_overlay_version: string;
}

export type RoutingCalibrateResult =
  | ProposeResult
  | ListResult
  | ReplayResult
  | TransitionResult;

async function handlePropose(input: RoutingCalibrateInput): Promise<ProposeResult> {
  const report = await runAudit({ since: input.since });
  const proposals = proposeCalibrations(report.findings);
  if (input.persist) {
    const { added, existing } = await addProposals(proposals);
    return { action: "propose", proposals, added_ids: added, existing_ids: existing };
  }
  return { action: "propose", proposals };
}

async function handleList(input: RoutingCalibrateInput): Promise<ListResult> {
  const store = await loadStore();
  let proposals = store.proposals;
  if (input.status_filter && input.status_filter.length > 0) {
    const keep = new Set(input.status_filter);
    proposals = proposals.filter((p) => keep.has(p.status));
  }
  return { action: "list", active_version: store.active_version, proposals };
}

async function handleReplay(input: RoutingCalibrateInput): Promise<ReplayResult> {
  if (!input.proposal_id) {
    throw new InternError("SCHEMA_INVALID", "replay requires proposal_id", "Pass proposal_id from an earlier propose/list call.", false);
  }
  const store = await loadStore();
  const proposal = store.proposals.find((p) => p.id === input.proposal_id);
  if (!proposal) {
    throw new InternError("SCHEMA_INVALID", `Unknown proposal id: ${input.proposal_id}`, "Call ollama_routing_calibrate action=list to see stored proposal ids.", false);
  }
  // Build an overlay that includes THIS proposal as if approved, alongside
  // any already-approved proposals. That way replay reflects the state
  // after landing this one — not in isolation.
  const combinedProposals = store.proposals.map((p) => p.id === proposal.id ? { ...p, status: "approved" as const } : p);
  const overlay = overlayFromProposals(combinedProposals, ["approved"]);
  const receipts = await loadRoutingReceipts({ since: input.since });
  const delta = replayOverlay(receipts, overlay);
  return {
    action: "replay",
    proposal,
    overlay_version: overlay.version,
    receipts_considered: receipts.length,
    delta,
  };
}

async function handleTransition(action: "approve" | "reject" | "rollback", input: RoutingCalibrateInput): Promise<TransitionResult> {
  if (!input.proposal_id) {
    throw new InternError("SCHEMA_INVALID", `${action} requires proposal_id`, "Pass proposal_id from list.", false);
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new InternError("SCHEMA_INVALID", `${action} requires a reason string`, "Record why this transition is happening — becomes part of the permanent history.", false);
  }
  const targetStatus: CalibrationStatus =
    action === "approve" ? "approved" :
    action === "reject" ? "rejected" :
    "superseded";

  const store = await loadStore();
  const existing = store.proposals.find((p) => p.id === input.proposal_id);
  if (!existing) {
    throw new InternError("SCHEMA_INVALID", `Unknown proposal id: ${input.proposal_id}`, "Call list to find the id.", false);
  }
  const previous = existing.status;
  const updated = await transition(input.proposal_id, targetStatus, { reason: input.reason });
  const overlay = await activeOverlay();
  return {
    action,
    proposal: updated,
    previous_status: previous,
    new_status: updated.status,
    active_overlay_version: overlay.version,
  };
}

export async function handleRoutingCalibrate(
  input: RoutingCalibrateInput,
  ctx: RunContext,
): Promise<Envelope<RoutingCalibrateResult>> {
  const startedAt = Date.now();
  let result: RoutingCalibrateResult;
  switch (input.action) {
    case "propose":  result = await handlePropose(input); break;
    case "list":     result = await handleList(input); break;
    case "replay":   result = await handleReplay(input); break;
    case "approve":  result = await handleTransition("approve", input); break;
    case "reject":   result = await handleTransition("reject", input); break;
    case "rollback": result = await handleTransition("rollback", input); break;
  }
  const envelope = buildEnvelope<RoutingCalibrateResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_routing_calibrate", envelope, input));
  return envelope;
}
