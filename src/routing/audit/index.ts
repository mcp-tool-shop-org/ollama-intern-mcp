/**
 * Audit orchestrator — runs the full Phase 3D-C audit over routing
 * receipts joined to skills + candidate_proposals. Returns a typed
 * AuditReport. No MCP wiring, no mutations.
 */

import { loadSkills } from "../../skills/store.js";
import { loadIndex } from "../../memory/store.js";
import { loadRoutingReceipts, type LoadReceiptOptions } from "./loader.js";
import { buildSummary } from "./summary.js";
import { generateFindings } from "./findings.js";
import {
  AUDIT_SCHEMA_VERSION,
  DEFAULT_AUDIT_THRESHOLDS,
  type AuditReport,
  type AuditThresholds,
  type FindingKind,
} from "./types.js";

export interface RunAuditOptions extends LoadReceiptOptions {
  thresholds?: Partial<AuditThresholds>;
  /** Filter findings to a subset of kinds. */
  finding_kinds?: FindingKind[];
}

export async function runAudit(opts: RunAuditOptions = {}): Promise<AuditReport> {
  const thresholds: AuditThresholds = { ...DEFAULT_AUDIT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const receipts = await loadRoutingReceipts(opts);
  const { skills } = await loadSkills();
  const index = await loadIndex();
  const candidate_proposals = index.records.filter((r) => r.kind === "candidate_proposal");

  const summary = buildSummary(receipts, opts.since ?? null, thresholds);
  let findings = generateFindings({
    receipts,
    approved_skills: skills,
    candidate_proposals,
    thresholds,
  });
  if (opts.finding_kinds && opts.finding_kinds.length > 0) {
    const keep = new Set(opts.finding_kinds);
    findings = findings.filter((f) => keep.has(f.kind));
  }

  return {
    schema_version: AUDIT_SCHEMA_VERSION,
    produced_at: new Date().toISOString(),
    summary,
    findings,
  };
}

export * from "./types.js";
export * from "./cluster.js";
export * from "./loader.js";
export * from "./summary.js";
export * from "./findings.js";
