/**
 * Tests for ollama_corpus_amend — single-file mutation that breaks the
 * snapshot invariant, surfaces the break via the manifest, and survives
 * concurrent indexes via the per-corpus lock.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexCorpus } from "../../src/corpus/indexer.js";
import { loadCorpus } from "../../src/corpus/storage.js";
import { loadManifest } from "../../src/corpus/manifest.js";
import { handleCorpusAmend } from "../../src/tools/corpusAmend.js";
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
  public embedCalls = 0;
  async generate(_: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used");
  }
  async chat(_: ChatRequest): Promise<ChatResponse> {
    throw new Error("not used");
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: `${req.model}:resolved-a`, embeddings: inputs.map(() => new Array(8).fill(0.1)) };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient): RunContext & { logger: NullLogger } {
  return {
    client,
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

// Must use a tier's configured embed model so the manifest check passes.
const MODEL = PROFILES["dev-rtx5080"].tiers.embed;

const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;
const MODULE_ORIG_ALLOWED = process.env.INTERN_CORPUS_ALLOWED_ROOTS;

beforeEach(async () => {
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  origAllowed = process.env.INTERN_CORPUS_ALLOWED_ROOTS;
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-amend-corpus-"));
  tempSourceDir = await mkdtemp(join(tmpdir(), "intern-amend-src-"));
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

describe("handleCorpusAmend", () => {
  it("replaces existing chunks for a file, sets has_amended_content=true, and bumps manifest", async () => {
    const p = await writeSource("a.md", "# First\noriginal content body here");
    await indexCorpus({ name: "k1", paths: [p], model: MODEL, client: new HashEmbedMock() });
    const before = await loadCorpus("k1");
    const beforeForPath = before!.chunks.filter((c) => c.path === p).length;
    expect(beforeForPath).toBeGreaterThan(0);

    const env = await handleCorpusAmend(
      {
        corpus: "k1",
        file_path: p,
        new_content: "# Second\ntotally different text replaces the first pass",
      },
      makeCtx(new HashEmbedMock()),
    );
    expect(env.result.corpus).toBe("k1");
    expect(env.result.file_path).toBe(p);
    expect(env.result.chunks_removed).toBe(beforeForPath);
    expect(env.result.chunks_added).toBeGreaterThan(0);
    expect(env.warnings?.some((w) => /amend/i.test(w))).toBe(true);

    const manifest = await loadManifest("k1");
    expect(manifest!.has_amended_content).toBe(true);

    // Corpus reflects the amend — text contains new content.
    const after = await loadCorpus("k1");
    const afterTexts = after!.chunks.filter((c) => c.path === p).map((c) => c.text).join(" ");
    expect(afterTexts).toContain("totally different");
    expect(afterTexts).not.toContain("original content body");
  });

  it("adds a previously-unknown file_path to the corpus and records it in manifest.paths", async () => {
    const p1 = await writeSource("a.md", "indexed body");
    await indexCorpus({ name: "k2", paths: [p1], model: MODEL, client: new HashEmbedMock() });

    // file_path for amend doesn't need to exist on disk — use a synthetic one.
    const syntheticPath = join(tempSourceDir, "synthetic.md");

    const env = await handleCorpusAmend(
      {
        corpus: "k2",
        file_path: syntheticPath,
        new_content: "# Synthetic\nthis is new content added via amend",
      },
      makeCtx(new HashEmbedMock()),
    );
    expect(env.result.chunks_removed).toBe(0);
    expect(env.result.chunks_added).toBeGreaterThan(0);

    const manifest = await loadManifest("k2");
    expect(manifest!.paths).toContain(syntheticPath);
    expect(manifest!.has_amended_content).toBe(true);
  });

  it("refuses amend when the corpus doesn't exist", async () => {
    await expect(
      handleCorpusAmend(
        {
          corpus: "ghost",
          file_path: join(tempSourceDir, "x.md"),
          new_content: "body",
        },
        makeCtx(new HashEmbedMock()),
      ),
    ).rejects.toMatchObject({ code: "CORPUS_AMEND_FAILED" });
  });

  it("a clean re-index clears has_amended_content", async () => {
    const p = await writeSource("a.md", "first body");
    await indexCorpus({ name: "k3", paths: [p], model: MODEL, client: new HashEmbedMock() });
    await handleCorpusAmend(
      { corpus: "k3", file_path: p, new_content: "amended body text here" },
      makeCtx(new HashEmbedMock()),
    );
    const mMid = await loadManifest("k3");
    expect(mMid!.has_amended_content).toBe(true);

    // Re-index should re-establish the snapshot invariant.
    await indexCorpus({ name: "k3", paths: [p], model: MODEL, client: new HashEmbedMock() });
    const mAfter = await loadManifest("k3");
    expect(mAfter!.has_amended_content).toBe(false);
  });
});
