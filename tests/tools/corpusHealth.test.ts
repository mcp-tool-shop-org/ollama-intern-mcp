/**
 * Tests for ollama_corpus_health — the no-LLM health summary tool.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexCorpus } from "../../src/corpus/indexer.js";
import { loadManifest, saveManifest, manifestPath } from "../../src/corpus/manifest.js";
import { handleCorpusHealth } from "../../src/tools/corpusHealth.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
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
import type { RunContext } from "../../src/runContext.js";

class HashEmbedMock implements OllamaClient {
  async generate(_: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used");
  }
  async chat(_: ChatRequest): Promise<ChatResponse> {
    throw new Error("not used");
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: req.model, embeddings: inputs.map(() => new Array(8).fill(0.1)) };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(): RunContext & { logger: NullLogger } {
  return {
    client: new HashEmbedMock(),
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

let tempCorpusDir: string;
let tempSourceDir: string;
let origCorpusDir: string | undefined;
let origAllowed: string | undefined;
const MODEL = "nomic-embed-text";

const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;
const MODULE_ORIG_ALLOWED = process.env.INTERN_CORPUS_ALLOWED_ROOTS;

beforeEach(async () => {
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  origAllowed = process.env.INTERN_CORPUS_ALLOWED_ROOTS;
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-health-corpus-"));
  tempSourceDir = await mkdtemp(join(tmpdir(), "intern-health-src-"));
  process.env.INTERN_CORPUS_DIR = tempCorpusDir;
  process.env.INTERN_CORPUS_ALLOWED_ROOTS = tmpdir();
});

afterEach(async () => {
  try {
    const toRestoreCorpus = origCorpusDir ?? MODULE_ORIG_CORPUS_DIR;
    const toRestoreAllowed = origAllowed ?? MODULE_ORIG_ALLOWED;
    if (toRestoreCorpus === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = toRestoreCorpus;
    if (toRestoreAllowed === undefined) delete process.env.INTERN_CORPUS_ALLOWED_ROOTS;
    else process.env.INTERN_CORPUS_ALLOWED_ROOTS = toRestoreAllowed;
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

describe("handleCorpusHealth", () => {
  it("reports a healthy corpus with zero drift, zero failures, clean write", async () => {
    const p = await writeSource("a.md", "# Alpha\nHello world");
    await indexCorpus({ name: "healthy", paths: [p], model: MODEL, client: new HashEmbedMock() });

    const env = await handleCorpusHealth({}, makeCtx());
    expect(env.result.corpora).toHaveLength(1);
    const entry = env.result.corpora[0];
    expect(entry.name).toBe("healthy");
    expect(entry.chunks).toBeGreaterThan(0);
    expect(entry.docs).toBe(1);
    expect(entry.failed_paths_count).toBe(0);
    expect(entry.drift_detected).toBe(false);
    expect(entry.write_complete).toBe(true);
    expect(entry.warnings).toEqual([]);
    expect(entry.has_amended_content).toBe(false);
    // Freshly indexed — staleness should be 0 days.
    expect(entry.staleness_days).toBe(0);
  });

  it("surfaces write_complete=false as a warning when the manifest is missing completed_at", async () => {
    const p = await writeSource("a.md", "hello");
    await indexCorpus({ name: "incomplete", paths: [p], model: MODEL, client: new HashEmbedMock() });
    // Simulate an interrupted write — strip completed_at from manifest.
    const m = (await loadManifest("incomplete"))!;
    const { completed_at: _dropped, ...rest } = m;
    void _dropped;
    await saveManifest(rest as typeof m);

    const env = await handleCorpusHealth({ name: "incomplete" }, makeCtx());
    const entry = env.result.corpora[0];
    expect(entry.write_complete).toBe(false);
    expect(entry.warnings.some((w) => /interrupted/i.test(w))).toBe(true);
    expect(env.warnings?.some((w) => /interrupted/i.test(w))).toBe(true);
  });

  it("surfaces within-refresh embed :latest drift", async () => {
    const p = await writeSource("a.md", "drift");
    await indexCorpus({ name: "drifty", paths: [p], model: MODEL, client: new HashEmbedMock() });
    const m = (await loadManifest("drifty"))!;
    await saveManifest({
      ...m,
      embed_model_resolved_drift_within_refresh: ["nomic-embed-text:v1", "nomic-embed-text:v2"],
    });

    const env = await handleCorpusHealth({ name: "drifty" }, makeCtx());
    const entry = env.result.corpora[0];
    expect(entry.drift_detected).toBe(true);
    expect(entry.drift_within_refresh).toEqual([
      "nomic-embed-text:v1",
      "nomic-embed-text:v2",
    ]);
    expect(entry.warnings.some((w) => /drift/i.test(w))).toBe(true);
  });

  it("reports failed_paths_count on a corpus with unresolved failures", async () => {
    const p = await writeSource("a.md", "ok");
    await indexCorpus({ name: "failed", paths: [p], model: MODEL, client: new HashEmbedMock() });
    const m = (await loadManifest("failed"))!;
    await saveManifest({
      ...m,
      failed_paths: [{ path: "/tmp/nope.md", reason: "ENOENT" }],
    });

    const env = await handleCorpusHealth({}, makeCtx());
    const entry = env.result.corpora.find((c) => c.name === "failed");
    expect(entry).toBeDefined();
    expect(entry!.failed_paths_count).toBe(1);
    expect(entry!.warnings.some((w) => /failed/i.test(w))).toBe(true);
  });

  it("detailed=true adds per-file mtime + chunk_count + stale_days", async () => {
    const p = await writeSource("a.md", "hello detailed");
    await indexCorpus({ name: "detail", paths: [p], model: MODEL, client: new HashEmbedMock() });

    const env = await handleCorpusHealth({ name: "detail", detailed: true }, makeCtx());
    const entry = env.result.corpora[0];
    expect(entry.paths).toBeDefined();
    expect(entry.paths!.length).toBeGreaterThan(0);
    const pd = entry.paths!.find((x) => x.path === p);
    expect(pd).toBeDefined();
    expect(pd!.mtime).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(pd!.chunk_count).toBeGreaterThan(0);
    expect(pd!.stale_days).not.toBeNull();
  });

  it("fails loud when a specific corpus name doesn't exist", async () => {
    await expect(handleCorpusHealth({ name: "nope" }, makeCtx())).rejects.toMatchObject({
      code: "SCHEMA_INVALID",
    });
  });

  it("handles empty corpora directory without throwing", async () => {
    const env = await handleCorpusHealth({}, makeCtx());
    expect(env.result.corpora).toEqual([]);
    expect(env.warnings).toBeUndefined();
  });

  // Suppress unused-var warning for manifestPath import if the other
  // tests do not reach the path — the import documents which helper
  // writers use when targeting the manifest directly.
  void manifestPath;
  void utimes;
});
