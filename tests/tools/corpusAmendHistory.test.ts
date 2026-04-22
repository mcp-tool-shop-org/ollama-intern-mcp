import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleCorpusAmendHistory,
  corpusAmendHistorySchema,
} from "../../src/tools/corpusAmendHistory.js";
import type { RunContext } from "../../src/runContext.js";
import type { CorpusManifest } from "../../src/corpus/manifest.js";
import { manifestPath } from "../../src/corpus/manifest.js";

function makeCtx(): RunContext {
  return {
    client: {} as RunContext["client"],
    tiers: { instant: "x", workhorse: "x", deep: "x", embed: "x" },
    timeouts: { instant: 1000, workhorse: 1000, deep: 1000, embed: 1000 },
    hardwareProfile: "dev-rtx5080",
    logger: { log: () => {} } as unknown as RunContext["logger"],
  } as RunContext;
}

function writeManifest(name: string, manifest: Partial<CorpusManifest>): void {
  const full: CorpusManifest = {
    schema_version: 2,
    name,
    paths: [],
    chunks_by_path: {},
    embed_model: "nomic-embed-text",
    embed_model_resolved: null,
    chunk_chars: 1000,
    chunk_overlap: 100,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...manifest,
  } as CorpusManifest;
  const p = manifestPath(name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(full, null, 2), "utf8");
}

describe("ollama_corpus_amend_history", () => {
  let dir: string;
  const priorCorpusDir = process.env.INTERN_CORPUS_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amend-history-"));
    process.env.INTERN_CORPUS_DIR = dir;
  });
  afterEach(() => {
    if (priorCorpusDir === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = priorCorpusDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty history + snapshot note when corpus never amended", async () => {
    writeManifest("pristine", { has_amended_content: false });
    const res = await handleCorpusAmendHistory({ corpus: "pristine" }, makeCtx());
    expect(res.result.corpus).toBe("pristine");
    expect(res.result.has_amended_content).toBe(false);
    expect(res.result.amended_paths).toEqual([]);
    expect(res.result.total_amends).toBe(0);
    expect(res.result.unique_paths_amended).toBe(0);
    expect(res.result.last_amend_at).toBeNull();
    expect(res.result.note).toContain("mirrors the disk snapshot");
  });

  it("surfaces per-path entries with chunk_delta computed", async () => {
    const now = "2026-04-22T00:00:00.000Z";
    writeManifest("drifted", {
      has_amended_content: true,
      amended_paths: [
        { path: "/abs/a.md", amended_at: now, chunks_before: 3, chunks_after: 5 },
        { path: "/abs/b.md", amended_at: now, chunks_before: 2, chunks_after: 0 },
        { path: "/abs/a.md", amended_at: now, chunks_before: 5, chunks_after: 6 },
      ],
    });
    const res = await handleCorpusAmendHistory({ corpus: "drifted" }, makeCtx());
    expect(res.result.has_amended_content).toBe(true);
    expect(res.result.amended_paths).toHaveLength(3);
    expect(res.result.amended_paths[0].chunks_delta).toBe(2);
    expect(res.result.amended_paths[1].chunks_delta).toBe(-2);
    expect(res.result.amended_paths[2].chunks_delta).toBe(1);
    expect(res.result.total_amends).toBe(3);
    expect(res.result.unique_paths_amended).toBe(2);
    expect(res.result.last_amend_at).toBe(now);
    expect(res.result.note).toContain("Re-index");
  });

  it("throws SOURCE_PATH_NOT_FOUND when the corpus doesn't exist", async () => {
    await expect(
      handleCorpusAmendHistory({ corpus: "nope" }, makeCtx()),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });

  it("schema rejects empty corpus name", () => {
    const parsed = corpusAmendHistorySchema.safeParse({ corpus: "" });
    expect(parsed.success).toBe(false);
  });
});
