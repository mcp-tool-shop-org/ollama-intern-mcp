/**
 * Corpus manifest — the source of truth for what a corpus SHOULD contain.
 *
 * The corpus JSON (<name>.json) represents reality: the chunks actually
 * indexed right now. The manifest (<name>.manifest.json) represents
 * intent: the paths + chunk parameters + embed model the caller declared.
 * Refresh reconciles intent vs reality and reports the drift.
 *
 * Kept as a separate file so intent can be inspected and edited without
 * touching the corpus payload. ollama_corpus_index always writes a
 * manifest as a side effect; ollama_corpus_refresh reads it.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { InternError } from "../errors.js";
import { assertValidCorpusName } from "./storage.js";

export const MANIFEST_SCHEMA_VERSION = 2;

export interface CorpusManifest {
  schema_version: number;
  name: string;
  /** Absolute paths the corpus is declared to contain. */
  paths: string[];
  /** Embed model this manifest was built against — refresh refuses on mismatch. */
  embed_model: string;
  /**
   * Model identifier as Ollama RESOLVED it at index time (e.g.
   * "nomic-embed-text:latest"). Captured from EmbedResponse.model on the
   * first embed call during index. Refresh compares this against a live
   * probe to detect the silent case where Ollama updates a :latest tag
   * behind a stable profile name — vectors from the old resolved model
   * are not comparable to vectors from the new one. Null on manifests
   * written before schema v2 (auto-migrated on load).
   */
  embed_model_resolved: string | null;
  chunk_chars: number;
  chunk_overlap: number;
  created_at: string;
  updated_at: string;
}

function manifestDir(): string {
  return process.env.INTERN_CORPUS_DIR ?? join(homedir(), ".ollama-intern", "corpora");
}

export function manifestPath(name: string): string {
  return join(manifestDir(), `${name}.manifest.json`);
}

export async function loadManifest(name: string): Promise<CorpusManifest | null> {
  assertValidCorpusName(name);
  const path = manifestPath(name);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<CorpusManifest> & { schema_version?: number };
  const found = parsed.schema_version;
  if (found === 1) {
    // v1 → v2 migration: v1 didn't capture the resolved tag. Treat as
    // "unknown at index time" — refresh will record it on the next embed
    // call and the drift check activates from there forward.
    return { ...(parsed as CorpusManifest), schema_version: MANIFEST_SCHEMA_VERSION, embed_model_resolved: null };
  }
  if (found !== MANIFEST_SCHEMA_VERSION) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Manifest for corpus "${name}" is at schema v${found ?? "unknown"}; this build expects v${MANIFEST_SCHEMA_VERSION}. File: ${path}`,
      `Re-run ollama_corpus_index({ name: "${name}", paths: [...] }) to rewrite the manifest under the current schema.`,
      false,
    );
  }
  return parsed as CorpusManifest;
}

export async function saveManifest(manifest: CorpusManifest): Promise<void> {
  assertValidCorpusName(manifest.name);
  const path = manifestPath(manifest.name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}
