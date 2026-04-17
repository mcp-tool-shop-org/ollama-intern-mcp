/**
 * ollama_repo_brief + ollama_change_brief tests — Workflow Spine D.
 *
 * Both briefs inherit the structured-evidence contract from
 * incident_brief (see src/tools/briefs/). These tests lock the
 * per-tool specifics:
 *
 *   repo_brief
 *     - output shape: repo_thesis / key_surfaces / architecture_shape /
 *       risk_areas / read_next / evidence / weak / coverage_notes /
 *       corpus_used
 *     - requires source_paths
 *     - caps enforced (key_surfaces, risk_areas, read_next)
 *     - evidence refs validated against the evidence list
 *     - weak when thesis empty OR surfaces+architecture both empty
 *     - prompt forbids prescriptive remediation in read_next
 *
 *   change_brief
 *     - output shape: change_summary / affected_surfaces / why_it_matters /
 *       likely_breakpoints / validation_checks / release_note_draft /
 *       evidence / weak / coverage_notes / corpus_used
 *     - accepts diff_text and/or source_paths (at least one)
 *     - diff split per file on `diff --git` markers; no markers → one blob
 *     - caps enforced (breakpoints, validation_checks)
 *     - evidence refs validated
 *     - prompt forbids remediations on breakpoints/checks
 *     - release_note_draft preserved as free text
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRepoBrief } from "../../src/tools/repoBrief.js";
import { handleChangeBrief } from "../../src/tools/changeBrief.js";
import { saveCorpus, CORPUS_SCHEMA_VERSION, type CorpusFile } from "../../src/corpus/storage.js";
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

// ── Helpers ─────────────────────────────────────────────────

class ProgrammableClient implements OllamaClient {
  public lastPrompt?: string;
  public generateCalls = 0;
  public embedCalls = 0;
  constructor(private readonly generateResponse: string) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.generateCalls += 1;
    this.lastPrompt = req.prompt;
    return { model: req.model, response: this.generateResponse, done: true, prompt_eval_count: 100, eval_count: 50 };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: req.model, embeddings: inputs.map(() => [1, 0, 0, 0]) };
  }
  async residency(_m: string): Promise<Residency | null> {
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

async function writeCorpus(
  name: string,
  modelVersion: string,
  chunks: Array<{ id: string; path: string; text: string }>,
): Promise<void> {
  const titles: Record<string, string | null> = {};
  for (const c of chunks) if (!(c.path in titles)) titles[c.path] = null;
  const corpus: CorpusFile = {
    schema_version: CORPUS_SCHEMA_VERSION,
    name, model_version: modelVersion, model_digest: null,
    indexed_at: "2026-04-17T00:00:00.000Z",
    chunk_chars: 800, chunk_overlap: 100,
    stats: { documents: new Set(chunks.map(c => c.path)).size, chunks: chunks.length, total_chars: chunks.reduce((n, c) => n + c.text.length, 0) },
    titles,
    chunks: chunks.map(c => ({
      id: c.id, path: c.path, file_hash: "sha256:test", file_mtime: "2026-04-17T00:00:00.000Z",
      chunk_index: 0, char_start: 0, char_end: c.text.length, text: c.text,
      vector: [1, 0, 0, 0], heading_path: [], chunk_type: "paragraph",
    })),
  };
  await saveCorpus(corpus);
}

const EMBED_MODEL = PROFILES["dev-rtx5080"].tiers.embed;

let tempDir: string;
let origCorpusDir: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-briefs-d-"));
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  process.env.INTERN_CORPUS_DIR = tempDir;
});

afterEach(async () => {
  if (origCorpusDir === undefined) delete process.env.INTERN_CORPUS_DIR;
  else process.env.INTERN_CORPUS_DIR = origCorpusDir;
  await rm(tempDir, { recursive: true, force: true });
});

// ── repo_brief ──────────────────────────────────────────────

describe("handleRepoBrief — shape + grounding", () => {
  it("returns the operator-map shape with evidence-backed fields", async () => {
    const readme = join(tempDir, "README.md");
    await writeFile(readme, "# FoundryOS\n\nGame production spine for JRPG sprite pipelines.", "utf8");
    const pkg = join(tempDir, "package.json");
    await writeFile(pkg, '{"name":"foundry","scripts":{"build":"tsc"}}', "utf8");
    const modelOut = JSON.stringify({
      repo_thesis: "FoundryOS coordinates sprite production for JRPG pipelines.",
      key_surfaces: [
        { surface: "MCP tool spine", why: "138 tools drive the pipeline", evidence_refs: ["e1"] },
      ],
      architecture_shape: "Single MCP server, file-backed stores, a Godot export contract.",
      risk_areas: [
        { risk: "schema drift between MCP and Godot", evidence_refs: ["e2"] },
      ],
      read_next: [
        { file: "src/export.ts", why: "inspect the Godot export contract" },
      ],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleRepoBrief({ source_paths: [readme, pkg] }, makeCtx(client));
    expect(env.result.repo_thesis).toContain("FoundryOS");
    expect(env.result.key_surfaces).toHaveLength(1);
    expect(env.result.key_surfaces[0].evidence_refs).toEqual(["e1"]);
    expect(env.result.risk_areas[0].evidence_refs).toEqual(["e2"]);
    expect(env.result.architecture_shape.length).toBeGreaterThan(0);
    expect(env.result.read_next).toHaveLength(1);
    expect(env.result.evidence.length).toBeGreaterThanOrEqual(2);
    expect(env.result.weak).toBe(false);
  });

  it("strips evidence_refs that don't match any evidence id", async () => {
    const p = join(tempDir, "a.md");
    await writeFile(p, "tiny", "utf8");
    const modelOut = JSON.stringify({
      repo_thesis: "T",
      key_surfaces: [{ surface: "S", why: "W", evidence_refs: ["e1", "e99", "fabricated"] }],
      architecture_shape: "A",
      risk_areas: [{ risk: "R", evidence_refs: ["e42"] }],
      read_next: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleRepoBrief({ source_paths: [p] }, makeCtx(client));
    expect(env.result.key_surfaces[0].evidence_refs).toEqual(["e1"]);
    expect(env.result.risk_areas[0].evidence_refs).toEqual([]);
    expect(env.result.coverage_notes.some((n) => n.includes("Stripped"))).toBe(true);
    expect(env.warnings?.some((w) => w.includes("Stripped"))).toBe(true);
  });

  it("caps key_surfaces / risk_areas / read_next at configured limits", async () => {
    const p = join(tempDir, "a.md");
    await writeFile(p, "body", "utf8");
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    const modelOut = JSON.stringify({
      repo_thesis: "T",
      key_surfaces: many(20, (i) => ({ surface: `S${i}`, why: "W", evidence_refs: ["e1"] })),
      architecture_shape: "A",
      risk_areas: many(10, (i) => ({ risk: `R${i}`, evidence_refs: ["e1"] })),
      read_next: many(15, (i) => ({ file: `f${i}.ts`, why: "w" })),
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleRepoBrief(
      { source_paths: [p], max_key_surfaces: 3, max_risk_areas: 2, max_read_next: 4 },
      makeCtx(client),
    );
    expect(env.result.key_surfaces).toHaveLength(3);
    expect(env.result.risk_areas).toHaveLength(2);
    expect(env.result.read_next).toHaveLength(4);
  });

  it("weak=true when thesis is empty or surfaces+architecture both missing", async () => {
    const p = join(tempDir, "a.md");
    await writeFile(p, "body", "utf8");
    const modelOut = JSON.stringify({
      repo_thesis: "",
      key_surfaces: [],
      architecture_shape: "",
      risk_areas: [],
      read_next: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleRepoBrief({ source_paths: [p] }, makeCtx(client));
    expect(env.result.weak).toBe(true);
    expect(env.result.coverage_notes.some((n) => n.includes("repo_thesis"))).toBe(true);
  });

  it("prompt forbids prescriptive fixes in read_next", async () => {
    const p = join(tempDir, "a.md");
    await writeFile(p, "body", "utf8");
    const client = new ProgrammableClient("{}");
    await handleRepoBrief({ source_paths: [p] }, makeCtx(client));
    const prompt = client.lastPrompt ?? "";
    expect(prompt).toMatch(/read_next is INVESTIGATIVE/);
    expect(prompt).toMatch(/Never prescriptive fixes/);
    expect(prompt).toMatch(/Do not propose code changes/);
  });

  it("includes corpus chunks as evidence when a corpus is supplied", async () => {
    await writeCorpus("handbook", EMBED_MODEL, [
      { id: "c-0", path: "/handbook/layout.md", text: "the repo follows a monorepo layout" },
    ]);
    const p = join(tempDir, "README.md");
    await writeFile(p, "short readme", "utf8");
    const modelOut = JSON.stringify({
      repo_thesis: "T", key_surfaces: [], architecture_shape: "A",
      risk_areas: [], read_next: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleRepoBrief(
      { source_paths: [p], corpus: "handbook", corpus_query: "layout" },
      makeCtx(client),
    );
    expect(env.result.corpus_used).toEqual({ name: "handbook", chunks_used: 1 });
    expect(env.result.evidence.some((e) => e.kind === "corpus")).toBe(true);
  });
});

// ── change_brief ────────────────────────────────────────────

describe("handleChangeBrief — shape + grounding", () => {
  it("rejects calls with neither diff_text nor source_paths", async () => {
    const client = new ProgrammableClient("{}");
    await expect(
      handleChangeBrief({}, makeCtx(client)),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(client.generateCalls).toBe(0);
  });

  it("splits diff_text per file on `diff --git` markers", async () => {
    const diff = [
      `diff --git a/src/foo.ts b/src/foo.ts`,
      `index abcd..efgh 100644`,
      `--- a/src/foo.ts`,
      `+++ b/src/foo.ts`,
      `@@ -1,3 +1,3 @@`,
      `-old foo`,
      `+new foo`,
      ``,
      `diff --git a/src/bar.ts b/src/bar.ts`,
      `index 1111..2222 100644`,
      `--- a/src/bar.ts`,
      `+++ b/src/bar.ts`,
      `@@ -1,1 +1,1 @@`,
      `-old bar`,
      `+new bar`,
    ].join("\n");
    const modelOut = JSON.stringify({
      change_summary: "renamed two constants",
      affected_surfaces: [{ surface: "foo module", evidence_refs: ["e1"] }],
      why_it_matters: "consumers of foo rebroadcast",
      likely_breakpoints: [{ breakpoint: "foo consumers", evidence_refs: ["e1"] }],
      validation_checks: [{ check: "run foo tests", why: "they exercise the rename" }],
      release_note_draft: "Renamed foo and bar.",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief({ diff_text: diff }, makeCtx(client));
    const diffEv = env.result.evidence.filter((e) => e.kind === "diff");
    expect(diffEv).toHaveLength(2);
    expect(diffEv[0].ref).toBe("diff:src/foo.ts");
    expect(diffEv[1].ref).toBe("diff:src/bar.ts");
  });

  it("treats diff without `diff --git` markers as a single evidence blob", async () => {
    const diff = "+ added line\n- removed line\n  context line\n";
    const modelOut = JSON.stringify({
      change_summary: "S", affected_surfaces: [{ surface: "X", evidence_refs: ["e1"] }],
      why_it_matters: "W", likely_breakpoints: [], validation_checks: [], release_note_draft: "N",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief({ diff_text: diff }, makeCtx(client));
    const diffEv = env.result.evidence.filter((e) => e.kind === "diff");
    expect(diffEv).toHaveLength(1);
    expect(diffEv[0].ref).toBe("diff");
  });

  it("returns the impact-brief shape with release_note_draft preserved", async () => {
    const diff = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n-old\n+new\n`;
    const modelOut = JSON.stringify({
      change_summary: "Flipped x default.",
      affected_surfaces: [{ surface: "x config", evidence_refs: ["e1"] }],
      why_it_matters: "Default now favors safety.",
      likely_breakpoints: [{ breakpoint: "callers relying on old default", evidence_refs: ["e1"] }],
      validation_checks: [{ check: "re-run config suite", why: "verifies default" }],
      release_note_draft: "x now defaults to safe mode.",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief({ diff_text: diff }, makeCtx(client));
    expect(env.result.change_summary).toContain("Flipped");
    expect(env.result.affected_surfaces).toHaveLength(1);
    expect(env.result.likely_breakpoints).toHaveLength(1);
    expect(env.result.validation_checks).toHaveLength(1);
    expect(env.result.release_note_draft).toBe("x now defaults to safe mode.");
    expect(env.result.weak).toBe(false);
  });

  it("strips evidence_refs on affected_surfaces + likely_breakpoints", async () => {
    const diff = `diff --git a/x b/x\n@@\n+x\n`;
    const modelOut = JSON.stringify({
      change_summary: "S",
      affected_surfaces: [{ surface: "A", evidence_refs: ["e1", "e7", "fake"] }],
      why_it_matters: "W",
      likely_breakpoints: [{ breakpoint: "B", evidence_refs: ["e99"] }],
      validation_checks: [], release_note_draft: "N",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief({ diff_text: diff }, makeCtx(client));
    expect(env.result.affected_surfaces[0].evidence_refs).toEqual(["e1"]);
    expect(env.result.likely_breakpoints[0].evidence_refs).toEqual([]);
    expect(env.warnings?.some((w) => w.includes("Stripped"))).toBe(true);
  });

  it("caps likely_breakpoints and validation_checks", async () => {
    const diff = `diff --git a/x b/x\n@@\n+x\n`;
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    const modelOut = JSON.stringify({
      change_summary: "S", affected_surfaces: [],
      why_it_matters: "W",
      likely_breakpoints: many(20, (i) => ({ breakpoint: `B${i}`, evidence_refs: ["e1"] })),
      validation_checks: many(20, (i) => ({ check: `C${i}`, why: "y" })),
      release_note_draft: "N",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief(
      { diff_text: diff, max_breakpoints: 3, max_validation_checks: 4 },
      makeCtx(client),
    );
    expect(env.result.likely_breakpoints).toHaveLength(3);
    expect(env.result.validation_checks).toHaveLength(4);
  });

  it("weak=true when change_summary is empty or no affected_surfaces", async () => {
    const diff = `diff --git a/x b/x\n@@\n+x\n`;
    const modelOut = JSON.stringify({
      change_summary: "",
      affected_surfaces: [],
      why_it_matters: "",
      likely_breakpoints: [], validation_checks: [], release_note_draft: "",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief({ diff_text: diff }, makeCtx(client));
    expect(env.result.weak).toBe(true);
    expect(env.result.coverage_notes.some((n) => n.includes("change_summary"))).toBe(true);
    expect(env.result.coverage_notes.some((n) => n.includes("affected_surfaces"))).toBe(true);
  });

  it("prompt forbids remediation on breakpoints/checks", async () => {
    const diff = `diff --git a/x b/x\n@@\n+x\n`;
    const client = new ProgrammableClient("{}");
    await handleChangeBrief({ diff_text: diff }, makeCtx(client));
    const prompt = client.lastPrompt ?? "";
    expect(prompt).toMatch(/likely_breakpoints are INVESTIGATIVE/);
    expect(prompt).toMatch(/never "apply this fix"/);
    expect(prompt).toMatch(/Never code changes/);
    expect(prompt).toMatch(/release_note_draft is a DRAFT/);
  });

  it("source_paths alone works when no diff is available", async () => {
    const p = join(tempDir, "changed.ts");
    await writeFile(p, "export const x = 1;", "utf8");
    const modelOut = JSON.stringify({
      change_summary: "added x",
      affected_surfaces: [{ surface: "module", evidence_refs: ["e1"] }],
      why_it_matters: "first export",
      likely_breakpoints: [], validation_checks: [], release_note_draft: "New export x.",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief({ source_paths: [p] }, makeCtx(client));
    expect(env.result.change_summary).toContain("added x");
    expect(env.result.evidence.some((e) => e.kind === "path")).toBe(true);
    expect(env.result.weak).toBe(false);
  });

  it("corpus_used populated when corpus is passed and returns chunks", async () => {
    await writeCorpus("doctrine", EMBED_MODEL, [
      { id: "c-0", path: "/doctrine/safety.md", text: "defaults must favor safety" },
    ]);
    const diff = `diff --git a/x b/x\n@@\n+x\n`;
    const modelOut = JSON.stringify({
      change_summary: "S", affected_surfaces: [], why_it_matters: "W",
      likely_breakpoints: [], validation_checks: [], release_note_draft: "N",
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleChangeBrief(
      { diff_text: diff, corpus: "doctrine", corpus_query: "safety defaults" },
      makeCtx(client),
    );
    expect(env.result.corpus_used).toEqual({ name: "doctrine", chunks_used: 1 });
  });
});
