/**
 * Calibration store — durable, versioned record of every proposal and
 * every status transition. Single JSON file; same house style as the
 * memory index.
 *
 * Rollback path: every applied overlay stamps its `version` onto receipts
 * so later audits can answer "which calibration produced this decision."
 * A rollback is a status transition (approved → superseded) with a
 * `superseded_by` pointer; the prior state is never erased.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  CALIBRATION_SCHEMA_VERSION,
  type CalibrationProposal,
  type CalibrationStatus,
  type CalibrationStoreFile,
} from "./types.js";

export interface StoreOptions {
  dir?: string;
}

export function calibrationsDir(override?: string): string {
  if (override !== undefined) return override;
  return process.env.INTERN_CALIBRATIONS_DIR ?? path.join(os.homedir(), ".ollama-intern", "calibrations");
}

export function storePath(override?: string): string {
  return path.join(calibrationsDir(override), "store.json");
}

/**
 * Build a fresh empty store. NEVER share array/object references across
 * load calls — a sentinel with mutable arrays leaks across tests and, in
 * the worst case, across live calls. Always return a brand-new instance.
 */
function emptyStore(): CalibrationStoreFile {
  return {
    schema_version: CALIBRATION_SCHEMA_VERSION,
    written_at: new Date(0).toISOString(),
    proposals: [],
    active_version: null,
  };
}

export async function loadStore(opts: StoreOptions = {}): Promise<CalibrationStoreFile> {
  const file = storePath(opts.dir);
  if (!existsSync(file)) return emptyStore();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as CalibrationStoreFile;
    if (!parsed || parsed.schema_version !== CALIBRATION_SCHEMA_VERSION) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

export async function saveStore(store: CalibrationStoreFile, opts: StoreOptions = {}): Promise<string> {
  const dir = calibrationsDir(opts.dir);
  await fs.mkdir(dir, { recursive: true });
  const file = storePath(opts.dir);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ ...store, written_at: new Date().toISOString() }, null, 2), "utf8");
  await fs.rename(tmp, file);
  return file;
}

// ── Lifecycle operations ────────────────────────────────────

export async function addProposals(
  proposals: CalibrationProposal[],
  opts: StoreOptions = {},
): Promise<{ added: string[]; existing: string[] }> {
  const store = await loadStore(opts);
  const existing = new Set(store.proposals.map((p) => p.id));
  const added: string[] = [];
  const duplicate: string[] = [];
  for (const p of proposals) {
    if (existing.has(p.id)) { duplicate.push(p.id); continue; }
    store.proposals.push(p);
    added.push(p.id);
  }
  if (added.length > 0) await saveStore(store, opts);
  return { added, existing: duplicate };
}

export interface TransitionOptions extends StoreOptions {
  reason: string;
  at?: string;
}

export async function transition(
  id: string,
  to: CalibrationStatus,
  opts: TransitionOptions,
): Promise<CalibrationProposal> {
  const store = await loadStore(opts);
  const p = store.proposals.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown calibration proposal: ${id}`);
  // Valid transitions:
  //   proposed   → approved | rejected | superseded
  //   approved   → superseded
  //   rejected   → proposed (re-open)
  //   superseded → (terminal)
  const allowed: Record<CalibrationStatus, CalibrationStatus[]> = {
    proposed: ["approved", "rejected", "superseded"],
    approved: ["superseded"],
    rejected: ["proposed"],
    superseded: [],
  };
  if (!allowed[p.status].includes(to)) {
    throw new Error(`Invalid transition ${p.status} → ${to} for ${id}`);
  }
  const at = opts.at ?? new Date().toISOString();
  p.status = to;
  p.history.push({ at, transition: to, reason: opts.reason });
  // Rebuild active_version = overlay version of all currently-approved proposals.
  const { overlayFromProposals } = await import("./overlay.js");
  const overlay = overlayFromProposals(store.proposals, ["approved"]);
  store.active_version = overlay.version === "0" ? null : overlay.version;
  await saveStore(store, opts);
  return p;
}

export async function activeOverlay(opts: StoreOptions = {}) {
  const { overlayFromProposals } = await import("./overlay.js");
  const store = await loadStore(opts);
  return overlayFromProposals(store.proposals, ["approved"]);
}
