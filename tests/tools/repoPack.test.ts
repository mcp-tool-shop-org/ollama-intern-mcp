/**
 * ollama_repo_pack tests — Pack Spine commit 2.
 *
 * Locks the onboarding-pack contract:
 *   - fixed pipeline: (corpus_search) → repo_brief → extract → artifact
 *   - narrow extract: onboarding schema is fixed, not caller-configurable
 *   - extract sees source_paths only — corpus stays doctrine-layer
 *   - artifact: deterministic markdown + JSON at known paths
 *   - response stays compact (paths + summary + steps)
 *   - weak brief propagates; unparseable extract degrades gracefully
 *   - corpus-first: when corpus is present, corpus_search step runs
 *   - markdown omits artifact_write (artifact can't narrate its own write)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRepoPack, __internal } from "../../src/tools/packs/repoPack.js";
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

class PipelineMock implements OllamaClient {
  public generateCalls: Array<{ tool: "brief" | "extract" | "other"; prompt: string }> = [];
  public embedCalls = 0;
  constructor(
    private readonly briefResponse: string,
    private readonly extractResponse: string,
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const prompt = req.prompt;
    let tool: "brief" | "extract" | "other";
    if (prompt.startsWith("You are producing a REPO ORIENTATION BRIEF")) tool = "brief";
    else if (prompt.startsWith("You are a structured extractor")) tool = "extract";
    else tool = "other";
    this.generateCalls.push({ tool, prompt });
    const response = tool === "brief" ? this.briefResponse : tool === "extract" ? this.extractResponse : "{}";
    return { model: req.model, response, done: true, prompt_eval_count: 90, eval_count: 35 };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
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

const BRIEF_OUT = JSON.stringify({
  repo_thesis: "FoundryOS orchestrates sprite production for JRPG pipelines.",
  key_surfaces: [
    { surface: "MCP tool spine", why: "138 tools drive the pipeline", evidence_refs: ["e1"] },
    { surface: "Godot export contract", why: "frozen interface to engine", evidence_refs: ["e1", "e2"] },
  ],
  architecture_shape: "Single MCP server with file-backed stores and a Godot export layer.",
  risk_areas: [{ risk: "schema drift between MCP and Godot", evidence_refs: ["e2"] }],
  read_next: [
    { file: "src/export.ts", why: "Godot export contract" },
    { file: "README.md", why: "orientation" },
  ],
});

const EXTRACT_OUT = JSON.stringify({
  package_names: ["@mcptoolshop/foundry"],
  entrypoints: [{ file: "src/index.ts", purpose: "MCP server entry" }],
  scripts: [
    { name: "build", command: "tsc" },
    { name: "test", command: "vitest run" },
  ],
  config_files: ["tsconfig.json", "package.json"],
  exposed_surfaces: ["MCP stdio", "CLI"],
  runtime_hints: ["Node 18+", "TypeScript ES2022"],
});

async function writeCorpus(
  name: string,
  modelVersion: string,
  chunks: Array<{ id: string; path: string; text: string }>,
): Promise<void> {
  const titles: Record<string, string | null> = {};
  for (const c of chunks) if (!(c.path in titles)) titles[c.path] = null;
  const corpus: CorpusFile = {
    schema_version: CORPUS_SCHEMA_VERSION,
    name,
    model_version: modelVersion,
    model_digest: null,
    indexed_at: "2026-04-17T00:00:00.000Z",
    chunk_chars: 800,
    chunk_overlap: 100,
    stats: {
      documents: new Set(chunks.map((c) => c.path)).size,
      chunks: chunks.length,
      total_chars: chunks.reduce((n, c) => n + c.text.length, 0),
    },
    titles,
    chunks: chunks.map((c) => ({
      id: c.id,
      path: c.path,
      file_hash: "sha256:test",
      file_mtime: "2026-04-17T00:00:00.000Z",
      chunk_index: 0,
      char_start: 0,
      char_end: c.text.length,
      text: c.text,
      vector: [1, 0, 0, 0],
      heading_path: [],
      chunk_type: "paragraph",
    })),
  };
  await saveCorpus(corpus);
}

const EMBED_MODEL = PROFILES["dev-rtx5080"].tiers.embed;

let tempArtifactDir: string;
let tempCorpusDir: string;
let tempSrcDir: string;
let origCorpusDir: string | undefined;

// Module-load snapshot — bulletproof restore even if beforeEach throws
// before its own snapshot line runs. (T001)
const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;

beforeEach(async () => {
  tempArtifactDir = await mkdtemp(join(tmpdir(), "intern-repopack-art-"));
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-repopack-corpus-"));
  tempSrcDir = await mkdtemp(join(tmpdir(), "intern-repopack-src-"));
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  process.env.INTERN_CORPUS_DIR = tempCorpusDir;
});

afterEach(async () => {
  const toRestore = origCorpusDir ?? MODULE_ORIG_CORPUS_DIR;
  try {
    if (toRestore === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = toRestore;
  } finally {
    await rm(tempArtifactDir, { recursive: true, force: true });
    await rm(tempCorpusDir, { recursive: true, force: true });
    await rm(tempSrcDir, { recursive: true, force: true });
  }
});

async function writeSources(files: Array<{ name: string; content: string }>): Promise<string[]> {
  const paths: string[] = [];
  for (const f of files) {
    const p = join(tempSrcDir, f.name);
    await writeFile(p, f.content, "utf8");
    paths.push(p);
  }
  return paths;
}

// ── Pipeline + artifact ─────────────────────────────────────

describe("handleRepoPack — fixed pipeline", () => {
  it("runs repo_brief then extract then writes both artifact files", async () => {
    const paths = await writeSources([
      { name: "README.md", content: "# FoundryOS\n\nGame production spine." },
      { name: "package.json", content: '{"name":"@mcptoolshop/foundry","scripts":{"build":"tsc"}}' },
    ]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, title: "FoundryOS", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );

    expect(client.generateCalls.map((c) => c.tool)).toEqual(["brief", "extract"]);
    const entries = await readdir(tempArtifactDir);
    expect(entries.filter((e) => e.endsWith(".md"))).toHaveLength(1);
    expect(entries.filter((e) => e.endsWith(".json"))).toHaveLength(1);
  });

  it("step trace lists corpus_search (when corpus), repo_brief, extract, artifact_write", async () => {
    await writeCorpus("handbook", EMBED_MODEL, [
      { id: "c-0", path: "/handbook/arch.md", text: "the repo uses a monorepo layout with MCP spine" },
    ]);
    const paths = await writeSources([{ name: "README.md", content: "short readme" }]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      {
        source_paths: paths,
        corpus: "handbook",
        corpus_query: "architecture",
        artifact_dir: tempArtifactDir,
      },
      makeCtx(client),
    );
    expect(env.result.steps.map((s) => s.tool)).toEqual([
      "ollama_corpus_search",
      "ollama_repo_brief",
      "ollama_extract",
      "artifact_write",
    ]);
    expect(env.result.summary.corpus_used).toEqual({ name: "handbook", chunks_used: 1 });
  });

  it("omits corpus_search step when no corpus is passed", async () => {
    const paths = await writeSources([{ name: "README.md", content: "short readme" }]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.steps.map((s) => s.tool)).toEqual([
      "ollama_repo_brief",
      "ollama_extract",
      "artifact_write",
    ]);
    expect(env.result.summary.corpus_used).toBeNull();
  });

  it("response is compact — no full brief or full facts dumped into envelope.result", async () => {
    const paths = await writeSources([{ name: "README.md", content: "readme" }]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const topKeys = Object.keys(env.result).sort();
    expect(topKeys).toEqual(["artifact", "steps", "summary"]);
    expect(env.result.summary.extracted_facts_present).toBe(true);
    expect(env.result.summary).not.toHaveProperty("brief");
    expect(env.result.summary).not.toHaveProperty("extracted_facts");
  });

  it("summary counts match the brief", async () => {
    // Two source paths → 2 evidence items → past repo_brief's weak threshold.
    const paths = await writeSources([
      { name: "README.md", content: "readme" },
      { name: "package.json", content: '{"name":"x"}' },
    ]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.summary.key_surfaces_count).toBe(2);
    expect(env.result.summary.risk_areas_count).toBe(1);
    expect(env.result.summary.read_next_count).toBe(2);
    expect(env.result.summary.weak).toBe(false);
  });
});

describe("handleRepoPack — extract is narrow and fixed", () => {
  it("the onboarding extract schema is the FIXED shape, not caller-configurable", () => {
    const schema = __internal.ONBOARDING_EXTRACT_SCHEMA;
    const keys = Object.keys(schema.properties).sort();
    expect(keys).toEqual([
      "config_files",
      "entrypoints",
      "exposed_surfaces",
      "package_names",
      "runtime_hints",
      "scripts",
    ]);
  });

  it("extract sees source_paths only, not corpus chunks", async () => {
    await writeCorpus("doctrine", EMBED_MODEL, [
      { id: "c-0", path: "/doctrine/ARCH_CANARY.md", text: "DOCTRINE_CORPUS_SECRET_12345 layout" },
    ]);
    const paths = await writeSources([
      { name: "README.md", content: "SRC_PATH_CANARY entrypoint lives at src/index.ts" },
    ]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    await handleRepoPack(
      {
        source_paths: paths,
        corpus: "doctrine",
        corpus_query: "layout",
        artifact_dir: tempArtifactDir,
      },
      makeCtx(client),
    );
    // Find the extract prompt and verify it contains the source_path content
    // but NOT the corpus chunk content.
    const extractCall = client.generateCalls.find((c) => c.tool === "extract");
    expect(extractCall).toBeDefined();
    expect(extractCall!.prompt).toContain("SRC_PATH_CANARY");
    expect(extractCall!.prompt).not.toContain("DOCTRINE_CORPUS_SECRET_12345");
  });

  it("unparseable extract degrades gracefully — pack still completes with no facts", async () => {
    const paths = await writeSources([{ name: "README.md", content: "readme" }]);
    const client = new PipelineMock(BRIEF_OUT, "this is not JSON at all");
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.summary.extracted_facts_present).toBe(false);
    // Pack still wrote artifacts.
    const entries = await readdir(tempArtifactDir);
    expect(entries.some((e) => e.endsWith(".md"))).toBe(true);
    // Extract step shows ok: false.
    const extractStep = env.result.steps.find((s) => s.tool === "ollama_extract");
    expect(extractStep?.ok).toBe(false);
  });
});

describe("handleRepoPack — markdown layout", () => {
  it("markdown contains all 9 fixed sections in order", async () => {
    const paths = await writeSources([{ name: "README.md", content: "readme" }]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, title: "FoundryOS", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    const sections = [
      "# Repo — FoundryOS",
      "## Thesis",
      "## Key surfaces",
      "## Architecture shape",
      "## Risk areas",
      "## Read next",
      "## Extracted facts",
      "## Evidence",
      "## Coverage notes",
      "## Step trace",
    ];
    let cursor = 0;
    for (const s of sections) {
      const idx = md.indexOf(s, cursor);
      expect(idx, `missing or out of order: ${s}`).toBeGreaterThan(-1);
      cursor = idx;
    }
  });

  it("markdown renders extracted facts as operator-friendly blocks", async () => {
    const paths = await writeSources([{ name: "README.md", content: "readme" }]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toContain("**Packages:** `@mcptoolshop/foundry`");
    expect(md).toContain("**Exposed surfaces:** MCP stdio, CLI");
    expect(md).toContain("**Entrypoints:**");
    expect(md).toContain("`src/index.ts`");
    expect(md).toContain("**Scripts:**");
    expect(md).toContain("`build`");
    expect(md).toContain("**Config files:** `tsconfig.json`, `package.json`");
    expect(md).toContain("**Runtime hints:** Node 18+, TypeScript ES2022");
  });

  it("markdown shows weak banner when brief.weak is true", async () => {
    const paths = await writeSources([{ name: "README.md", content: "r" }]);
    const weakBrief = JSON.stringify({
      repo_thesis: "",
      key_surfaces: [],
      architecture_shape: "",
      risk_areas: [],
      read_next: [],
    });
    const client = new PipelineMock(weakBrief, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toMatch(/Weak brief/);
    expect(env.result.summary.weak).toBe(true);
  });

  it("markdown trace lists only tools that ran before the write — artifact_write stays implicit", async () => {
    const paths = await writeSources([{ name: "README.md", content: "r" }]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toMatch(/`ollama_repo_brief`/);
    expect(md).toMatch(/`ollama_extract`/);
    expect(md).not.toMatch(/`artifact_write`/);
    // MCP response trace DOES include artifact_write.
    expect(env.result.steps.map((s) => s.tool)).toContain("artifact_write");
  });
});

describe("handleRepoPack — JSON artifact", () => {
  it("JSON carries brief + extracted_facts + steps + paths", async () => {
    const paths = await writeSources([{ name: "README.md", content: "r" }]);
    const client = new PipelineMock(BRIEF_OUT, EXTRACT_OUT);
    const env = await handleRepoPack(
      { source_paths: paths, title: "T", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const raw = await readFile(env.result.artifact.json_path, "utf8");
    const obj = JSON.parse(raw);
    expect(obj.schema_version).toBe(1);
    expect(obj.pack).toBe("repo_pack");
    expect(obj.brief.key_surfaces).toHaveLength(2);
    expect(obj.extracted_facts.package_names).toEqual(["@mcptoolshop/foundry"]);
    expect(obj.steps.length).toBeGreaterThan(0);
    expect(obj.artifact.markdown_path).toBe(env.result.artifact.markdown_path);
    expect(obj.artifact.json_path).toBe(env.result.artifact.json_path);
  });

  it("JSON extracted_facts is null when extract failed", async () => {
    const paths = await writeSources([{ name: "README.md", content: "r" }]);
    const client = new PipelineMock(BRIEF_OUT, "not json");
    const env = await handleRepoPack(
      { source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const obj = JSON.parse(await readFile(env.result.artifact.json_path, "utf8"));
    expect(obj.extracted_facts).toBeNull();
  });
});

describe("buildSlug", () => {
  const WHEN = new Date("2026-04-17T14:52:00Z");

  it("prefers title over thesis head", () => {
    const slug = __internal.buildSlug({
      title: "FoundryOS",
      thesisHead: "A different sentence",
      when: WHEN,
    });
    expect(slug).toMatch(/foundryos$/);
  });

  it("falls back to thesis head when no title", () => {
    const slug = __internal.buildSlug({
      thesisHead: "Monorepo coordinating many services",
      when: WHEN,
    });
    expect(slug).toMatch(/monorepo-coordinating-many-services/);
  });

  it("timestamp-only when both missing", () => {
    const slug = __internal.buildSlug({ when: WHEN });
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
  });
});
