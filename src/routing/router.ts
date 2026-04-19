/**
 * Router orchestrator — pure function over RoutingContext.
 *
 * Deterministic: for the same context, the same ranked field and decision.
 * Ties break on route kind order (skill > pack > atoms > no_suggestion)
 * then lexicographic ref.
 *
 * Shadow-only: this module never executes a route. Commit B's runtime
 * observes the operator's actual choice and persists both.
 */

import { generateCandidates } from "./candidates.js";
import { scoreCandidate, ROUTING_SUGGEST_FLOOR, bandFor } from "./scoring.js";
import type { RouteCandidate, RoutingContext, RoutingDecision } from "./types.js";
import { ROUTING_SCHEMA_VERSION } from "./types.js";
import type { CalibrationOverlay } from "./calibration/types.js";
import { EMPTY_OVERLAY } from "./calibration/types.js";

const KIND_ORDER: Record<RouteCandidate["target"]["kind"], number> = {
  skill: 0,
  pack: 1,
  atoms: 2,
  no_suggestion: 3,
};

function rankCandidates(scored: RouteCandidate[]): RouteCandidate[] {
  return scored.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ko = KIND_ORDER[a.target.kind] - KIND_ORDER[b.target.kind];
    if (ko !== 0) return ko;
    return a.target.ref < b.target.ref ? -1 : a.target.ref > b.target.ref ? 1 : 0;
  });
}

export function route(context: RoutingContext, overlay: CalibrationOverlay = EMPTY_OVERLAY): RoutingDecision {
  const raw = generateCandidates(context);
  const scored = raw.map((c) => scoreCandidate(c, context, overlay));
  const ranked = rankCandidates(scored);

  // Top candidate becomes the suggestion only if it clears the floor AND
  // is not the abstain slot AND its band isn't "abstain".
  const top = ranked[0];
  const abstains = !top
    || top.target.kind === "no_suggestion"
    || top.score < ROUTING_SUGGEST_FLOOR
    || top.band === "abstain";

  let abstainReason: string | null = null;
  if (abstains) {
    if (!top) abstainReason = "no candidates generated";
    else if (top.target.kind === "no_suggestion") abstainReason = "abstain slot outranked every real route";
    else if (top.score < ROUTING_SUGGEST_FLOOR) abstainReason = `top score ${top.score.toFixed(2)} below suggest floor ${ROUTING_SUGGEST_FLOOR}`;
    else abstainReason = `top candidate band=${top.band} — evidence too thin to suggest`;
  }

  return {
    schema_version: ROUTING_SCHEMA_VERSION,
    decided_at: new Date().toISOString(),
    candidates: ranked,
    suggested: abstains ? null : top.target,
    abstain_reason: abstainReason,
    context,
  };
}

export { rankCandidates, ROUTING_SUGGEST_FLOOR, bandFor };
