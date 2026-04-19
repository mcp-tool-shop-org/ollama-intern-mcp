/**
 * Load routing receipts from disk, optionally filtered by time window.
 * Pure read path — never mutates, never reaches into the live runtime.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { receiptsDir, type RoutingReceipt } from "../receipts.js";

export interface LoadReceiptOptions {
  /** Override receipts directory (test isolation). */
  dir?: string;
  /** Only include receipts whose recorded_at >= this ISO timestamp. */
  since?: string;
  /** Only include receipts whose recorded_at <= this ISO timestamp. */
  until?: string;
}

export async function loadRoutingReceipts(opts: LoadReceiptOptions = {}): Promise<RoutingReceipt[]> {
  const dir = receiptsDir(opts.dir);
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: RoutingReceipt[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, e.name), "utf8");
      const r = JSON.parse(raw) as RoutingReceipt;
      if (!r || typeof r !== "object" || !r.recorded_at) continue;
      if (opts.since && r.recorded_at < opts.since) continue;
      if (opts.until && r.recorded_at > opts.until) continue;
      out.push(r);
    } catch {
      // Tolerate corrupt files — they're not worth breaking the audit for.
    }
  }
  out.sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));
  return out;
}
