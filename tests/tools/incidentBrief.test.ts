/**
 * ollama_incident_brief tests — Workflow Spine C.
 *
 * Locks the operator-brief contract:
 *   - structured shape (hypotheses / surfaces / clues / next_checks /
 *     evidence / weak / coverage_notes / corpus_used)
 *   - evidence is first-class: every hypothesis/surface/clue carries
 *     evidence_refs, and refs to unknown ids are stripped
 *   - thin evidence → weak: true with coverage notes
 *   - input: at least one of log_text or source_paths required
 *   - corpus integration is optional, but when requested the brief
 *     reports chunks_used honestly
 *   - no remediation drift in the prompt shape
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleIncidentBrief } from "../../src/tools/incidentBrief.js";
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
  constructor(
    private readonly generateResponse: string,
    private readonly embedTable: Map<string, number[]> = new Map(),
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.generateCalls += 1;
    this.lastPrompt = req.prompt;
    return { model: req.model, response: this.generateResponse, done: true, prompt_eval_count: 100, eval_count: 40 };
  }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return {
      model: req.model,
      embeddings: inputs.map((t) => this.embedTable.get(t) ?? [1, 0, 0, 0]),
    };
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

async function writeCorpus(name: string, modelVersion: string, chunks: Array<{ id: string; path: string; chunk_index?: number; text: string; heading_path?: string[] }>): Promise<void> {
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
    stats: { documents: new Set(chunks.map((c) => c.path)).size, chunks: chunks.length, total_chars: chunks.reduce((n, c) => n + c.text.length, 0) },
    titles,
    chunks: chunks.map((c) => ({
      id: c.id,
      path: c.path,
      file_hash: "sha256:test",
      file_mtime: "2026-04-17T00:00:00.000Z",
      chunk_index: c.chunk_index ?? 0,
      char_start: 0,
      char_end: c.text.length,
      text: c.text,
      vector: [1, 0, 0, 0],
      heading_path: c.heading_path ?? [],
      chunk_type: "paragraph",
    })),
  };
  await saveCorpus(corpus);
}

const EMBED_MODEL = PROFILES["dev-rtx5080"].tiers.embed;

// ── Fixture lifecycle ───────────────────────────────────────

let tempDir: string;
let origCorpusDir: string | undefined;

// Module-load snapshot — bulletproof restore even if beforeEach throws
// before its own snapshot line runs. (T001)
const MODULE_ORIG_CORPUS_DIR = process.env.INTERN_CORPUS_DIR;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-brief-"));
  origCorpusDir = process.env.INTERN_CORPUS_DIR;
  process.env.INTERN_CORPUS_DIR = tempDir;
});

afterEach(async () => {
  const toRestore = origCorpusDir ?? MODULE_ORIG_CORPUS_DIR;
  try {
    if (toRestore === undefined) delete process.env.INTERN_CORPUS_DIR;
    else process.env.INTERN_CORPUS_DIR = toRestore;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────

describe("handleIncidentBrief — input contract", () => {
  it("rejects calls with neither log_text nor source_paths", async () => {
    const client = new ProgrammableClient("{}");
    await expect(
      handleIncidentBrief({}, makeCtx(client)),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(client.generateCalls).toBe(0);
  });

  it("accepts log_text only", async () => {
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [{ hypothesis: "OOM kill", confidence: "high", evidence_refs: ["e1"] }],
      affected_surfaces: [{ surface: "worker pool", evidence_refs: ["e1"] }],
      timeline_clues: [],
      next_checks: [{ check: "inspect memory usage", why: "check if OOM killer fired" }],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief(
      { log_text: "ERROR: process 1234 killed by signal 9\nWARN: memory at 99%\nINFO: worker restart triggered" },
      makeCtx(client),
    );
    expect(env.result.root_cause_hypotheses).toHaveLength(1);
    expect(env.result.evidence.length).toBeGreaterThan(0);
  });

  it("accepts empty source_paths when log_text is provided", async () => {
    // Regression — Hermes/hermes3:8b emits `source_paths: []` on log-driven
    // incident calls. The schema previously required min:1, which broke the
    // integration end-to-end. Empty array is now accepted; runtime still
    // enforces "at least one of log_text or source_paths" (the "rejects"
    // test above covers the neither-present case).
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [{ hypothesis: "OOM kill", confidence: "high", evidence_refs: ["e1"] }],
      affected_surfaces: [{ surface: "worker pool", evidence_refs: ["e1"] }],
      timeline_clues: [],
      next_checks: [{ check: "inspect memory usage", why: "check if OOM killer fired" }],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief(
      { log_text: "ERROR: oom-killed\nWARN: memory 99%\nINFO: restart", source_paths: [] },
      makeCtx(client),
    );
    expect(env.result.root_cause_hypotheses).toHaveLength(1);
  });

  it("accepts source_paths only", async () => {
    const p = join(tempDir, "config.yaml");
    await writeFile(p, "memory_limit: 512MB\nworkers: 4\n", "utf8");
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [],
      affected_surfaces: [{ surface: "config", evidence_refs: ["e1"] }],
      timeline_clues: [],
      next_checks: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief(
      { source_paths: [p] },
      makeCtx(client),
    );
    expect(env.result.evidence.some((e) => e.kind === "path")).toBe(true);
  });
});

describe("handleIncidentBrief — evidence shape", () => {
  it("numbers log excerpts as e1, e2, ... and tags kind=log", async () => {
    const longLog = Array.from({ length: 200 }, (_, i) => `line ${i} content`).join("\n");
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [{ hypothesis: "H", confidence: "low", evidence_refs: ["e1", "e2", "e3"] }],
      affected_surfaces: [], timeline_clues: [], next_checks: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief({ log_text: longLog }, makeCtx(client));
    // 200 lines / 60 per chunk = ceil(200/60) = 4 evidence items.
    expect(env.result.evidence.length).toBeGreaterThanOrEqual(3);
    for (const e of env.result.evidence) {
      expect(e.kind).toBe("log");
      expect(e.id).toMatch(/^e\d+$/);
      expect(e.ref).toMatch(/^log:\d+-\d+$/);
    }
  });

  it("kind=path evidence carries the source path as ref", async () => {
    const p = join(tempDir, "app.log");
    await writeFile(p, "alpha\nbravo\ngamma", "utf8");
    const modelOut = JSON.stringify({ root_cause_hypotheses: [], affected_surfaces: [], timeline_clues: [], next_checks: [] });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief({ source_paths: [p] }, makeCtx(client));
    const pathEv = env.result.evidence.find((e) => e.kind === "path")!;
    expect(pathEv.ref).toBe(p);
    expect(pathEv.excerpt).toContain("alpha");
  });

  it("strips evidence_refs that don't match any evidence id", async () => {
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [{ hypothesis: "X", confidence: "medium", evidence_refs: ["e1", "e99", "fabricated"] }],
      affected_surfaces: [{ surface: "Y", evidence_refs: ["e42", "e1"] }],
      timeline_clues: [],
      next_checks: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief(
      { log_text: "short log blob" },
      makeCtx(client),
    );
    // Only e1 is a valid id for a one-chunk log.
    const h = env.result.root_cause_hypotheses[0];
    expect(h.evidence_refs).toEqual(["e1"]);
    const s = env.result.affected_surfaces[0];
    expect(s.evidence_refs).toEqual(["e1"]);
    // Coverage notes surface the stripping.
    expect(env.result.coverage_notes.some((n) => n.includes("Stripped"))).toBe(true);
    expect(env.warnings?.some((w) => w.includes("Stripped"))).toBe(true);
  });

  it("dedupes repeated evidence_refs within a single hypothesis", async () => {
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [{ hypothesis: "X", confidence: "high", evidence_refs: ["e1", "e1", "e1"] }],
      affected_surfaces: [], timeline_clues: [], next_checks: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief({ log_text: "blob" }, makeCtx(client));
    expect(env.result.root_cause_hypotheses[0].evidence_refs).toEqual(["e1"]);
  });

  it("normalizes confidence to low on unknown values", async () => {
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [{ hypothesis: "X", confidence: "maybe-ish", evidence_refs: ["e1"] }],
      affected_surfaces: [], timeline_clues: [], next_checks: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief({ log_text: "blob" }, makeCtx(client));
    expect(env.result.root_cause_hypotheses[0].confidence).toBe("low");
  });
});

describe("handleIncidentBrief — weak / honest degradation", () => {
  it("empty hypotheses + surfaces → weak: true with coverage note", async () => {
    const modelOut = JSON.stringify({ root_cause_hypotheses: [], affected_surfaces: [], timeline_clues: [], next_checks: [] });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief({ log_text: "nothing to see here" }, makeCtx(client));
    expect(env.result.weak).toBe(true);
    expect(env.result.coverage_notes.length).toBeGreaterThan(0);
    expect(env.result.coverage_notes.some((n) => n.includes("No root-cause hypotheses"))).toBe(true);
  });

  it("non-JSON model output → empty brief + weak + warning", async () => {
    const client = new ProgrammableClient("the model did not follow the JSON contract");
    const env = await handleIncidentBrief({ log_text: "anything" }, makeCtx(client));
    expect(env.result.root_cause_hypotheses).toEqual([]);
    expect(env.result.weak).toBe(true);
    expect(env.warnings?.some((w) => w.includes("empty brief"))).toBe(true);
  });

  it("max_hypotheses caps oversized output", async () => {
    const tooMany = Array.from({ length: 10 }, (_, i) => ({
      hypothesis: `H${i}`, confidence: "medium", evidence_refs: ["e1"],
    }));
    const client = new ProgrammableClient(JSON.stringify({ root_cause_hypotheses: tooMany, affected_surfaces: [], timeline_clues: [], next_checks: [] }));
    const env = await handleIncidentBrief(
      { log_text: "blob", max_hypotheses: 3 },
      makeCtx(client),
    );
    expect(env.result.root_cause_hypotheses).toHaveLength(3);
  });
});

describe("handleIncidentBrief — corpus integration", () => {
  it("passes corpus_query to corpus search and includes chunks as evidence", async () => {
    await writeCorpus("doctrine", EMBED_MODEL, [
      { id: "c-0", path: "/doctrine/memory-limits.md", text: "workers should use at most 256MB each", heading_path: ["Memory Limits"] },
    ]);
    const modelOut = JSON.stringify({
      root_cause_hypotheses: [{ hypothesis: "worker exceeded declared memory", confidence: "high", evidence_refs: ["e1", "e2"] }],
      affected_surfaces: [], timeline_clues: [], next_checks: [],
    });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief(
      {
        log_text: "worker OOM killed",
        corpus: "doctrine",
        corpus_query: "memory limits",
      },
      makeCtx(client),
    );
    expect(env.result.corpus_used).toEqual({ name: "doctrine", chunks_used: 1 });
    const corpusEv = env.result.evidence.find((e) => e.kind === "corpus");
    expect(corpusEv).toBeDefined();
    expect(corpusEv!.ref).toContain("memory-limits.md");
    expect(client.embedCalls).toBe(1);
  });

  it("corpus_used is null when no corpus is passed", async () => {
    const modelOut = JSON.stringify({ root_cause_hypotheses: [], affected_surfaces: [], timeline_clues: [], next_checks: [] });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief({ log_text: "blob" }, makeCtx(client));
    expect(env.result.corpus_used).toBeNull();
    expect(client.embedCalls).toBe(0);
  });

  it("corpus with 0 hits flags the gap in coverage_notes", async () => {
    await writeCorpus("thin", EMBED_MODEL, []); // empty corpus
    const modelOut = JSON.stringify({ root_cause_hypotheses: [{ hypothesis: "H", confidence: "low", evidence_refs: ["e1"] }], affected_surfaces: [], timeline_clues: [], next_checks: [] });
    const client = new ProgrammableClient(modelOut);
    const env = await handleIncidentBrief(
      { log_text: "something", corpus: "thin", corpus_query: "anything" },
      makeCtx(client),
    );
    expect(env.result.corpus_used?.chunks_used).toBe(0);
    expect(env.result.coverage_notes.some((n) => n.includes('Corpus "thin"') && n.includes("0 chunks"))).toBe(true);
  });

  it("rejects unknown corpus with SCHEMA_INVALID", async () => {
    const client = new ProgrammableClient("{}");
    await expect(
      handleIncidentBrief(
        { log_text: "blob", corpus: "does-not-exist" },
        makeCtx(client),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(client.generateCalls).toBe(0);
  });
});

describe("handleIncidentBrief — prompt shape boundaries", () => {
  it("prompt forbids prescriptive remediation in next_checks", async () => {
    const modelOut = JSON.stringify({ root_cause_hypotheses: [], affected_surfaces: [], timeline_clues: [], next_checks: [] });
    const client = new ProgrammableClient(modelOut);
    await handleIncidentBrief({ log_text: "blob" }, makeCtx(client));
    const prompt = client.lastPrompt ?? "";
    // These phrases encode the anti-remediation law. If the prompt ever
    // stops mentioning them, the tool has drifted.
    expect(prompt).toMatch(/INVESTIGATIVE/);
    expect(prompt).toMatch(/never prescriptive fixes/);
    expect(prompt).toMatch(/not suggest code changes, rollbacks, restarts/);
  });

  it("prompt asserts evidence_refs must come from the provided ids", async () => {
    const modelOut = JSON.stringify({ root_cause_hypotheses: [], affected_surfaces: [], timeline_clues: [], next_checks: [] });
    const client = new ProgrammableClient(modelOut);
    await handleIncidentBrief({ log_text: "blob" }, makeCtx(client));
    expect(client.lastPrompt).toMatch(/Do not invent ids/);
  });
});
