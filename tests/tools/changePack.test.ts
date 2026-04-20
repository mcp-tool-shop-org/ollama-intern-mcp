/**
 * ollama_change_pack tests — Pack Spine commit 3.
 *
 * Locks the change-review pack contract:
 *   - fixed pipeline: (corpus_search) → (triage_logs if log_text) →
 *                     change_brief → extract → artifact_write
 *   - change-first: no repo-tour bleed, corpus is opt-in
 *   - triage_logs ONLY runs when log_text is provided
 *   - narrow extract schema: scripts_touched, config_surfaces,
 *     runtime_hints (fixed, not caller-configurable)
 *   - extract sees source_paths (or diff as fallback), not corpus
 *   - release_note_draft renders as a blockquote + DRAFT caveat
 *   - response is compact (paths + summary + steps)
 *   - artifact: deterministic markdown + JSON at known paths
 *   - markdown omits artifact_write (can't narrate its own write)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleChangePack, __internal } from "../../src/tools/packs/changePack.js";
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
  public generateCalls: Array<{ tool: "triage" | "brief" | "extract" | "other"; prompt: string }> = [];
  public embedCalls = 0;
  constructor(
    private readonly triageResponse: string,
    private readonly briefResponse: string,
    private readonly extractResponse: string,
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const prompt = req.prompt;
    let tool: "triage" | "brief" | "extract" | "other";
    if (prompt.startsWith("You are a log triage")) tool = "triage";
    else if (prompt.startsWith("You are producing a CHANGE IMPACT BRIEF")) tool = "brief";
    else if (prompt.startsWith("You are a structured extractor")) tool = "extract";
    else tool = "other";
    this.generateCalls.push({ tool, prompt });
    const response =
      tool === "triage" ? this.triageResponse :
      tool === "brief" ? this.briefResponse :
      tool === "extract" ? this.extractResponse :
      "{}";
    return { model: req.model, response, done: true, prompt_eval_count: 90, eval_count: 40 };
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

const TRIAGE_OUT = JSON.stringify({
  errors: ["ERROR: null deref in AuthMiddleware", "ERROR: session unreadable"],
  warnings: ["WARN: cache miss"],
  suspected_root_cause: "null check missing in AuthMiddleware",
});

const BRIEF_OUT = JSON.stringify({
  change_summary: "Flipped default for auth session to signed tokens.",
  affected_surfaces: [
    { surface: "AuthMiddleware", evidence_refs: ["e1"] },
    { surface: "session storage", evidence_refs: ["e1"] },
  ],
  why_it_matters: "Signed tokens close a replay vector called out by legal.",
  likely_breakpoints: [
    { breakpoint: "callers that pass old-format session tokens", evidence_refs: ["e1"] },
  ],
  validation_checks: [
    { check: "run auth integration suite", why: "exercises the signed-token path" },
    { check: "inspect session storage format in dev DB", why: "verify migration landed" },
  ],
  release_note_draft: "Session tokens now signed by default.\nOld-format tokens remain valid through 2026-05-01.",
});

const EXTRACT_OUT = JSON.stringify({
  scripts_touched: ["auth:migrate"],
  config_surfaces: ["auth.config.ts"],
  runtime_hints: ["Node 20+"],
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
    name, model_version: modelVersion, model_digest: null,
    indexed_at: "2026-04-17T00:00:00.000Z",
    chunk_chars: 800, chunk_overlap: 100,
    stats: { documents: new Set(chunks.map((c) => c.path)).size, chunks: chunks.length, total_chars: chunks.reduce((n, c) => n + c.text.length, 0) },
    titles,
    chunks: chunks.map((c) => ({
      id: c.id, path: c.path, file_hash: "sha256:test", file_mtime: "2026-04-17T00:00:00.000Z",
      chunk_index: 0, char_start: 0, char_end: c.text.length, text: c.text,
      vector: [1, 0, 0, 0], heading_path: [], chunk_type: "paragraph",
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
  tempArtifactDir = await mkdtemp(join(tmpdir(), "intern-changepack-art-"));
  tempCorpusDir = await mkdtemp(join(tmpdir(), "intern-changepack-corpus-"));
  tempSrcDir = await mkdtemp(join(tmpdir(), "intern-changepack-src-"));
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

const SIMPLE_DIFF = [
  `diff --git a/src/auth.ts b/src/auth.ts`,
  `--- a/src/auth.ts`,
  `+++ b/src/auth.ts`,
  `@@ -1,3 +1,4 @@`,
  `-const signed = false;`,
  `+const signed = true;`,
  `+// signed tokens now default`,
].join("\n");

// ── Input contract ──────────────────────────────────────────

describe("handleChangePack — input contract", () => {
  it("rejects calls with neither diff_text nor source_paths", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    await expect(
      handleChangePack({ artifact_dir: tempArtifactDir }, makeCtx(client)),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(client.generateCalls).toHaveLength(0);
  });

  it("accepts diff_text only (no source_paths, no log_text, no corpus)", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    // Pipeline without triage: brief + extract.
    expect(client.generateCalls.map((c) => c.tool)).toEqual(["brief", "extract"]);
    expect(env.result.summary.triage_ran).toBe(false);
  });

  it("accepts empty source_paths when diff_text is provided", async () => {
    // Regression — local-LLM callers (hermes3:8b) emit `source_paths: []` on
    // diff-driven change calls. Empty array passes schema; runtime still
    // enforces "at least one of diff_text or source_paths".
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, source_paths: [], artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(client.generateCalls.map((c) => c.tool)).toEqual(["brief", "extract"]);
    expect(env.result.summary.triage_ran).toBe(false);
  });
});

// ── Pipeline + step trace ───────────────────────────────────

describe("handleChangePack — fixed pipeline", () => {
  it("triage runs ONLY when log_text is provided", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, log_text: "ERROR: null deref in AuthMiddleware", title: "T", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(client.generateCalls.map((c) => c.tool)).toEqual(["triage", "brief", "extract"]);
    expect(env.result.summary.triage_ran).toBe(true);
    // Step trace order: triage → brief → extract → artifact_write
    expect(env.result.steps.map((s) => s.tool)).toEqual([
      "ollama_triage_logs",
      "ollama_change_brief",
      "ollama_extract",
      "artifact_write",
    ]);
  });

  it("corpus_search step appears only when a corpus is queried", async () => {
    await writeCorpus("doctrine", EMBED_MODEL, [
      { id: "c-0", path: "/doctrine/auth.md", text: "signed tokens must be validated before use" },
    ]);
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      {
        diff_text: SIMPLE_DIFF,
        corpus: "doctrine",
        corpus_query: "signed tokens",
        artifact_dir: tempArtifactDir,
      },
      makeCtx(client),
    );
    expect(env.result.steps.map((s) => s.tool)).toEqual([
      "ollama_corpus_search",
      "ollama_change_brief",
      "ollama_extract",
      "artifact_write",
    ]);
    expect(env.result.summary.corpus_used).toEqual({ name: "doctrine", chunks_used: 1 });
  });

  it("response stays compact — no full brief dumped into envelope.result", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(Object.keys(env.result).sort()).toEqual(["artifact", "steps", "summary"]);
    expect(env.result.summary).not.toHaveProperty("brief");
    expect(env.result.summary).not.toHaveProperty("release_note_draft");
    expect(env.result.summary).not.toHaveProperty("extracted_facts");
  });

  it("summary counts reflect the brief", async () => {
    const paths = await writeSources([
      { name: "auth.ts", content: "const signed = true;" },
      { name: "session.ts", content: "export const ttl = 3600;" },
    ]);
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, source_paths: paths, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.summary.affected_surfaces_count).toBe(2);
    expect(env.result.summary.likely_breakpoints_count).toBe(1);
    expect(env.result.summary.validation_checks_count).toBe(2);
    expect(env.result.summary.release_note_present).toBe(true);
    expect(env.result.summary.extracted_facts_present).toBe(true);
    expect(env.result.summary.weak).toBe(false);
  });
});

// ── Narrow extract ──────────────────────────────────────────

describe("handleChangePack — extract is narrow and fixed", () => {
  it("the change-review extract schema is the FIXED shape, not caller-configurable", () => {
    const schema = __internal.CHANGE_EXTRACT_SCHEMA;
    const keys = Object.keys(schema.properties).sort();
    expect(keys).toEqual(["config_surfaces", "runtime_hints", "scripts_touched"]);
  });

  it("extract sees source_paths when present; corpus content stays out", async () => {
    await writeCorpus("doctrine", EMBED_MODEL, [
      { id: "c-0", path: "/doctrine/CORPUS_CANARY.md", text: "DOCTRINE_SECRET_CANARY signed tokens matter" },
    ]);
    const paths = await writeSources([
      { name: "auth.ts", content: "SOURCE_CANARY signed tokens enabled by default" },
    ]);
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    await handleChangePack(
      {
        source_paths: paths,
        corpus: "doctrine",
        corpus_query: "signed tokens",
        artifact_dir: tempArtifactDir,
      },
      makeCtx(client),
    );
    const extractCall = client.generateCalls.find((c) => c.tool === "extract")!;
    expect(extractCall.prompt).toContain("SOURCE_CANARY");
    expect(extractCall.prompt).not.toContain("DOCTRINE_SECRET_CANARY");
  });

  it("when only diff_text is provided, extract runs over the diff", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const extractCall = client.generateCalls.find((c) => c.tool === "extract")!;
    expect(extractCall.prompt).toContain("const signed = true;");
  });

  it("unparseable extract degrades gracefully — pack still completes", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, "not JSON");
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.summary.extracted_facts_present).toBe(false);
    const extractStep = env.result.steps.find((s) => s.tool === "ollama_extract");
    expect(extractStep?.ok).toBe(false);
    // Artifacts still written.
    const entries = await readdir(tempArtifactDir);
    expect(entries.some((e) => e.endsWith(".md"))).toBe(true);
  });
});

// ── Markdown layout ─────────────────────────────────────────

describe("handleChangePack — markdown layout", () => {
  it("markdown has all 10 fixed sections in order", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, log_text: "ERROR: X", title: "Auth default flip", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    const sections = [
      "# Change — Auth default flip",
      "## Change",
      "## Summary",
      "## Affected surfaces",
      "## Why it matters",
      "## Likely breakpoints",
      "## Validation checks",
      "## Release note draft",
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

  it("Change section surfaces CI signal when log_text was provided", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, log_text: "ERROR: X", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toContain("2 errors, 1 warning in the CI log.");
    expect(md).toContain("null check missing in AuthMiddleware");
  });

  it("Change section notes absence when no log_text was provided", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toContain("No CI log was provided; triage step skipped.");
  });

  it("Summary section includes extracted facts as inline bullets", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toContain("**Scripts touched:** `auth:migrate`");
    expect(md).toContain("**Config surfaces:** `auth.config.ts`");
    expect(md).toContain("**Runtime hints:** Node 20+");
  });

  it("Release note draft renders as blockquote with DRAFT caveat", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toMatch(/^> Session tokens now signed by default\.$/m);
    expect(md).toMatch(/^> Old-format tokens remain valid through 2026-05-01\.$/m);
    expect(md).toContain("_Draft — the operator reviews before publishing._");
  });

  it("markdown step trace omits artifact_write (self-narration avoided)", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toMatch(/`ollama_change_brief`/);
    expect(md).toMatch(/`ollama_extract`/);
    expect(md).not.toMatch(/`artifact_write`/);
    // MCP response trace DOES include artifact_write.
    expect(env.result.steps.map((s) => s.tool)).toContain("artifact_write");
  });
});

// ── JSON artifact ───────────────────────────────────────────

describe("handleChangePack — JSON artifact", () => {
  it("JSON carries triage (or null), brief, extracted_facts, steps, paths", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, log_text: "ERROR: X", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const obj = JSON.parse(await readFile(env.result.artifact.json_path, "utf8"));
    expect(obj.schema_version).toBe(1);
    expect(obj.pack).toBe("change_pack");
    expect(obj.triage.errors).toHaveLength(2);
    expect(obj.brief.affected_surfaces).toHaveLength(2);
    expect(obj.extracted_facts.scripts_touched).toEqual(["auth:migrate"]);
    expect(obj.artifact.markdown_path).toBe(env.result.artifact.markdown_path);
    expect(obj.input.has_diff_text).toBe(true);
    expect(obj.input.has_log_text).toBe(true);
    // Raw diff / log never echoed back.
    expect(obj.input).not.toHaveProperty("diff_text");
    expect(obj.input).not.toHaveProperty("log_text");
  });

  it("JSON triage is null when no log_text was provided", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, EXTRACT_OUT);
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const obj = JSON.parse(await readFile(env.result.artifact.json_path, "utf8"));
    expect(obj.triage).toBeNull();
    expect(obj.input.has_log_text).toBe(false);
  });

  it("JSON extracted_facts is null when extract failed", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT, "not json");
    const env = await handleChangePack(
      { diff_text: SIMPLE_DIFF, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const obj = JSON.parse(await readFile(env.result.artifact.json_path, "utf8"));
    expect(obj.extracted_facts).toBeNull();
  });
});

// ── Slug ────────────────────────────────────────────────────

describe("buildSlug (change_pack)", () => {
  const WHEN = new Date("2026-04-17T14:52:00Z");

  it("prefers explicit title over summary head", () => {
    const slug = __internal.buildSlug({
      title: "Auth Default Flip",
      summaryHead: "something else entirely",
      when: WHEN,
    });
    expect(slug).toMatch(/auth-default-flip$/);
  });

  it("falls back to summary head when no title", () => {
    const slug = __internal.buildSlug({
      summaryHead: "Flipped the default for auth session tokens",
      when: WHEN,
    });
    expect(slug).toMatch(/flipped-the-default-for-auth-session-tokens|flipped-the-default-for-auth/);
  });

  it("timestamp-only when neither title nor summary head", () => {
    const slug = __internal.buildSlug({ when: WHEN });
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
  });
});
