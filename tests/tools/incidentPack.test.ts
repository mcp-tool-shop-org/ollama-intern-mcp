/**
 * ollama_incident_pack tests — Pack Spine commit 1.
 *
 * Locks the pack contract:
 *   - fixed pipeline: triage → (corpus search when corpus) → incident_brief → artifact
 *   - artifact write: deterministic markdown + JSON to disk at known paths
 *   - response is COMPACT (paths + summary + steps) — full brief lives in artifact
 *   - slug derived from title, else first hypothesis, else timestamp-only
 *   - step trace is accurate, compact, one entry per step actually run
 *   - weak brief propagates to summary.weak
 *   - artifact_dir override works
 *   - no log_text → triage step skipped, not faked
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleIncidentPack, __internal } from "../../src/tools/packs/incidentPack.js";
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

/**
 * Prompt-routing mock: responds differently based on which tool's
 * prompt it recognizes. The triage prompt starts with "You are a log
 * triage assistant"; the incident_brief prompt starts with "You are an
 * incident analyst".
 */
class PipelineMock implements OllamaClient {
  public generateCalls: Array<{ tool: "triage" | "brief" | "other"; prompt: string }> = [];
  public embedCalls = 0;
  constructor(
    private readonly triageResponse: string,
    private readonly briefResponse: string,
  ) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const prompt = req.prompt;
    let tool: "triage" | "brief" | "other";
    if (prompt.startsWith("You are a log triage")) tool = "triage";
    else if (prompt.startsWith("You are an incident analyst")) tool = "brief";
    else tool = "other";
    this.generateCalls.push({ tool, prompt });
    const response = tool === "triage" ? this.triageResponse : tool === "brief" ? this.briefResponse : "{}";
    return { model: req.model, response, done: true, prompt_eval_count: 80, eval_count: 30 };
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

// Long-enough log to cross incident_brief's WEAK_EVIDENCE_THRESHOLD (2+ chunks
// at 60 lines per chunk — so we want ≥ 70 lines).
const LONG_LOG = Array.from({ length: 80 }, (_, i) =>
  i < 2 ? `ERROR: connection reset (${i})` : i < 5 ? `WARN: retries exhausted (${i})` : `INFO: step ${i}`,
).join("\n");

const TRIAGE_OUT = JSON.stringify({
  errors: ["ERROR: connection reset", "ERROR: retry failed"],
  warnings: ["WARN: retries exhausted"],
  suspected_root_cause: "upstream service dropping connections",
});

const BRIEF_OUT = JSON.stringify({
  root_cause_hypotheses: [
    { hypothesis: "upstream dependency flaking", confidence: "high", evidence_refs: ["e1"] },
    { hypothesis: "network partition at edge", confidence: "medium", evidence_refs: ["e1"] },
  ],
  affected_surfaces: [{ surface: "checkout service", evidence_refs: ["e1"] }],
  timeline_clues: [{ clue: "retry storm at 14:52", evidence_refs: ["e1"] }],
  next_checks: [
    { check: "inspect upstream health dashboard", why: "confirm the dependency was degraded" },
    { check: "verify retry/backoff config", why: "see if storm was amplified by policy" },
  ],
});

let tempArtifactDir: string;

beforeEach(async () => {
  tempArtifactDir = await mkdtemp(join(tmpdir(), "intern-pack-artifact-"));
});

afterEach(async () => {
  await rm(tempArtifactDir, { recursive: true, force: true });
});

// ── Pipeline + artifact tests ───────────────────────────────

describe("handleIncidentPack — fixed pipeline", () => {
  it("runs triage then incident_brief then writes both artifact files", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: "ERROR: connection reset\nERROR: retry failed\nWARN: retries exhausted", title: "Checkout outage", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );

    // Both generate calls happened in pipeline order.
    expect(client.generateCalls.map((c) => c.tool)).toEqual(["triage", "brief"]);

    // Both artifact files exist on disk.
    const entries = await readdir(tempArtifactDir);
    expect(entries.filter((e) => e.endsWith(".md"))).toHaveLength(1);
    expect(entries.filter((e) => e.endsWith(".json"))).toHaveLength(1);
    expect(env.result.artifact.markdown_path).toMatch(/\.md$/);
    expect(env.result.artifact.json_path).toMatch(/\.json$/);
  });

  it("step trace records each step with tool, ok, elapsed_ms", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, title: "T", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const tools = env.result.steps.map((s) => s.tool);
    expect(tools).toEqual(["ollama_triage_logs", "ollama_incident_brief", "artifact_write"]);
    for (const step of env.result.steps) {
      expect(step.ok).toBe(true);
      expect(step.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
    const last = env.result.steps[env.result.steps.length - 1];
    expect(last.tool).toBe("artifact_write");
    expect(last.artifact_written).toBe(true);
  });

  it("response is compact — no full brief dumped into envelope.result", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    // Only these top-level keys — nothing else.
    const topKeys = Object.keys(env.result).sort();
    expect(topKeys).toEqual(["artifact", "steps", "summary"]);
    // summary has the counts, not the items themselves.
    expect(env.result.summary).toHaveProperty("hypotheses_count");
    expect(env.result.summary).toHaveProperty("weak");
    expect(env.result.summary).not.toHaveProperty("root_cause_hypotheses");
  });

  it("summary.hypotheses_count matches the brief", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.summary.hypotheses_count).toBe(2); // BRIEF_OUT has 2 hypotheses
    expect(env.result.summary.affected_surfaces_count).toBe(1);
    expect(env.result.summary.next_checks_count).toBe(2);
    expect(env.result.summary.weak).toBe(false);
  });

  it("skips triage step when no log_text is provided", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    // Write a tiny source file so source_paths-only mode has something to read.
    const srcPath = join(tempArtifactDir, "..", `pack-src-${Date.now()}.md`);
    await writeFile(srcPath, "# incident notes\nthe thing broke at 14:52", "utf8");
    try {
      const env = await handleIncidentPack(
        { source_paths: [srcPath], title: "paths-only", artifact_dir: tempArtifactDir },
        makeCtx(client),
      );
      // Only brief ran through generate; triage was skipped entirely.
      expect(client.generateCalls.map((c) => c.tool)).toEqual(["brief"]);
      const tools = env.result.steps.map((s) => s.tool);
      expect(tools).toEqual(["ollama_incident_brief", "artifact_write"]);
    } finally {
      await rm(srcPath, { force: true });
    }
  });

  it("rejects calls with neither log_text nor source_paths", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    await expect(
      handleIncidentPack({ artifact_dir: tempArtifactDir }, makeCtx(client)),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    expect(client.generateCalls).toHaveLength(0);
  });

  it("accepts empty source_paths when log_text is provided", async () => {
    // Regression — Hermes/hermes3:8b emits `source_paths: []` on log-driven
    // incident_pack calls. Before v2.0.0 the schema required min:1 which
    // broke the integration end-to-end. Empty array passes now; runtime
    // still requires at least one of log_text or source_paths.
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, source_paths: [], title: "Hermes empty paths", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(client.generateCalls.map((c) => c.tool)).toEqual(["triage", "brief"]);
    expect(env.result.artifact.markdown_path).toMatch(/\.md$/);
  });

  it("weak brief propagates to summary.weak", async () => {
    const weakBrief = JSON.stringify({
      root_cause_hypotheses: [],
      affected_surfaces: [],
      timeline_clues: [],
      next_checks: [],
    });
    const client = new PipelineMock(TRIAGE_OUT, weakBrief);
    const env = await handleIncidentPack(
      { log_text: "ERROR: something", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.summary.weak).toBe(true);
    expect(env.result.summary.hypotheses_count).toBe(0);
    // Artifact still written — the weak brief is still a completed job.
    const entries = await readdir(tempArtifactDir);
    expect(entries.some((e) => e.endsWith(".md"))).toBe(true);
  });
});

// ── Markdown artifact tests ─────────────────────────────────

describe("handleIncidentPack — markdown layout", () => {
  it("markdown contains all 8 fixed sections in order", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, title: "Checkout outage", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    const sections = [
      "## Incident",
      "## Likely root cause",
      "## Affected surfaces",
      "## Timeline clues",
      "## Evidence",
      "## Next checks",
      "## Coverage notes",
      "## Step trace",
    ];
    let cursor = 0;
    for (const s of sections) {
      const idx = md.indexOf(s, cursor);
      expect(idx, `section missing or out of order: ${s}`).toBeGreaterThan(-1);
      cursor = idx;
    }
  });

  it("markdown includes triage signal in the Incident section", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, title: "T", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toContain("2 errors, 1 warning");
    expect(md).toContain("upstream service dropping connections");
  });

  it("markdown shows a weak banner when brief.weak is true", async () => {
    const weakBrief = JSON.stringify({
      root_cause_hypotheses: [],
      affected_surfaces: [],
      timeline_clues: [],
      next_checks: [],
    });
    const client = new PipelineMock(TRIAGE_OUT, weakBrief);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toMatch(/Weak brief/);
  });

  it("markdown step trace lists tools that ran before the artifact was written", async () => {
    // artifact_write is intentionally NOT in the markdown trace — the
    // artifact can't narrate its own write. It's in the MCP response trace
    // where it matters (callers can check artifact_written programmatically).
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const md = await readFile(env.result.artifact.markdown_path, "utf8");
    expect(md).toMatch(/\|\s*\d+\s*\|\s*`ollama_triage_logs`/);
    expect(md).toMatch(/\|\s*\d+\s*\|\s*`ollama_incident_brief`/);
    expect(md).not.toMatch(/`artifact_write`/);
    // But the MCP response trace DOES include artifact_write.
    expect(env.result.steps.map((s) => s.tool)).toContain("artifact_write");
  });
});

// ── JSON artifact tests ─────────────────────────────────────

describe("handleIncidentPack — JSON artifact", () => {
  it("JSON carries triage + brief + steps + artifact paths", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, title: "T", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    const raw = await readFile(env.result.artifact.json_path, "utf8");
    const obj = JSON.parse(raw);
    expect(obj.schema_version).toBe(1);
    expect(obj.pack).toBe("incident_pack");
    expect(obj.triage.errors).toHaveLength(2);
    expect(obj.brief.root_cause_hypotheses).toHaveLength(2);
    expect(obj.steps.length).toBeGreaterThan(0);
    expect(obj.artifact.markdown_path).toBe(env.result.artifact.markdown_path);
    expect(obj.artifact.json_path).toBe(env.result.artifact.json_path);
    // Input echo must NOT include raw log_text — only a flag.
    expect(obj.input.has_log_text).toBe(true);
    expect(obj.input).not.toHaveProperty("log_text");
  });

  it("JSON triage is null when no log_text was provided", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const p = join(tempArtifactDir, "..", `src-${Date.now()}.md`);
    await writeFile(p, "some notes", "utf8");
    try {
      const env = await handleIncidentPack(
        { source_paths: [p], artifact_dir: tempArtifactDir },
        makeCtx(client),
      );
      const obj = JSON.parse(await readFile(env.result.artifact.json_path, "utf8"));
      expect(obj.triage).toBeNull();
      expect(obj.input.has_log_text).toBe(false);
    } finally {
      await rm(p, { force: true });
    }
  });
});

// ── Slug tests ──────────────────────────────────────────────

describe("buildSlug", () => {
  const WHEN = new Date("2026-04-17T14:52:00Z");

  it("derives slug from title when provided", () => {
    const slug = __internal.buildSlug({ title: "Checkout Outage!", when: WHEN });
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-checkout-outage$/);
  });

  it("falls back to hypothesis when no title", () => {
    const slug = __internal.buildSlug({
      hypothesis: "Upstream dependency flaking intermittently",
      when: WHEN,
    });
    expect(slug).toMatch(/upstream-dependency-flaking/);
  });

  it("falls back to timestamp-only when both are missing", () => {
    const slug = __internal.buildSlug({ when: WHEN });
    expect(slug).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
  });

  it("strips unsafe filename chars and caps slug length", () => {
    const slug = __internal.buildSlug({
      title: "A//B/../C !@#$%^&*() looooooooooooooooooooooooooooooooooooooooooooong",
      when: WHEN,
    });
    // No slashes, dots (except in date), special chars.
    const stem = slug.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, "");
    expect(stem).not.toMatch(/[^a-z0-9-]/);
    expect(stem.length).toBeLessThanOrEqual(40);
  });
});

// ── Artifact-dir override ───────────────────────────────────

describe("handleIncidentPack — artifact_dir", () => {
  it("writes artifacts to the caller-supplied artifact_dir", async () => {
    const client = new PipelineMock(TRIAGE_OUT, BRIEF_OUT);
    const env = await handleIncidentPack(
      { log_text: LONG_LOG, title: "T", artifact_dir: tempArtifactDir },
      makeCtx(client),
    );
    expect(env.result.artifact.markdown_path.startsWith(tempArtifactDir)).toBe(true);
    expect(env.result.artifact.json_path.startsWith(tempArtifactDir)).toBe(true);
  });
});
