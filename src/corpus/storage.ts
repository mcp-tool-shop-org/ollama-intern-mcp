/**
 * Corpus persistence — one JSON file per named corpus.
 *
 * Location: ~/.ollama-intern/corpora/<name>.json  (override via INTERN_CORPUS_DIR)
 *
 * Schema is explicitly versioned so we can evolve without silent breakage.
 * Raw vectors are stored (this file is the database), but they never reach
 * Claude — search handlers strip them before returning.
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { InternError } from "../errors.js";

export const CORPUS_SCHEMA_VERSION = 1;

export interface CorpusChunk {
  id: string;
  path: string;
  file_hash: string;
  file_mtime: string;
  chunk_index: number;
  char_start: number;
  char_end: number;
  text: string;
  vector: number[];
}

export interface CorpusFile {
  schema_version: number;
  name: string;
  model_version: string;
  model_digest: string | null;
  indexed_at: string;
  chunk_chars: number;
  chunk_overlap: number;
  stats: {
    documents: number;
    chunks: number;
    total_chars: number;
  };
  chunks: CorpusChunk[];
}

export function corpusDir(): string {
  return process.env.INTERN_CORPUS_DIR ?? join(homedir(), ".ollama-intern", "corpora");
}

export function corpusPath(name: string): string {
  return join(corpusDir(), `${name}.json`);
}

const NAME_RX = /^[a-zA-Z0-9_-]+$/;

export function assertValidCorpusName(name: string): void {
  if (!NAME_RX.test(name)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Invalid corpus name "${name}"`,
      "Corpus names must match [a-zA-Z0-9_-]+ so they map safely to filenames.",
      false,
    );
  }
}

export async function loadCorpus(name: string): Promise<CorpusFile | null> {
  assertValidCorpusName(name);
  const path = corpusPath(name);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as CorpusFile;
  if (parsed.schema_version !== CORPUS_SCHEMA_VERSION) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Corpus "${name}" has schema_version ${parsed.schema_version}; expected ${CORPUS_SCHEMA_VERSION}`,
      "Re-index the corpus with ollama_corpus_index to bring it forward.",
      false,
    );
  }
  return parsed;
}

export async function saveCorpus(corpus: CorpusFile): Promise<void> {
  assertValidCorpusName(corpus.name);
  const path = corpusPath(corpus.name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(corpus), "utf8");
}

export interface CorpusSummary {
  name: string;
  model_version: string;
  indexed_at: string;
  documents: number;
  chunks: number;
  total_chars: number;
  bytes_on_disk: number;
}

export async function listCorpora(): Promise<CorpusSummary[]> {
  const dir = corpusDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const summaries: CorpusSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (!NAME_RX.test(name)) continue;
    try {
      const full = join(dir, entry);
      const [corpus, st] = await Promise.all([loadCorpus(name), stat(full)]);
      if (!corpus) continue;
      summaries.push({
        name: corpus.name,
        model_version: corpus.model_version,
        indexed_at: corpus.indexed_at,
        documents: corpus.stats.documents,
        chunks: corpus.stats.chunks,
        total_chars: corpus.stats.total_chars,
        bytes_on_disk: st.size,
      });
    } catch {
      // Skip malformed corpora silently in list; load will surface the error.
    }
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}
