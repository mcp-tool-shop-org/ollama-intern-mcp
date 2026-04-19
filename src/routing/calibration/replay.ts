/**
 * Replay harness — re-score stored routing receipts as if a given
 * CalibrationOverlay had been active when they were recorded.
 *
 * The receipt's snapshotted context is the ground truth for that
 * point-in-time state — we re-generate candidates and re-score them with
 * the overlay, then compare the new top candidate against the original
 * suggested route AND against the operator's actual invocation.
 *
 * What replay CAN'T do: introduce candidates that weren't present at the
 * time. A calibration that adds a new skill is a promotion, not a tune —
 * replay ignores that dimension. For add_shape_signal proposals targeting
 * a route that was never in the candidate set, replay reports 0 effect.
 */

import type { RoutingReceipt } from "../receipts.js";
import { generateCandidates } from "../candidates.js";
import { scoreCandidate } from "../scoring.js";
import { rankCandidates, ROUTING_SUGGEST_FLOOR } from "../router.js";
import { shapeSignature } from "../audit/cluster.js";
import type { CalibrationOverlay, ReceiptReplayDelta, ReplayDelta } from "./types.js";

function canonicalRef(target: { kind: "skill" | "pack" | "atoms" | "no_suggestion"; ref: string }): string {
  // Packs canonicalize as `pack:ollama_<ref>` to match the identity stamped
  // on receipts by canonicalActualRoute — replay must use the same form or
  // the match/mismatch classification is bogus.
  if (target.kind === "pack") return `pack:ollama_${target.ref}`;
  return `${target.kind}:${target.ref}`;
}

function suggestedFromRanked(ranked: ReturnType<typeof rankCandidates>): { ref: string | null; score: number; band: string } {
  const top = ranked[0];
  if (!top || top.target.kind === "no_suggestion" || top.score < ROUTING_SUGGEST_FLOOR || top.band === "abstain") {
    return { ref: null, score: top?.score ?? 0, band: "abstain" };
  }
  return { ref: canonicalRef(top.target), score: top.score, band: top.band };
}

function transitionKind(
  beforeRef: string | null,
  afterRef: string | null,
  beforeBand: string,
  afterBand: string,
  actual: string,
): ReceiptReplayDelta["transition"] {
  const beforeMatch = beforeRef === actual || (beforeRef && beforeRef.replace(/^pack:ollama_/, "pack:") === actual);
  const afterMatch = afterRef === actual || (afterRef && afterRef.replace(/^pack:ollama_/, "pack:") === actual);

  if (beforeRef === afterRef && beforeBand === afterBand) return "unchanged";
  if (beforeRef === null && afterRef !== null) return "promoted_from_abstain";
  if (!beforeMatch && afterMatch) return "flipped_to_match";
  if (beforeMatch && !afterMatch) return "flipped_away_from_match";
  if (beforeBand !== afterBand) return "band_change";
  return "rank_shift";
}

/**
 * Replay one receipt with an overlay applied. Returns the delta — or null
 * when the receipt has no candidates to re-score (edge case; shouldn't
 * happen with real receipts but guards the type).
 */
export function replayReceipt(receipt: RoutingReceipt, overlay: CalibrationOverlay): ReceiptReplayDelta | null {
  const ctx = receipt.decision.context;
  const baseCandidates = generateCandidates(ctx);
  if (baseCandidates.length === 0) return null;
  const rescored = baseCandidates.map((c) => scoreCandidate(c, ctx, overlay));
  const ranked = rankCandidates(rescored);

  const after = suggestedFromRanked(ranked);
  const origSuggested = receipt.decision.suggested;
  const beforeRef = origSuggested ? canonicalRef(origSuggested) : null;
  const beforeScore = receipt.decision.candidates[0]?.score ?? 0;
  const beforeBand = receipt.decision.candidates[0]?.band ?? "abstain";

  const actualIdentity = receipt.actual.route_identity;
  const refMatchesActual = (ref: string | null): boolean =>
    ref !== null && (ref === actualIdentity || ref.replace(/^pack:ollama_/, "pack:") === actualIdentity);

  return {
    receipt_path: receipt.receipt_path,
    shape_sig: shapeSignature(ctx.input_shape),
    before: {
      top_ref: beforeRef,
      top_score: beforeScore,
      top_band: beforeBand,
      matched: refMatchesActual(beforeRef),
    },
    after: {
      top_ref: after.ref,
      top_score: after.score,
      top_band: after.band,
      matched: refMatchesActual(after.ref),
    },
    transition: transitionKind(beforeRef, after.ref, beforeBand, after.band, actualIdentity),
  };
}

export function replayOverlay(receipts: RoutingReceipt[], overlay: CalibrationOverlay, exampleLimit = 20): ReplayDelta {
  const per: ReceiptReplayDelta[] = [];
  for (const r of receipts) {
    const d = replayReceipt(r, overlay);
    if (d) per.push(d);
  }

  const counts = {
    unchanged: 0,
    promoted_from_abstain: 0,
    flipped_to_match: 0,
    flipped_away_from_match: 0,
    rank_shift: 0,
    band_change: 0,
  };
  for (const d of per) counts[d.transition] += 1;

  // Pick the most interesting examples first: away_from_match + flipped_to_match + promoted.
  const priority: ReceiptReplayDelta["transition"][] = [
    "flipped_away_from_match",
    "flipped_to_match",
    "promoted_from_abstain",
    "band_change",
    "rank_shift",
    "unchanged",
  ];
  const examples = per
    .slice()
    .sort((a, b) => priority.indexOf(a.transition) - priority.indexOf(b.transition))
    .slice(0, exampleLimit);

  return {
    receipts_considered: per.length,
    ...counts,
    examples,
  };
}
