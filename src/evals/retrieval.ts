/**
 * Retrieval eval runner — measurement law for the Retrieval Truth Spine.
 *
 * Loads gold queries from evals/gold/retrieval.jsonl, runs every query
 * through every search mode against a fixture corpus, and reports
 * precision@1 and precision@3 per (mode × class) plus per-mode and
 * overall aggregates.
 *
 * The runner is deliberately retrieval-native: assertions check whether
 * the expected path appears in the top-K hits, not whether the answer
 * is correct. Answer synthesis is slice 5; measurement is the floor
 * under it.
 *
 * No product-surface changes ride on this file. It is a pure consumer
 * of searchCorpus() and the corpus schema.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CorpusFile } from "../corpus/storage.js";
import { searchCorpus, SEARCH_MODES, type SearchMode, type CorpusHit } from "../corpus/searcher.js";
import type { OllamaClient } from "../ollama.js";

export type QueryClass = "semantic" | "fact" | "procedural" | "confusable";

export const QUERY_CLASSES: readonly QueryClass[] = [
  "semantic",
  "fact",
  "procedural",
  "confusable",
] as const;

export interface GoldQuery {
  id: string;
  class: QueryClass;
  query: string;
  /** Paths that count as correct answers. Match is OR: at least one must appear in top-K. Paths are matched by basename so fixture-dir location doesn't matter. */
  expected_paths: string[];
  /** Optional factual anchor. If present, at least one matching chunk's text must contain every phrase. */
  expected_phrases?: string[];
}

export async function loadGold(filePath: string): Promise<GoldQuery[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const queries: GoldQuery[] = [];
  for (const line of lines) {
    const q = JSON.parse(line) as GoldQuery;
    if (!QUERY_CLASSES.includes(q.class)) {
      throw new Error(`retrieval.jsonl: unknown class "${q.class}" on ${q.id}`);
    }
    queries.push(q);
  }
  return queries;
}

export interface EvalRecord {
  id: string;
  class: QueryClass;
  query: string;
  mode: SearchMode;
  top_paths: string[];         // basename of top-k, preserving order
  hit1: boolean;
  hit3: boolean;
  /** null if no expected_phrases on the query. */
  phrasesHit: boolean | null;
}

function pathMatches(hitPath: string, expected: string): boolean {
  // Expected paths in gold are basenames; hit paths are absolute. Compare by basename.
  return basename(hitPath) === basename(expected);
}

function anyExpectedInTop(
  hits: CorpusHit[],
  expected: string[],
  n: number,
): boolean {
  for (let i = 0; i < Math.min(n, hits.length); i++) {
    for (const ex of expected) {
      if (pathMatches(hits[i].path, ex)) return true;
    }
  }
  return false;
}

function phrasesSatisfied(
  hits: CorpusHit[],
  expected: string[],
  phrases: string[],
): boolean {
  // Find every hit whose path matches an expected doc, and check
  // whether any one of those hits' text contains all phrases.
  for (const hit of hits) {
    if (!expected.some((e) => pathMatches(hit.path, e))) continue;
    // Use preview text if available; otherwise we'd need the chunk store.
    // Runner always passes preview_chars so this is populated.
    const text = (hit.preview ?? "").toLowerCase();
    if (phrases.every((p) => text.includes(p.toLowerCase()))) return true;
  }
  return false;
}

export interface RunEvalOptions {
  gold: GoldQuery[];
  corpus: CorpusFile;
  client: OllamaClient;
  model: string;
  topK?: number;
  previewChars?: number;
}

export async function runRetrievalEval(opts: RunEvalOptions): Promise<EvalRecord[]> {
  const topK = opts.topK ?? 3;
  const previewChars = opts.previewChars ?? 400;
  const records: EvalRecord[] = [];
  for (const q of opts.gold) {
    for (const mode of SEARCH_MODES) {
      const hits = await searchCorpus({
        corpus: opts.corpus,
        query: q.query,
        model: opts.model,
        mode,
        top_k: topK,
        preview_chars: previewChars,
        client: opts.client,
      });
      const hit1 = anyExpectedInTop(hits, q.expected_paths, 1);
      const hit3 = anyExpectedInTop(hits, q.expected_paths, 3);
      const phrasesHit = q.expected_phrases && q.expected_phrases.length > 0
        ? phrasesSatisfied(hits, q.expected_paths, q.expected_phrases)
        : null;
      records.push({
        id: q.id,
        class: q.class,
        query: q.query,
        mode,
        top_paths: hits.map((h) => basename(h.path)),
        hit1,
        hit3,
        phrasesHit,
      });
    }
  }
  return records;
}

export interface CellMetrics {
  n: number;
  precision1: number;
  precision3: number;
}

export interface EvalSummary {
  overall: CellMetrics;
  byMode: Record<SearchMode, CellMetrics>;
  byModeByClass: Record<SearchMode, Record<QueryClass, CellMetrics>>;
}

function emptyCell(): CellMetrics {
  return { n: 0, precision1: 0, precision3: 0 };
}

function accumulate(cell: CellMetrics, r: EvalRecord): void {
  cell.n += 1;
  cell.precision1 += r.hit1 ? 1 : 0;
  cell.precision3 += r.hit3 ? 1 : 0;
}

function finalize(cell: CellMetrics): CellMetrics {
  if (cell.n === 0) return cell;
  return {
    n: cell.n,
    precision1: cell.precision1 / cell.n,
    precision3: cell.precision3 / cell.n,
  };
}

export function summarizeEval(records: EvalRecord[]): EvalSummary {
  const overall = emptyCell();
  const byMode: Record<string, CellMetrics> = {};
  const byModeByClass: Record<string, Record<string, CellMetrics>> = {};
  for (const m of SEARCH_MODES) {
    byMode[m] = emptyCell();
    byModeByClass[m] = {};
    for (const c of QUERY_CLASSES) byModeByClass[m][c] = emptyCell();
  }
  for (const r of records) {
    accumulate(overall, r);
    accumulate(byMode[r.mode], r);
    accumulate(byModeByClass[r.mode][r.class], r);
  }
  return {
    overall: finalize(overall),
    byMode: Object.fromEntries(
      Object.entries(byMode).map(([k, v]) => [k, finalize(v)]),
    ) as Record<SearchMode, CellMetrics>,
    byModeByClass: Object.fromEntries(
      Object.entries(byModeByClass).map(([m, classes]) => [
        m,
        Object.fromEntries(Object.entries(classes).map(([c, v]) => [c, finalize(v)])),
      ]),
    ) as Record<SearchMode, Record<QueryClass, CellMetrics>>,
  };
}

function pct(x: number): string {
  return (x * 100).toFixed(0).padStart(3, " ") + "%";
}

/**
 * Markdown-friendly report suitable for console.log during tests. The
 * shape is stable so it can be diffed between runs.
 */
export function formatEvalReport(summary: EvalSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("## Retrieval eval — precision@1 / precision@3");
  lines.push("");
  lines.push("Per mode × class (n = queries in that class):");
  lines.push("");
  const header = ["mode".padEnd(11), ...QUERY_CLASSES.map((c) => c.padStart(14)), "overall".padStart(14)].join(" | ");
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const mode of SEARCH_MODES) {
    const cells: string[] = [mode.padEnd(11)];
    for (const c of QUERY_CLASSES) {
      const m = summary.byModeByClass[mode][c];
      cells.push(`${pct(m.precision1)}/${pct(m.precision3)}`.padStart(14));
    }
    const o = summary.byMode[mode];
    cells.push(`${pct(o.precision1)}/${pct(o.precision3)}`.padStart(14));
    lines.push(cells.join(" | "));
  }
  lines.push("");
  lines.push(
    `Overall across all modes: P@1 ${pct(summary.overall.precision1)}, P@3 ${pct(summary.overall.precision3)} (n=${summary.overall.n})`,
  );
  lines.push("");
  return lines.join("\n");
}
