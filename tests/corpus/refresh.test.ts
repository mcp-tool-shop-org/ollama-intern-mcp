/**
 * Corpus refresh tests — Workflow Spine B.
 *
 * Exercises the laws of the living-corpus contract:
 *   - manifest is the source of truth
 *   - deletes are real (both manifest-removed and disk-missing)
 *   - drift is legible (per-path lists + chunk counts)
 *   - idempotence is sacred (no-op refresh makes zero embed calls,
 *     zero disk writes to the manifest)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexCorpus } from "../../src/corpus/indexer.js";
import { refreshCorpus } from "../../src/corpus/refresh.js";
import { loadCorpus } from "../../src/corpus/storage.js";
import { loadManifest, saveManifest, manifestPath, MANIFEST_SCHEMA_VERSION } from "../../src/corpus/manifest.js";
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

class CountingEmbedMock implements OllamaClient {
  public embedCalls = 0;
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      embeddings: inputs.map((t) => toVec(t)),
    };
  }
  async residency(_: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function toVec(text: string): number[] {
  const v = new Array(8).fill(0);
  for (const ch of text.toLowerCase()) {
    const code = ch.charCodeAt(0);
    if (code >= 97 && code <= 122) v[(code - 97) % 8] += 1;
  }
  const sum = v.reduce((s, x) => s + x, 0) || 1;
  return v.map((x) => x / sum);
}

// ── Fixture lifecycle ───────────────────────────────────────

let tempCorpusDir: string;
let tempSourceDir: string;
let origCorpusDir: string | undefined;

const MODEL = "nomic-embed-text";

// Capture the original env value once at module load. Even if a beforeEach
// throws before reaching the assignment below, afterEach still has the
// correct pre-test value to restore — INTERN_CORPUS_DIR can never leak
// out of this test file. (F-001)
const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;

beforeEach(async () => {
  // Snapshot per-test too, in case a nested describe mutates it between hooks.
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-refresh-corpus-"));
  tempSourceDir = await mkdtemp(join(tmpdir(), "intern-refresh-src-"));
  process.env.INTERN_CORPUS_DIR = tempCorpusDir;
});

afterEach(async () => {
  // Restore env unconditionally, regardless of any earlier throw. The
  // finally-style try/finally wrapping the restore means even a failed
  // directory cleanup can't leave the env pointing at a deleted path.
  try {
    const toRestore = origCorpusDir ?? MODULE_ORIG_CORPUS_DIR;
    if (toRestore === undefined) {
      delete process.env.INTERN_CORPUS_DIR;
    } else {
      process.env.INTERN_CORPUS_DIR = toRestore;
    }
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

// ── Manifest roundtrip ─────────────────────────────────────

describe("manifest", () => {
  it("indexCorpus writes a manifest alongside the corpus", async () => {
    const p = await writeSource("a.md", "# Alpha\nhello");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "m1", paths: [p], model: MODEL, client });

    const manifest = await loadManifest("m1");
    expect(manifest).not.toBeNull();
    expect(manifest!.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest!.name).toBe("m1");
    expect(manifest!.embed_model).toBe(MODEL);
    expect(manifest!.paths).toContain(p);
    expect(manifest!.created_at).toBe(manifest!.updated_at);
  });

  it("re-running indexCorpus preserves created_at but bumps updated_at", async () => {
    const p = await writeSource("a.md", "hello");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "m2", paths: [p], model: MODEL, client });
    const first = await loadManifest("m2");
    await new Promise((r) => setTimeout(r, 10)); // ensure timestamp changes
    await indexCorpus({ name: "m2", paths: [p], model: MODEL, client });
    const second = await loadManifest("m2");
    expect(second!.created_at).toBe(first!.created_at);
    expect(second!.updated_at).not.toBe(first!.updated_at);
  });

  it("missing manifest returns null", async () => {
    expect(await loadManifest("never-indexed")).toBeNull();
  });

  it("indexCorpus captures the resolved embed tag into the manifest", async () => {
    // When Ollama returns a resolved id like "nomic-embed-text:latest" in
    // the EmbedResponse, the manifest stores it as the freshness anchor.
    const p = await writeSource("a.md", "hello");
    class ResolvedMock extends CountingEmbedMock {
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        const base = await super.embed(req);
        return { ...base, model: `${req.model}:resolved-abc` };
      }
    }
    const client = new ResolvedMock();
    await indexCorpus({ name: "res1", paths: [p], model: MODEL, client });
    const manifest = await loadManifest("res1");
    expect(manifest!.embed_model_resolved).toBe(`${MODEL}:resolved-abc`);
  });

  it("loadManifest migrates v1 manifests to v2 in-memory with null resolved tag", async () => {
    // Legacy v1 manifests (written before schema v2 shipped) must keep
    // loading — they migrate to v2 with embed_model_resolved=null so the
    // drift check activates on the next embed, not all at once.
    const p = await writeSource("a.md", "hello");
    await indexCorpus({ name: "legacy", paths: [p], model: MODEL, client: new CountingEmbedMock() });
    // Simulate a v1 manifest on disk: drop the new field, pin schema_version=1.
    const mPath = manifestPath("legacy");
    const raw = JSON.parse(await readFile(mPath, "utf8"));
    delete raw.embed_model_resolved;
    raw.schema_version = 1;
    await writeFile(mPath, JSON.stringify(raw, null, 2), "utf8");

    const migrated = await loadManifest("legacy");
    expect(migrated!.schema_version).toBe(MANIFEST_SCHEMA_VERSION);
    expect(migrated!.embed_model_resolved).toBeNull();
  });
});

describe("refreshCorpus — :latest drift detection", () => {
  it("surfaces embed_model_resolved_drift when Ollama reports a different resolved tag", async () => {
    // Initial index pins manifest to "…:resolved-v1". A subsequent refresh
    // that embeds something gets "…:resolved-v2" → drift field appears.
    const p = await writeSource("a.md", "alpha");
    let phase: "v1" | "v2" = "v1";
    class DriftMock extends CountingEmbedMock {
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        const base = await super.embed(req);
        return { ...base, model: `${req.model}:resolved-${phase}` };
      }
    }
    const client = new DriftMock();

    await indexCorpus({ name: "drift1", paths: [p], model: MODEL, client });
    const m1 = await loadManifest("drift1");
    expect(m1!.embed_model_resolved).toBe(`${MODEL}:resolved-v1`);

    // Change a file so refresh does real work (triggers an embed + captures
    // the current resolved tag). Flip the mock to v2 for that call.
    await writeFile(p, "alpha updated", "utf8");
    phase = "v2";
    const report = await refreshCorpus({ name: "drift1", model: MODEL, client });

    expect(report.no_op).toBe(false);
    expect(report.embed_model_resolved_drift).toEqual({
      prior: `${MODEL}:resolved-v1`,
      current: `${MODEL}:resolved-v2`,
    });
  });

  it("omits drift field when no-op refresh (no probe this run)", async () => {
    const p = await writeSource("a.md", "alpha");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "drift2", paths: [p], model: MODEL, client });
    const report = await refreshCorpus({ name: "drift2", model: MODEL, client });
    expect(report.no_op).toBe(true);
    expect(report.embed_model_resolved_drift).toBeUndefined();
  });

  it("omits drift field when resolved tag is unchanged across refreshes", async () => {
    const p = await writeSource("a.md", "alpha");
    class StableMock extends CountingEmbedMock {
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        const base = await super.embed(req);
        return { ...base, model: `${req.model}:stable` };
      }
    }
    const client = new StableMock();
    await indexCorpus({ name: "drift3", paths: [p], model: MODEL, client });
    await writeFile(p, "alpha updated", "utf8");
    const report = await refreshCorpus({ name: "drift3", model: MODEL, client });
    expect(report.no_op).toBe(false);
    expect(report.embed_model_resolved_drift).toBeUndefined();
  });
});

// ── Refresh behavior ───────────────────────────────────────

describe("refreshCorpus", () => {
  it("no-op refresh: same files, same hashes → zero embed calls, no manifest bump", async () => {
    const p1 = await writeSource("a.md", "alpha body");
    const p2 = await writeSource("b.md", "bravo body");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "noop", paths: [p1, p2], model: MODEL, client });
    const embedsAfterIndex = client.embedCalls;
    const manifestBefore = await loadManifest("noop");

    await new Promise((r) => setTimeout(r, 5)); // let wall clock move
    const report = await refreshCorpus({ name: "noop", model: MODEL, client });

    expect(report.no_op).toBe(true);
    expect(report.added).toEqual([]);
    expect(report.changed).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.unchanged.sort()).toEqual([p1, p2].sort());
    expect(report.reembedded_chunks).toBe(0);
    expect(client.embedCalls).toBe(embedsAfterIndex); // no extra embeds

    // Manifest.updated_at must NOT have been bumped on a no-op.
    const manifestAfter = await loadManifest("noop");
    expect(manifestAfter!.updated_at).toBe(manifestBefore!.updated_at);
  });

  it("changed file: sha256 differs → re-embedded, marked 'changed'", async () => {
    const p = await writeSource("a.md", "original content");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "ch", paths: [p], model: MODEL, client });
    const embedsAfterIndex = client.embedCalls;

    await writeFile(p, "completely new content now, longer too", "utf8");
    const report = await refreshCorpus({ name: "ch", model: MODEL, client });

    expect(report.no_op).toBe(false);
    expect(report.changed).toEqual([p]);
    expect(report.added).toEqual([]);
    expect(report.unchanged).toEqual([]);
    expect(report.reembedded_chunks).toBeGreaterThan(0);
    expect(client.embedCalls).toBeGreaterThan(embedsAfterIndex);
  });

  it("added path: manifest edited to include a new file → indexed and marked 'added'", async () => {
    const p1 = await writeSource("a.md", "alpha body");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "add", paths: [p1], model: MODEL, client });

    // Extend manifest to declare a second file, then create it on disk.
    const manifest = (await loadManifest("add"))!;
    const p2 = await writeSource("b.md", "bravo body here");
    await saveManifest({ ...manifest, paths: [...manifest.paths, p2] });

    const report = await refreshCorpus({ name: "add", model: MODEL, client });
    expect(report.no_op).toBe(false);
    expect(report.added).toEqual([p2]);
    expect(report.unchanged).toEqual([p1]);
    expect(report.deleted).toEqual([]);
  });

  it("deleted path: manifest drops a file → chunks removed, marked 'deleted'", async () => {
    const p1 = await writeSource("keep.md", "keep me");
    const p2 = await writeSource("drop.md", "drop me");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "del", paths: [p1, p2], model: MODEL, client });
    const corpusBefore = (await loadCorpus("del"))!;
    const chunksForP2 = corpusBefore.chunks.filter((c) => c.path === p2).length;
    expect(chunksForP2).toBeGreaterThan(0);

    // Edit manifest to remove p2.
    const manifest = (await loadManifest("del"))!;
    await saveManifest({ ...manifest, paths: [p1] });

    const report = await refreshCorpus({ name: "del", model: MODEL, client });
    expect(report.no_op).toBe(false);
    expect(report.deleted).toContain(p2);
    expect(report.missing).toEqual([]); // p2 is on disk; it's a manifest delete, not a disk-missing
    expect(report.dropped_chunks).toBe(chunksForP2);

    const corpusAfter = (await loadCorpus("del"))!;
    expect(corpusAfter.chunks.some((c) => c.path === p2)).toBe(false);
  });

  it("missing file: manifest keeps it, disk lost it → chunks removed, marked 'missing' AND 'deleted'", async () => {
    const p1 = await writeSource("stable.md", "stable");
    const p2 = await writeSource("vanishing.md", "vanishing");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "miss", paths: [p1, p2], model: MODEL, client });

    // File disappears from disk while still in the manifest.
    await unlink(p2);

    const report = await refreshCorpus({ name: "miss", model: MODEL, client });
    expect(report.no_op).toBe(false);
    expect(report.missing).toEqual([p2]);
    expect(report.deleted).toContain(p2);
    expect(report.unchanged).toEqual([p1]);

    const corpusAfter = (await loadCorpus("miss"))!;
    expect(corpusAfter.chunks.some((c) => c.path === p2)).toBe(false);
  });

  it("combined drift: added + changed + deleted + missing in one refresh", async () => {
    const pStable = await writeSource("stable.md", "i am stable");
    const pChanging = await writeSource("changing.md", "original");
    const pVanishing = await writeSource("vanishing.md", "will vanish");
    const pDropped = await writeSource("dropped.md", "will be removed from manifest");
    const client = new CountingEmbedMock();
    await indexCorpus({
      name: "combo",
      paths: [pStable, pChanging, pVanishing, pDropped],
      model: MODEL,
      client,
    });

    // Stage the four kinds of drift:
    //   changing.md   — content edited
    //   vanishing.md  — deleted from disk (still in manifest)
    //   dropped.md    — removed from manifest (still on disk)
    //   new.md        — created on disk AND added to manifest
    await writeFile(pChanging, "entirely new text in here", "utf8");
    await unlink(pVanishing);
    const pNew = await writeSource("new.md", "fresh addition");
    const manifest = (await loadManifest("combo"))!;
    await saveManifest({
      ...manifest,
      paths: [pStable, pChanging, pVanishing, pNew], // dropped.md removed; new.md added
    });

    const report = await refreshCorpus({ name: "combo", model: MODEL, client });
    expect(report.no_op).toBe(false);
    expect(report.unchanged).toEqual([pStable]);
    expect(report.changed).toEqual([pChanging]);
    expect(report.added).toEqual([pNew]);
    expect(report.missing).toEqual([pVanishing]);
    expect(report.deleted.sort()).toEqual([pDropped, pVanishing].sort());
  });

  it("refuses when no manifest exists", async () => {
    const client = new CountingEmbedMock();
    await expect(
      refreshCorpus({ name: "ghost", model: MODEL, client }),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(client.embedCalls).toBe(0);
  });

  it("refuses when active embed model differs from manifest", async () => {
    const p = await writeSource("a.md", "x");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "modelmix", paths: [p], model: MODEL, client });
    await expect(
      refreshCorpus({ name: "modelmix", model: "other-embed-model", client }),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("reports chunk-level counts alongside per-path lists", async () => {
    const p = await writeSource("a.md", "lorem ipsum ".repeat(100));
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "counts", paths: [p], model: MODEL, chunk_chars: 200, chunk_overlap: 20, client });
    const prior = (await loadCorpus("counts"))!;

    // Change the file so refresh must re-embed.
    await writeFile(p, "dolor sit amet ".repeat(100), "utf8");
    const report = await refreshCorpus({ name: "counts", model: MODEL, client });
    expect(report.reused_chunks).toBe(0);
    expect(report.reembedded_chunks).toBeGreaterThan(0);
    expect(report.dropped_chunks).toBe(prior.chunks.length);
    expect(report.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("no_op refresh reports existing chunk count as reused (so caller sees scale)", async () => {
    const p = await writeSource("a.md", "stable content about frogs".repeat(20));
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "reuse", paths: [p], model: MODEL, chunk_chars: 200, client });
    const prior = (await loadCorpus("reuse"))!;
    const report = await refreshCorpus({ name: "reuse", model: MODEL, client });
    expect(report.no_op).toBe(true);
    expect(report.reused_chunks).toBe(prior.chunks.length);
  });

  it("manifest file exists at the expected path after index", async () => {
    const p = await writeSource("a.md", "x");
    const client = new CountingEmbedMock();
    await indexCorpus({ name: "located", paths: [p], model: MODEL, client });
    const path = manifestPath("located");
    expect(existsSync(path)).toBe(true);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw).name).toBe("located");
  });
});
