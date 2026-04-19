/**
 * Build a CalibrationOverlay from a list of proposals.
 *
 * Only proposals whose status allows inclusion are folded in. "proposed"
 * proposals pass when explicitly asked (replay previews) but never as the
 * *applied* overlay. "approved" proposals form the active overlay.
 * "rejected" and "superseded" never contribute.
 */

import type { CalibrationOverlay, CalibrationProposal, CalibrationStatus, ShapeSignalOverride, WeightKey } from "./types.js";
import { EMPTY_OVERLAY } from "./types.js";
import { createHash } from "node:crypto";

export function overlayFromProposals(
  proposals: CalibrationProposal[],
  allowed: CalibrationStatus[] = ["approved"],
): CalibrationOverlay {
  const allowedSet = new Set(allowed);
  const picked = proposals.filter((p) => allowedSet.has(p.status));
  if (picked.length === 0) return { ...EMPTY_OVERLAY };

  const weights: Partial<Record<WeightKey, number>> = {};
  const bandThresholds: CalibrationOverlay["band_thresholds"] = {};
  const shapeSignals: ShapeSignalOverride[] = [];
  const packKeywords: Record<string, string[]> = {};

  for (const p of picked) {
    switch (p.change.kind) {
      case "adjust_weight":
        weights[p.change.weight_key] = p.change.to;
        break;
      case "raise_band_floor": {
        if (p.change.band === "high") {
          bandThresholds.high_score = p.change.to.score;
          bandThresholds.high_evidence = p.change.to.evidence;
        } else {
          bandThresholds.medium_score = p.change.to.score;
        }
        break;
      }
      case "add_shape_signal": {
        if (p.target.route_identity && p.target.shape_sig) {
          shapeSignals.push({
            route_identity: p.target.route_identity,
            shape_sig: p.target.shape_sig,
            signal_name: p.change.signal_name,
            weight: p.change.weight,
            reason: p.change.reason,
          });
        }
        break;
      }
      case "add_pack_keyword": {
        const existing = packKeywords[p.change.pack_name] ?? [];
        packKeywords[p.change.pack_name] = [...new Set([...existing, ...p.change.keywords_added])];
        break;
      }
    }
  }

  const version = versionOf(picked);
  const proposal_ids = picked.map((p) => p.id).sort();
  return {
    version,
    proposal_ids,
    weights,
    band_thresholds: bandThresholds,
    shape_signals: shapeSignals,
    pack_keyword_additions: packKeywords,
  };
}

/** Stable version stamp — hash of sorted proposal ids. */
function versionOf(proposals: CalibrationProposal[]): string {
  if (proposals.length === 0) return "0";
  const ids = proposals.map((p) => p.id).sort();
  return `v${createHash("sha256").update(ids.join("|")).digest("hex").slice(0, 12)}`;
}
