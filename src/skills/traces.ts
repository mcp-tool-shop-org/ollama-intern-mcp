/**
 * Trace reader — aggregates skill receipts into per-skill learning signals.
 *
 * Receipts are the truth surface. A skill's run count, recent success rate,
 * where it tends to fail (which step, which error code), and how much it
 * costs (elapsed + tokens) all come from reading the durable receipt files
 * at <cwd>/artifacts/skill-receipts/.
 *
 * This module is pure read — it does not mutate skills, does not propose,
 * does not promote. Those are separate tools.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SkillReceipt, StepRecord } from "./types.js";

export interface StepFailureProfile {
  step_id: string;
  tool: string;
  failure_count: number;
  /** Most common error code across failures of this step. */
  top_error_code: string;
  error_codes: Record<string, number>;
}

export interface SkillTraceStats {
  skill_id: string;
  run_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  median_elapsed_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  last_run_at: string | null;
  first_run_at: string | null;
  /** Failures grouped by (step_id, error_code). Empty when run_count==0 or all runs succeeded. */
  failure_profile: StepFailureProfile[];
  /** Distinct hardware profiles this skill has been seen on. */
  hardware_profiles: string[];
}

export interface TraceReadOptions {
  receiptsDir?: string;
  /** Only consider receipts with started_at >= since (ISO). */
  since?: string;
  /** Filter to a single skill id. */
  skill_id?: string;
}

export function receiptsDir(override?: string): string {
  return override ?? path.join(process.cwd(), "artifacts", "skill-receipts");
}

async function listReceiptFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name));
}

async function readReceipt(file: string): Promise<SkillReceipt | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as SkillReceipt;
  } catch {
    return null;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function envelopeTokens(step: StepRecord): { in: number; out: number } {
  const env = step.envelope as { tokens_in?: number; tokens_out?: number } | undefined;
  return { in: env?.tokens_in ?? 0, out: env?.tokens_out ?? 0 };
}

export async function loadReceipts(opts: TraceReadOptions = {}): Promise<SkillReceipt[]> {
  const files = await listReceiptFiles(receiptsDir(opts.receiptsDir));
  const all: SkillReceipt[] = [];
  for (const f of files) {
    const r = await readReceipt(f);
    if (!r) continue;
    if (opts.skill_id && r.skill_id !== opts.skill_id) continue;
    if (opts.since && r.started_at < opts.since) continue;
    all.push(r);
  }
  return all.sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
}

export function aggregateStats(receipts: SkillReceipt[]): SkillTraceStats[] {
  const bySkill = new Map<string, SkillReceipt[]>();
  for (const r of receipts) {
    const list = bySkill.get(r.skill_id) ?? [];
    list.push(r);
    bySkill.set(r.skill_id, list);
  }
  const out: SkillTraceStats[] = [];
  for (const [skill_id, runs] of bySkill) {
    const success = runs.filter((r) => r.ok);
    const failure = runs.filter((r) => !r.ok);
    const failureProfile = profileFailures(failure);
    const profiles = new Set<string>();
    let tokIn = 0;
    let tokOut = 0;
    for (const r of runs) {
      profiles.add(r.hardware_profile);
      for (const step of r.steps) {
        const t = envelopeTokens(step);
        tokIn += t.in;
        tokOut += t.out;
      }
    }
    out.push({
      skill_id,
      run_count: runs.length,
      success_count: success.length,
      failure_count: failure.length,
      success_rate: runs.length === 0 ? 0 : success.length / runs.length,
      median_elapsed_ms: median(runs.map((r) => r.elapsed_ms)),
      total_tokens_in: tokIn,
      total_tokens_out: tokOut,
      last_run_at: runs.length > 0 ? runs[runs.length - 1].started_at : null,
      first_run_at: runs.length > 0 ? runs[0].started_at : null,
      failure_profile: failureProfile,
      hardware_profiles: Array.from(profiles).sort(),
    });
  }
  return out.sort((a, b) => (a.skill_id < b.skill_id ? -1 : 1));
}

function profileFailures(failureReceipts: SkillReceipt[]): StepFailureProfile[] {
  // Key: step_id + tool; value: error-code counter and total
  const buckets = new Map<string, { step_id: string; tool: string; count: number; codes: Record<string, number> }>();
  for (const r of failureReceipts) {
    for (const step of r.steps) {
      if (step.ok || step.skipped) continue;
      const key = `${step.step_id}::${step.tool}`;
      const bucket = buckets.get(key) ?? { step_id: step.step_id, tool: step.tool, count: 0, codes: {} };
      bucket.count += 1;
      const code = step.error?.code ?? "UNKNOWN";
      bucket.codes[code] = (bucket.codes[code] ?? 0) + 1;
      buckets.set(key, bucket);
    }
  }
  const profiles: StepFailureProfile[] = [];
  for (const b of buckets.values()) {
    const topCode = Object.entries(b.codes).sort((a, c) => c[1] - a[1])[0]?.[0] ?? "UNKNOWN";
    profiles.push({
      step_id: b.step_id,
      tool: b.tool,
      failure_count: b.count,
      top_error_code: topCode,
      error_codes: b.codes,
    });
  }
  return profiles.sort((a, b) => b.failure_count - a.failure_count || (a.step_id < b.step_id ? -1 : 1));
}
