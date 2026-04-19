/**
 * Refresh orchestrator — scan every source, normalize, reconcile with the
 * existing index. Idempotent: a no-change refresh produces a drift-free
 * report and an unchanged file on disk.
 *
 * Reconcile model:
 *   - added:      id present in new scan, absent in prior index
 *   - updated:    id present in both; content_digest changed
 *   - unchanged:  id present in both; content_digest matches
 *   - removed:    id present in prior index, absent in new scan
 *
 * Removed records are dropped from the index by default. A later commit
 * may add soft-deletion / archiving if we find operators want to keep
 * memory of things they've since deleted. For now, reality on disk wins.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { scanAllArtifacts } from "../tools/artifacts/scan.js";
import { loadSkills, type SkillStoreOptions } from "../skills/store.js";
import { reconstructChains, resolveLogPath } from "../skills/chains.js";
import { proposeNewSkills, DEFAULT_NEW_SKILL_THRESHOLDS, type NewSkillThresholds } from "../skills/newSkillProposer.js";
import { receiptsDir } from "../skills/traces.js";
import type { SkillReceipt } from "../skills/types.js";
import {
  normalizeCandidateProposal,
  normalizePackArtifact,
  normalizeSkill,
  normalizeSkillReceipt,
} from "./normalizers.js";
import { loadIndex, saveIndex, sortRecords, type StoreOptions } from "./store.js";
import { MEMORY_SCHEMA_VERSION, type MemoryIndex, type MemoryKind, type MemoryRecord } from "./types.js";

export interface RefreshOptions extends StoreOptions {
  /** Optional override for the receipts directory. Defaults to <cwd>/artifacts/skill-receipts. */
  receiptsDir?: string;
  /** When true, do not persist the new index — only return the diff. Useful for dry-run previews. */
  dryRun?: boolean;
  /** Override chain reconstruction params for candidate_proposal synthesis. */
  chain_gap_ms?: number;
  new_skill_thresholds?: Partial<NewSkillThresholds>;
  /** Skip candidate_proposal synthesis entirely. */
  skip_candidates?: boolean;
  /** Override where skills are loaded from — test-isolation knob. */
  skillStoreOptions?: SkillStoreOptions;
}

export interface RefreshDrift {
  added: MemoryRecord[];
  updated: Array<{ before: MemoryRecord; after: MemoryRecord }>;
  unchanged_count: number;
  removed: MemoryRecord[];
}

export interface RefreshResult {
  index_path: string;
  total_records: number;
  per_kind_counts: Record<MemoryKind, number>;
  drift: {
    added_count: number;
    updated_count: number;
    unchanged_count: number;
    removed_count: number;
    added_ids: string[];
    updated_ids: string[];
    removed_ids: string[];
  };
  dry_run: boolean;
  sources_scanned: {
    skill_receipt_files: number;
    pack_artifact_entries: number;
    skill_entries: number;
    candidate_proposals: number;
  };
}

async function listReceiptFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(dir, e.name));
}

async function loadReceipt(file: string): Promise<SkillReceipt | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as SkillReceipt;
  } catch {
    return null;
  }
}

export async function refreshMemory(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const now = new Date().toISOString();
  const newRecords: MemoryRecord[] = [];

  const rcptDir = opts.receiptsDir ?? receiptsDir();
  const receiptFiles = await listReceiptFiles(rcptDir);
  for (const f of receiptFiles) {
    const r = await loadReceipt(f);
    if (!r) continue;
    newRecords.push(normalizeSkillReceipt(r, now, f));
  }

  const scan = await scanAllArtifacts();
  for (const meta of scan.all) {
    newRecords.push(normalizePackArtifact(meta, now));
  }

  const { skills } = await loadSkills(opts.skillStoreOptions);
  for (const loaded of skills) {
    newRecords.push(normalizeSkill(loaded, now));
  }

  let candidateCount = 0;
  if (!opts.skip_candidates) {
    const logPath = resolveLogPath();
    const chains = await reconstructChains({ gapMs: opts.chain_gap_ms, logPath });
    const thresholds: NewSkillThresholds = { ...DEFAULT_NEW_SKILL_THRESHOLDS, ...(opts.new_skill_thresholds ?? {}) };
    const proposals = proposeNewSkills(chains, skills, thresholds);
    for (const p of proposals) newRecords.push(normalizeCandidateProposal(p, logPath, now));
    candidateCount = proposals.length;
  }

  const prior = await loadIndex(opts);
  const priorById = new Map(prior.records.map((r) => [r.id, r]));
  const newById = new Map(newRecords.map((r) => [r.id, r]));

  const drift: RefreshDrift = { added: [], updated: [], unchanged_count: 0, removed: [] };
  for (const [id, after] of newById) {
    const before = priorById.get(id);
    if (!before) drift.added.push(after);
    else if (before.content_digest !== after.content_digest) drift.updated.push({ before, after });
    else drift.unchanged_count += 1;
  }
  for (const [id, before] of priorById) {
    if (!newById.has(id)) drift.removed.push(before);
  }

  // Always take the freshly-normalized record — provenance (source_path) is
  // not part of the content_digest, so keeping the prior record on unchanged
  // would freeze stale provenance forever. Drift classification (added vs
  // updated vs unchanged) already happened above against content_digest; the
  // merge stage just writes the authoritative current shape.
  const merged: MemoryRecord[] = [...newRecords];
  const nextIndex: MemoryIndex = {
    schema_version: MEMORY_SCHEMA_VERSION,
    indexed_at: now,
    records: sortRecords(merged),
  };

  let indexFile = path.join((opts.dir ?? ""), "index.json");
  if (!opts.dryRun) {
    indexFile = await saveIndex(nextIndex, opts);
  }

  const perKindCounts: Record<MemoryKind, number> = {
    skill_receipt: 0,
    pack_artifact: 0,
    approved_skill: 0,
    candidate_proposal: 0,
  };
  for (const r of merged) perKindCounts[r.kind] += 1;

  return {
    index_path: indexFile,
    total_records: merged.length,
    per_kind_counts: perKindCounts,
    drift: {
      added_count: drift.added.length,
      updated_count: drift.updated.length,
      unchanged_count: drift.unchanged_count,
      removed_count: drift.removed.length,
      added_ids: drift.added.map((r) => r.id),
      updated_ids: drift.updated.map((d) => d.after.id),
      removed_ids: drift.removed.map((r) => r.id),
    },
    dry_run: opts.dryRun === true,
    sources_scanned: {
      skill_receipt_files: receiptFiles.length,
      pack_artifact_entries: scan.all.length,
      skill_entries: skills.length,
      candidate_proposals: candidateCount,
    },
  };
}
