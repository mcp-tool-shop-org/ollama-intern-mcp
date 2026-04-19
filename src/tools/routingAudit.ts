/**
 * ollama_routing_audit — read-only audit over Phase 3D shadow receipts.
 *
 * Emits `{summary, findings}`. Summary is the metric layer; findings are
 * typed, operator-meaningful diagnoses with provenance back to receipts /
 * artifacts / skills / candidate proposals. No mutations, no calibration,
 * no promotion — this tool surfaces truth; Phase 3D-D acts on it.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { runAudit, type AuditReport } from "../routing/audit/index.js";

export const routingAuditSchema = z.object({
  since: z.string().optional().describe("ISO timestamp. Consider only receipts recorded at/after this time. Omit for all-time."),
  until: z.string().optional().describe("ISO timestamp. Consider only receipts recorded at/before this time."),
  finding_kinds: z
    .array(z.enum([
      "promotion_gap",
      "override_hotspot",
      "abstain_cluster",
      "missed_abstain",
      "unused_candidate",
      "overconfident_route",
    ]))
    .optional()
    .describe("Filter the findings array to a subset of kinds."),
  thresholds: z
    .object({
      min_cluster_size: z.number().int().min(1).optional(),
      promotion_gap_success_rate: z.number().min(0).max(1).optional(),
      min_overrides_for_hotspot: z.number().int().min(1).optional(),
      unused_candidate_min_support: z.number().int().min(1).optional(),
      unused_candidate_min_shape_agreement: z.number().min(0).max(1).optional(),
      min_missed_abstain_cluster: z.number().int().min(1).optional(),
    })
    .optional()
    .describe("Override default audit thresholds. Calibration lives in Phase 3D-D, not here — these are read-time knobs."),
});

export type RoutingAuditInput = z.infer<typeof routingAuditSchema>;

export async function handleRoutingAudit(
  input: RoutingAuditInput,
  ctx: RunContext,
): Promise<Envelope<AuditReport>> {
  const startedAt = Date.now();
  const report = await runAudit({
    since: input.since,
    until: input.until,
    thresholds: input.thresholds,
    finding_kinds: input.finding_kinds,
  });
  const warnings: string[] = [];
  if (report.summary.receipts_considered === 0) {
    warnings.push("No routing receipts found — run some atom/pack calls to generate shadow data, then re-audit.");
  }
  const envelope = buildEnvelope<AuditReport>({
    result: report,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
  await ctx.logger.log(callEvent("ollama_routing_audit", envelope, input));
  return envelope;
}
