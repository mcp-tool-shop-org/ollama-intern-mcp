/**
 * Retrieval eval pack — slice 4 of the Retrieval Truth Spine.
 *
 * Loads evals/gold/retrieval.jsonl, builds the fixture corpus under
 * evals/fixtures/corpus/, indexes it with an offline bag-of-tokens
 * embed mock, and runs every gold query through every search mode.
 *
 * The mock's dense signal is INTENTIONALLY different from BM25:
 *   - BM25 stopword-filters; the mock does not
 *   - BM25 has IDF + length normalization; the mock is plain L2-normalized
 *     bag-of-tokens
 * That asymmetry lets hybrid fusion differentiate from lexical alone,
 * without baking in any "semantic" signal the system can't actually
 * deliver. The point of the pack is to expose weaknesses, not flatter them.
 *
 * Assertions are evidence-based floors: they catch regressions against
 * the currently observed numbers. Raising them is a product win; lowering
 * them without justification is a silent retreat.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { indexCorpus } from "../../src/corpus/indexer.js";
import { loadCorpus } from "../../src/corpus/storage.js";
import {
  loadGold,
  runRetrievalEval,
  summarizeEval,
  formatEvalReport,
  QUERY_CLASSES,
  type EvalSummary,
  type EvalRecord,
} from "../../src/evals/retrieval.js";
import { SEARCH_MODES } from "../../src/corpus/searcher.js";
import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "../../src/ollama.js";
import type { Residency } from "../../src/envelope.js";

// ── Paths ───────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const FIXTURE_DIR = join(REPO_ROOT, "evals/fixtures/corpus");
const GOLD_PATH = join(REPO_ROOT, "evals/gold/retrieval.jsonl");
const EMBED_MODEL = "mock-bag-of-tokens";

// ── Offline embed mock ──────────────────────────────────────

function stableHash(s: string): number {
  // Small FNV-1a variant; deterministic, fast, no crypto needed.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

class BagOfTokensEmbedMock implements OllamaClient {
  public embedCalls = 0;
  private readonly dim = 128;
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      embeddings: inputs.map((text) => this.vectorize(text)),
    };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
  private vectorize(text: string): number[] {
    const vec = new Array(this.dim).fill(0);
    // Deliberately NO stopword filter — this differs from BM25 and gives
    // hybrid fusion a genuinely different signal to combine.
    const tokens = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
    for (const tok of tokens) {
      const h = stableHash(tok) % this.dim;
      vec[h] += 1;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    const d = Math.sqrt(norm) || 1;
    return vec.map((v) => v / d);
  }
}

// ── Shared state ────────────────────────────────────────────

let records: EvalRecord[];
let summary: EvalSummary;
let tempCorpusDir: string;

// Module-load snapshot — bulletproof restore even if beforeAll throws
// before its own snapshot line runs. (T001)
const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;

beforeAll(async () => {
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-retrieval-eval-"));
  const origCorpusDir = process.env.INTERN_CORPUS_DIR ?? MODULE_ORIG_CORPUS_DIR;
  process.env.INTERN_CORPUS_DIR = tempCorpusDir;

  try {
    const entries = await readdir(FIXTURE_DIR);
    const mdPaths = entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => join(FIXTURE_DIR, e))
      .sort();
    expect(mdPaths.length).toBeGreaterThanOrEqual(15);

    const client = new BagOfTokensEmbedMock();
    await indexCorpus({
      name: "eval",
      paths: mdPaths,
      model: EMBED_MODEL,
      chunk_chars: 800,
      chunk_overlap: 100,
      client,
    });
    const corpus = await loadCorpus("eval");
    if (!corpus) throw new Error("failed to build eval corpus");

    const gold = await loadGold(GOLD_PATH);
    expect(gold.length).toBe(20);

    records = await runRetrievalEval({
      gold,
      corpus,
      client,
      model: EMBED_MODEL,
      topK: 3,
      previewChars: 400,
    });
    summary = summarizeEval(records);

    // Print the full table — this is the product-facing artifact.
    console.log(formatEvalReport(summary));
  } finally {
    if (origCorpusDir === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = origCorpusDir;
  }
});

// ── Tests ───────────────────────────────────────────────────

describe("retrieval eval pack", () => {
  it("gold set has 5 queries per class", () => {
    const gold = records.filter((r) => r.mode === "hybrid"); // dedupe per-query
    const counts: Record<string, number> = {};
    for (const r of gold) counts[r.class] = (counts[r.class] ?? 0) + 1;
    for (const cls of QUERY_CLASSES) expect(counts[cls]).toBe(5);
  });

  it("reports unreachable queries and stays above an honest reachability floor", () => {
    // "Reachable" = at least one mode puts the correct doc in top-3. With
    // the offline bag-of-tokens mock, purely paraphrased semantic queries
    // can be unreachable — that's the paraphrase weakness this pack is
    // built to expose. The floor is deliberately below 100% so the eval
    // reports honestly instead of hiding the known gap.
    const reachable = new Map<string, boolean>();
    for (const r of records) {
      if (!reachable.has(r.id)) reachable.set(r.id, false);
      if (r.hit3) reachable.set(r.id, true);
    }
    const total = reachable.size;
    const hit = [...reachable.values()].filter(Boolean).length;
    const unreachable = [...reachable.entries()].filter(([, v]) => !v).map(([id]) => id);
    console.log(`Unreachable by any mode (known paraphrase gap with offline mock): ${unreachable.join(", ") || "(none)"}`);
    // Observed: 17/20 reachable = 85%. Floor at 80% gives a 1-query margin
    // before this test flips red — enough to catch a real regression
    // without flaking on mock-embedder jitter.
    expect(hit / total).toBeGreaterThanOrEqual(0.8);
  });

  // Evidence-based floors — set ~10 points below observed so regressions
  // fire loudly but small variation doesn't flake. Raising these is a
  // product win; lowering them without justification is a silent retreat.
  it("hybrid (default) holds its floor", () => {
    // Observed: P@1 = 75%, P@3 = 85%
    expect(summary.byMode.hybrid.precision3).toBeGreaterThanOrEqual(0.75);
    expect(summary.byMode.hybrid.precision1).toBeGreaterThanOrEqual(0.65);
  });

  it("lexical holds the floor on fact + procedural classes", () => {
    // Observed: fact P@3 = 100%, procedural P@3 = 100%
    expect(summary.byModeByClass.lexical.fact.precision3).toBeGreaterThanOrEqual(0.85);
    expect(summary.byModeByClass.lexical.procedural.precision3).toBeGreaterThanOrEqual(0.85);
  });

  it("title_path holds its floor on confusable queries (metadata-heavy)", () => {
    // Observed: 40%. Floor at 30% — title_path is expected to struggle
    // on confusables that hinge on body-text distinctions.
    expect(summary.byModeByClass.title_path.confusable.precision3).toBeGreaterThanOrEqual(0.3);
  });

  it("fact mode precision@3 never drops more than 5 points below hybrid", () => {
    // Fact = hybrid + dominant exact-substring boost + secondary
    // short-chunk boost. If this ever regresses, the boost law broke.
    expect(summary.byMode.fact.precision3).toBeGreaterThanOrEqual(summary.byMode.hybrid.precision3 - 0.05);
  });

  it("phrase assertions on fact queries are satisfied whenever the right doc is retrieved", () => {
    // When fact-mode retrieves the correct doc in top-3 for a query with
    // expected_phrases, the phrase check must also pass — otherwise the
    // chunker/preview is hiding the fact from the caller.
    const factRecords = records.filter((r) => r.mode === "fact" && r.phrasesHit !== null);
    expect(factRecords.length).toBeGreaterThan(0);
    const retrievedRight = factRecords.filter((r) => r.hit3);
    for (const r of retrievedRight) {
      expect(r.phrasesHit, `${r.id}: retrieved the right doc but the phrase wasn't in the preview`).toBe(true);
    }
  });
});
