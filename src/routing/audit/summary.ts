/**
 * AuditSummary — the metric layer. Tells you WHAT happened over the
 * window. Findings (in findings.ts) tell you what to do next.
 *
 * Abstain splitting lives here: the summary separates legit abstains
 * (router had no opinion on a one-off) from missed abstains (router had
 * no opinion on a recurring shape cluster with consistent outcomes).
 * That split is load-bearing — they drive different calibrations.
 */

import type { RoutingReceipt } from "../receipts.js";
import { shapeSignature } from "./cluster.js";
import type { AuditMatchKind, AuditSummary, AuditThresholds } from "./types.js";

export function classifyReceiptMatchKind(
  receipt: RoutingReceipt,
  abstainCountsByShape: Map<string, number>,
  thresholds: AuditThresholds,
): AuditMatchKind {
  if (receipt.match.kind !== "abstain") return receipt.match.kind as AuditMatchKind;
  const sig = shapeSignature(receipt.decision.context.input_shape);
  const clusterSize = abstainCountsByShape.get(sig) ?? 0;
  return clusterSize >= thresholds.min_missed_abstain_cluster ? "missed_abstain" : "legit_abstain";
}

function countAbstainShapes(receipts: RoutingReceipt[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of receipts) {
    if (r.match.kind !== "abstain") continue;
    const sig = shapeSignature(r.decision.context.input_shape);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  return counts;
}

function emptyMatchBreakdown(): Record<AuditMatchKind, number> {
  return { exact: 0, kind_match: 0, mismatch: 0, legit_abstain: 0, missed_abstain: 0 };
}

export function buildSummary(
  receipts: RoutingReceipt[],
  since: string | null,
  thresholds: AuditThresholds,
): AuditSummary {
  const abstainByShape = countAbstainShapes(receipts);
  const match: Record<AuditMatchKind, number> = emptyMatchBreakdown();
  const byActual = new Map<string, { count: number; match_kinds: Record<AuditMatchKind, number> }>();
  const familyDist = { atom: 0, pack: 0 };
  const runtime = {
    think_on: 0,
    think_off: 0,
    think_unknown: 0,
    by_model: {} as Record<string, number>,
    by_hardware_profile: {} as Record<string, number>,
  };

  let earliest: string | null = null;
  let latest: string | null = null;

  for (const r of receipts) {
    const kind = classifyReceiptMatchKind(r, abstainByShape, thresholds);
    match[kind] += 1;

    const identity = r.actual.route_identity;
    const entry = byActual.get(identity) ?? { count: 0, match_kinds: emptyMatchBreakdown() };
    entry.count += 1;
    entry.match_kinds[kind] += 1;
    byActual.set(identity, entry);

    if (identity.startsWith("atom:")) familyDist.atom += 1;
    else if (identity.startsWith("pack:")) familyDist.pack += 1;

    if (r.runtime.think === true) runtime.think_on += 1;
    else if (r.runtime.think === false) runtime.think_off += 1;
    else runtime.think_unknown += 1;

    if (r.outcome.model) {
      runtime.by_model[r.outcome.model] = (runtime.by_model[r.outcome.model] ?? 0) + 1;
    }
    runtime.by_hardware_profile[r.runtime.hardware_profile] =
      (runtime.by_hardware_profile[r.runtime.hardware_profile] ?? 0) + 1;

    if (!earliest || r.recorded_at < earliest) earliest = r.recorded_at;
    if (!latest || r.recorded_at > latest) latest = r.recorded_at;
  }

  // Top abstain shapes — sort by recurrence.
  const topAbstain: AuditSummary["top_abstain_shapes"] = [];
  for (const [sig, count] of abstainByShape) {
    const routesInShape = new Set<string>();
    for (const r of receipts) {
      if (r.match.kind !== "abstain") continue;
      if (shapeSignature(r.decision.context.input_shape) !== sig) continue;
      routesInShape.add(r.actual.route_identity);
    }
    topAbstain.push({ shape_sig: sig, count, actual_routes: [...routesInShape].sort() });
  }
  topAbstain.sort((a, b) => b.count - a.count || (a.shape_sig < b.shape_sig ? -1 : 1));

  const byActualList = [...byActual.entries()]
    .map(([route_identity, data]) => ({ route_identity, count: data.count, match_kinds: data.match_kinds }))
    .sort((a, b) => b.count - a.count || (a.route_identity < b.route_identity ? -1 : 1));

  return {
    receipts_considered: receipts.length,
    time_window: { since, earliest_recorded: earliest, latest_recorded: latest },
    match_breakdown: match,
    route_family_distribution: familyDist,
    by_actual_route: byActualList,
    top_abstain_shapes: topAbstain.slice(0, 10),
    runtime_breakdown: runtime,
  };
}
