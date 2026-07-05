/**
 * M2 — corpus_index / corpus_amend handlers must re-validate their schema's
 * top-level .refine() (chunk_overlap < chunk_chars).
 *
 * index.ts registers these tools via `<schema>.shape`, which hands the MCP
 * SDK only the field map — the object-level .refine() never runs at the
 * transport layer. Without a handler-side re-check, an invalid geometry is
 * silently clamped by the chunker while the manifest records the requested
 * (never-used) value → permanent manifest-vs-reality drift.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexCorpus } from "../../src/corpus/indexer.js";
import { loadManifest, manifestPath } from "../../src/corpus/manifest.js";
import { handleCorpusIndex } from "../../src/tools/corpusIndex.js";
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

class EmbedMock implements OllamaClient {
  public embedCalls = 0;
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: `${req.model}:resolved`, embeddings: inputs.map(() => new Array(8).fill(0.1)) };
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

const MODEL = PROFILES["dev-rtx5080"].tiers.embed;
let corpusDir: string;
let srcDir: string;
let origCorpusDir: string | undefined;
let origAllowed: string | undefined;
const M_CORPUS = process.env.INTERN_CORPUS_DIR;
const M_ALLOWED = process.env.INTERN_CORPUS_ALLOWED_ROOTS;

beforeEach(async () => {
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  origAllowed = process.env.INTERN_CORPUS_ALLOWED_ROOTS;
  corpusDir = await mkdtemp(join(tmpdir(), "intern-refine-corpus-"));
  srcDir = await mkdtemp(join(tmpdir(), "intern-refine-src-"));
  process.env.INTERN_CORPUS_DIR = corpusDir;
  process.env.INTERN_CORPUS_ALLOWED_ROOTS = tmpdir();
});

afterEach(async () => {
  try {
    const c = origCorpusDir ?? M_CORPUS;
    const a = origAllowed ?? M_ALLOWED;
    if (c === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = c;
    if (a === undefined) delete process.env.INTERN_CORPUS_ALLOWED_ROOTS;
    else process.env.INTERN_CORPUS_ALLOWED_ROOTS = a;
  } finally {
    if (corpusDir) await rm(corpusDir, { recursive: true, force: true });
    if (srcDir) await rm(srcDir, { recursive: true, force: true });
  }
});

async function writeSource(name: string, content: string): Promise<string> {
  const p = join(srcDir, name);
  await writeFile(p, content, "utf8");
  return p;
}

describe("handleCorpusIndex — cross-field refine re-check (M2)", () => {
  it("rejects chunk_overlap >= chunk_chars with SCHEMA_INVALID and writes NO manifest", async () => {
    const p = await writeSource("a.md", "some body text to chunk into pieces");
    const client = new EmbedMock();
    await expect(
      handleCorpusIndex(
        { name: "bad", paths: [p], chunk_chars: 200, chunk_overlap: 200 },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    // Failed loud BEFORE embedding or writing a manifest.
    expect(client.embedCalls).toBe(0);
    expect(existsSync(manifestPath("bad"))).toBe(false);
    expect(await loadManifest("bad")).toBeNull();
  });

  it("accepts a valid chunk_overlap < chunk_chars", async () => {
    const p = await writeSource("a.md", "some body text to chunk into pieces");
    const env = await handleCorpusIndex(
      { name: "ok", paths: [p], chunk_chars: 200, chunk_overlap: 20 },
      makeCtx(new EmbedMock()),
    );
    expect(env.result.name).toBe("ok");
    expect(await loadManifest("ok")).not.toBeNull();
  });
});

describe("handleCorpusAmend — cross-field refine re-check (M2)", () => {
  it("rejects chunk_overlap >= chunk_chars with SCHEMA_INVALID and does NOT mutate the manifest", async () => {
    const p = await writeSource("a.md", "original indexed body content");
    await indexCorpus({ name: "amendbad", paths: [p], model: MODEL, client: new EmbedMock() });
    const before = await loadManifest("amendbad");
    expect(before!.has_amended_content).toBe(false);

    await expect(
      handleCorpusAmend(
        {
          corpus: "amendbad",
          file_path: p,
          new_content: "replacement text for the amend",
          chunk_chars: 200,
          chunk_overlap: 500,
        },
        makeCtx(new EmbedMock()),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });

    // Manifest untouched — no amend breadcrumb, same updated_at.
    const after = await loadManifest("amendbad");
    expect(after!.has_amended_content).toBe(false);
    expect(after!.updated_at).toBe(before!.updated_at);
  });
});
