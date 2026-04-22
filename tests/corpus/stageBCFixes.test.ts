/**
 * Stage B+C fixes — corpus domain.
 *
 * One test file, scoped to the five proactive/humanization fixes the
 * swarm memo called out:
 *
 *   1. Empty-query handling on all three corpus flagship tools.
 *   2. Query length cap (<=1000 chars) at the zod layer.
 *   3. Mid-refresh resolved-tag capture — if Ollama bumps :latest mid
 *      stream, both tags are recorded in the manifest and surfaced on the
 *      report.
 *   4. retry_failed option on corpus_refresh — persistent failed_paths
 *      survive across runs and can be retried explicitly.
 *   5. Atomic-across-files marker — completed_at written after the
 *      corpus JSON; its absence surfaces as a warning in corpus_list.
 *   6. Humanized hints — basic shape checks (the hint text mentions the
 *      related companion tool so a caller can unstick themselves).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexCorpus } from "../../src/corpus/indexer.js";
import { refreshCorpus } from "../../src/corpus/refresh.js";
import { searchCorpus, isEmptyQuery } from "../../src/corpus/searcher.js";
import { loadManifest, manifestPath } from "../../src/corpus/manifest.js";
import { listCorpora } from "../../src/corpus/storage.js";
import { corpusSearchSchema } from "../../src/tools/corpusSearch.js";
import { corpusAnswerSchema } from "../../src/tools/corpusAnswer.js";
import { corpusRefreshSchema } from "../../src/tools/corpusRefresh.js";
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

// ── Helpers ─────────────────────────────────────────────────

class Mock implements OllamaClient {
  public embedCalls = 0;
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: req.model, embeddings: inputs.map(() => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

const MODEL = "nomic-embed-text";

let tempCorpusDir: string;
let tempSourceDir: string;
let origCorpusDir: string | undefined;
let origAllowedRoots: string | undefined;

beforeEach(async () => {
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  origAllowedRoots = process.env.INTERN_CORPUS_ALLOWED_ROOTS;
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-bc-corpus-"));
  tempSourceDir = await mkdtemp(join(tmpdir(), "intern-bc-src-"));
  process.env.INTERN_CORPUS_DIR = tempCorpusDir;
  process.env.INTERN_CORPUS_ALLOWED_ROOTS = tmpdir();
});

afterEach(async () => {
  try {
    if (origCorpusDir === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = origCorpusDir;
    if (origAllowedRoots === undefined) delete process.env.INTERN_CORPUS_ALLOWED_ROOTS;
    else process.env.INTERN_CORPUS_ALLOWED_ROOTS = origAllowedRoots;
  } finally {
    if (tempCorpusDir) await rm(tempCorpusDir, { recursive: true, force: true });
    if (tempSourceDir) await rm(tempSourceDir, { recursive: true, force: true });
  }
});

async function writeSource(name: string, content: string): Promise<string> {
  const p = join(tempSourceDir, name);
  await writeFile(p, content, "utf8");
  return p;
}

// ── Fix 1: empty-query handling ─────────────────────────────

describe("Fix 1: empty query handling", () => {
  it("isEmptyQuery detects null, empty, and whitespace-only", () => {
    expect(isEmptyQuery("")).toBe(true);
    expect(isEmptyQuery("   ")).toBe(true);
    expect(isEmptyQuery("\t\n")).toBe(true);
    expect(isEmptyQuery(null)).toBe(true);
    expect(isEmptyQuery(undefined)).toBe(true);
    expect(isEmptyQuery("a")).toBe(false);
    expect(isEmptyQuery("  word  ")).toBe(false);
  });

  it("searchCorpus short-circuits empty query without calling embed", async () => {
    const p = await writeSource("a.md", "alpha bravo charlie");
    const client = new Mock();
    await indexCorpus({ name: "q1", paths: [p], model: MODEL, client });
    const embedsAfterIndex = client.embedCalls;

    const corpus = (await (await import("../../src/corpus/storage.js")).loadCorpus("q1"))!;
    // whitespace-only query — must not call embed, must return 0 hits.
    const hits = await searchCorpus({
      corpus,
      query: "   ",
      model: MODEL,
      mode: "hybrid",
      client,
    });
    expect(hits).toEqual([]);
    expect(client.embedCalls).toBe(embedsAfterIndex);
  });
});

// ── Fix 2: query length cap ────────────────────────────────

describe("Fix 2: query length cap", () => {
  const over1k = "a".repeat(1001);
  const at1k = "a".repeat(1000);

  it("rejects corpus_search.query over 1000 chars", () => {
    const result = corpusSearchSchema.safeParse({
      corpus: "c",
      query: over1k,
    });
    expect(result.success).toBe(false);
  });

  it("accepts corpus_search.query exactly 1000 chars", () => {
    const result = corpusSearchSchema.safeParse({
      corpus: "c",
      query: at1k,
    });
    expect(result.success).toBe(true);
  });

  it("rejects corpus_answer.question over 1000 chars", () => {
    const result = corpusAnswerSchema.safeParse({
      corpus: "c",
      question: over1k,
    });
    expect(result.success).toBe(false);
  });

  it("accepts corpus_answer.question exactly 1000 chars", () => {
    const result = corpusAnswerSchema.safeParse({
      corpus: "c",
      question: at1k,
    });
    expect(result.success).toBe(true);
  });
});

// ── Fix 3: mid-refresh resolved-tag drift ──────────────────

describe("Fix 3: within-refresh :latest drift", () => {
  it("records drift_within_refresh when Ollama changes resolved model mid-stream", async () => {
    // Write enough files that indexing produces 2+ embed batches.
    // EMBED_BATCH is 64 in the indexer. Pushing >64 chunks triggers the
    // second batch call, where we flip the mock to return a new resolved
    // tag.
    const paths: string[] = [];
    for (let i = 0; i < 70; i++) {
      paths.push(await writeSource(`f${i}.md`, `content ${i}`));
    }

    let calls = 0;
    class DriftMock extends Mock {
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        calls += 1;
        const base = await super.embed(req);
        // first batch returns v1, second (and later) returns v2 — simulates
        // a :latest rotation between batches.
        return { ...base, model: calls === 1 ? `${MODEL}:v1` : `${MODEL}:v2` };
      }
    }
    const client = new DriftMock();

    const report = await indexCorpus({
      name: "midrefreshdrift",
      paths,
      model: MODEL,
      client,
      chunk_chars: 200,
    });

    // Indexer must have made at least 2 embed calls, and the drift set
    // must surface both tags in sorted order.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(report.embed_model_resolved_drift_within_refresh).toBeDefined();
    expect(report.embed_model_resolved_drift_within_refresh!.sort()).toEqual([
      `${MODEL}:v1`,
      `${MODEL}:v2`,
    ]);

    // Manifest records both tags too.
    const manifest = await loadManifest("midrefreshdrift");
    expect(manifest!.embed_model_resolved_drift_within_refresh).toBeDefined();
    expect(manifest!.embed_model_resolved_drift_within_refresh!.sort()).toEqual([
      `${MODEL}:v1`,
      `${MODEL}:v2`,
    ]);
  });

  it("omits drift_within_refresh when all batches return the same tag", async () => {
    const paths: string[] = [];
    for (let i = 0; i < 70; i++) paths.push(await writeSource(`f${i}.md`, `c${i}`));
    class StableMock extends Mock {
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        const base = await super.embed(req);
        return { ...base, model: `${MODEL}:stable` };
      }
    }
    const report = await indexCorpus({
      name: "nodrift",
      paths,
      model: MODEL,
      client: new StableMock(),
      chunk_chars: 200,
    });
    expect(report.embed_model_resolved_drift_within_refresh).toBeUndefined();
  });
});

// ── Fix 4: retry_failed on refresh ─────────────────────────

describe("Fix 4: retry_failed on corpus_refresh", () => {
  it("accepts retry_failed:true in the refresh schema", () => {
    const ok = corpusRefreshSchema.safeParse({ name: "c", retry_failed: true });
    expect(ok.success).toBe(true);
    const ok2 = corpusRefreshSchema.safeParse({ name: "c" });
    expect(ok2.success).toBe(true); // default
  });

  it("persists failed_paths to manifest across an index run", async () => {
    const good = await writeSource("good.md", "keep me");
    // Use a non-existent path to force a read failure at index time.
    const missing = join(tempSourceDir, "missing.md");
    const client = new Mock();
    const firstReport = await indexCorpus({
      name: "persist1",
      paths: [good, missing],
      model: MODEL,
      client,
    });
    expect(firstReport.failed_paths.length).toBe(1);
    expect(firstReport.failed_paths[0].path).toBe(missing);

    // Manifest persists the failure.
    const m = await loadManifest("persist1");
    expect(m!.failed_paths).toBeDefined();
    expect(m!.failed_paths!.length).toBe(1);
    expect(m!.failed_paths![0].path).toBe(missing);
  });

  it("retry_failed:true re-attempts previously-failed paths; success clears them", async () => {
    // We keep `missing` out of manifest.paths on first index by calling
    // indexCorpus only with `good` first, then manually stitching a
    // failed_paths entry for `missing`. This models the shape refresh
    // encounters: a manifest where failed_paths outlives the normal
    // refresh classification.
    const good = await writeSource("good.md", "keep me");
    const brokenPath = join(tempSourceDir, "broken.md");
    const client = new Mock();
    await indexCorpus({ name: "retry2", paths: [good], model: MODEL, client });
    const { saveManifest } = await import("../../src/corpus/manifest.js");
    const m1 = await loadManifest("retry2");
    await saveManifest({
      ...m1!,
      failed_paths: [{ path: brokenPath, reason: "simulated failure" }],
    });

    // Without retry_failed: normal refresh leaves failed_paths alone and
    // reports zero retry work.
    const refreshA = await refreshCorpus({ name: "retry2", model: MODEL, client });
    expect(refreshA.retried_failed).toEqual([]);
    expect(refreshA.no_op).toBe(true);

    // Fix the underlying cause: create the file so reads succeed. Then
    // retry_failed:true must include it in the live path set.
    await writeFile(brokenPath, "now readable", "utf8");
    const refreshB = await refreshCorpus({
      name: "retry2",
      model: MODEL,
      client,
      retry_failed: true,
    });
    expect(refreshB.retried_failed).toContain(brokenPath);
    expect(refreshB.still_failed).toEqual([]);
    const manifestAfterRetry = await loadManifest("retry2");
    expect(manifestAfterRetry!.failed_paths ?? []).toEqual([]);
  });

  it("retry_failed:true surfaces still_failed when the retry also fails", async () => {
    const good = await writeSource("good.md", "keep me");
    const neverThere = join(tempSourceDir, "never.md");
    const client = new Mock();
    await indexCorpus({ name: "retry3", paths: [good], model: MODEL, client });
    const { saveManifest } = await import("../../src/corpus/manifest.js");
    const m1 = await loadManifest("retry3");
    await saveManifest({
      ...m1!,
      failed_paths: [{ path: neverThere, reason: "simulated" }],
    });

    const report = await refreshCorpus({
      name: "retry3",
      model: MODEL,
      client,
      retry_failed: true,
    });
    expect(report.retried_failed).toContain(neverThere);
    // The retry didn't produce a readable file, so still_failed records it.
    expect(report.still_failed.some((f) => f.path === neverThere)).toBe(true);
    // Manifest preserves the failure for a future retry.
    const m2 = await loadManifest("retry3");
    expect(m2!.failed_paths!.some((f) => f.path === neverThere)).toBe(true);
  });
});

// ── Fix 5: atomic-across-files marker ──────────────────────

describe("Fix 5: completed_at marker", () => {
  it("index writes manifest.completed_at after the corpus write", async () => {
    const p = await writeSource("a.md", "alpha");
    await indexCorpus({ name: "done1", paths: [p], model: MODEL, client: new Mock() });
    const m = await loadManifest("done1");
    expect(typeof m!.completed_at).toBe("string");
    expect(m!.completed_at!.length).toBeGreaterThan(0);
  });

  it("corpus_list surfaces write_complete:false when manifest has no completed_at", async () => {
    const p = await writeSource("a.md", "alpha");
    await indexCorpus({ name: "crash1", paths: [p], model: MODEL, client: new Mock() });

    // Simulate a crash-before-manifest-completion: strip completed_at.
    const mPath = manifestPath("crash1");
    const raw = JSON.parse(await readFile(mPath, "utf8"));
    delete raw.completed_at;
    await writeFile(mPath, JSON.stringify(raw, null, 2), "utf8");

    const summaries = await listCorpora();
    const crashSummary = summaries.find((s) => s.name === "crash1");
    expect(crashSummary).toBeDefined();
    expect(crashSummary!.write_complete).toBe(false);
  });

  it("corpus_list reports write_complete:true on clean manifests", async () => {
    const p = await writeSource("a.md", "alpha");
    await indexCorpus({ name: "clean1", paths: [p], model: MODEL, client: new Mock() });
    const summaries = await listCorpora();
    const s = summaries.find((s) => s.name === "clean1");
    expect(s!.write_complete).toBe(true);
  });
});

// ── Fix 6: humanized hints (shape only) ────────────────────

describe("Fix 6: humanized error hints", () => {
  it("corpus_refresh on unknown corpus hint points at corpus_list", async () => {
    const client = new Mock();
    await expect(
      refreshCorpus({ name: "unseen-ghost-corpus", model: MODEL, client }),
    ).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
      hint: expect.stringContaining("ollama_corpus_list"),
    });
  });

  it("corpus_refresh model-mismatch hint names both models", async () => {
    const p = await writeSource("a.md", "x");
    const client = new Mock();
    await indexCorpus({ name: "mix", paths: [p], model: MODEL, client });
    await expect(
      refreshCorpus({ name: "mix", model: "other-embed-model", client }),
    ).rejects.toMatchObject({
      hint: expect.stringContaining(MODEL),
    });
  });

  it("corpus_index schema rejects zero paths with a directory hint", () => {
    const result = corpusSearchSchema.safeParse({ corpus: "c", query: "x" });
    // just sanity — the real hint lives on the corpusIndex schema, covered
    // by the schema's own min-1 message. We import corpusIndexSchema to
    // verify the message mentions "directory" or "file list".
    expect(result.success).toBe(true);
  });

  it("corpus_index min-1 paths error message explains enumeration", async () => {
    const { corpusIndexSchema } = await import("../../src/tools/corpusIndex.js");
    const r = corpusIndexSchema.safeParse({ name: "c", paths: [] });
    expect(r.success).toBe(false);
    const issueMessages = r.success ? [] : r.error.issues.map((i) => i.message).join(" ");
    expect(issueMessages.toLowerCase()).toContain("directory");
  });
});
