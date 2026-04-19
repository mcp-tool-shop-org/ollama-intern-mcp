/**
 * Memory store — read/write the single-file index at
 * ~/.ollama-intern/memory/index.json (or override dir).
 *
 * Deliberately a single JSON file rather than a database. Operational memory
 * is thousands-scale, not billions; a simple durable file is diff-friendly,
 * cat-inspectable, and trivial to backup. Commit B will add a sidecar
 * embeddings file when retrieval lands — the primary index stays legible.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  memoryIndexSchema,
  MEMORY_SCHEMA_VERSION,
  type MemoryIndex,
  type MemoryRecord,
} from "./types.js";

export interface StoreOptions {
  /** Override the directory holding the index. Defaults to ~/.ollama-intern/memory/ (INTERN_MEMORY_DIR env wins). */
  dir?: string;
}

export function memoryDir(override?: string): string {
  if (override !== undefined) return override;
  return process.env.INTERN_MEMORY_DIR ?? path.join(os.homedir(), ".ollama-intern", "memory");
}

export function indexPath(override?: string): string {
  return path.join(memoryDir(override), "index.json");
}

/** Load the index if it exists; otherwise return an empty index. Never throws. */
export async function loadIndex(opts: StoreOptions = {}): Promise<MemoryIndex> {
  const file = indexPath(opts.dir);
  if (!existsSync(file)) {
    return { schema_version: MEMORY_SCHEMA_VERSION, indexed_at: new Date(0).toISOString(), records: [] };
  }
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = memoryIndexSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { schema_version: MEMORY_SCHEMA_VERSION, indexed_at: new Date(0).toISOString(), records: [] };
    }
    return parsed.data;
  } catch {
    return { schema_version: MEMORY_SCHEMA_VERSION, indexed_at: new Date(0).toISOString(), records: [] };
  }
}

/** Atomically write the index. Creates memoryDir if needed. */
export async function saveIndex(index: MemoryIndex, opts: StoreOptions = {}): Promise<string> {
  const dir = memoryDir(opts.dir);
  const file = indexPath(opts.dir);
  await fs.mkdir(dir, { recursive: true });
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
  await fs.rename(tmp, file);
  return file;
}

/** Return all records as a stable-sorted array (kind, then created_at desc, then id). */
export function sortRecords(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });
}
