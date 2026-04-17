/**
 * artifact_diff tests — Artifact Spine B.
 *
 * Locks the structured-comparison contract:
 *   - same-pack only (cross-pack refused loudly)
 *   - lists return {added, removed, unchanged} matched on primary keys
 *   - narrative fields return {before, after}
 *   - release_note_draft also returns line_diff (LCS)
 *   - weak flip at the top level, not buried in field diffs
 *   - evidence summarized (counts + referenced_paths + path_delta)
 *   - deterministic ordering on every list
 *   - works across all three pack types (incident, repo, change)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleArtifactDiff } from "../../src/tools/artifactDiff.js";
import { lineDiff } from "../../src/tools/artifacts/diff.js";
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

class QuietClient implements OllamaClient {
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> { throw new Error("n/a"); }
  async residency(_m: string): Promise<Residency | null> { return null; }
}

function makeCtx(): RunContext & { logger: NullLogger } {
  return {
    client: new QuietClient(),
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

let tempRoot: string;
let origArtifactDir: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "intern-diff-spine-"));
  origArtifactDir = process.env.INTERN_ARTIFACT_DIR;
  process.env.INTERN_ARTIFACT_DIR = tempRoot;
});

afterEach(async () => {
  if (origArtifactDir === undefined) delete process.env.INTERN_ARTIFACT_DIR;
  else process.env.INTERN_ARTIFACT_DIR = origArtifactDir;
  await rm(tempRoot, { recursive: true, force: true });
});

async function writeArtifact(pack: string, slug: string, payload: Record<string, unknown>): Promise<void> {
  const dirMap: Record<string, string> = {
    incident_pack: "incident",
    repo_pack: "repo",
    change_pack: "change",
  };
  const dir = join(tempRoot, dirMap[pack]);
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, `${slug}.json`);
  const mdPath = join(dir, `${slug}.md`);
  const full = {
    schema_version: 1,
    pack,
    title: slug,
    slug,
    generated_at: "2026-04-17T10:00:00Z",
    hardware_profile: "dev-rtx5080",
    ...payload,
    artifact: { markdown_path: mdPath, json_path: jsonPath },
    steps: [],
  };
  await writeFile(jsonPath, JSON.stringify(full), "utf8");
  await writeFile(mdPath, "", "utf8");
}

function incidentBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    root_cause_hypotheses: [
      { hypothesis: "H1", confidence: "high", evidence_refs: ["e1"] },
      { hypothesis: "H2", confidence: "medium", evidence_refs: ["e1"] },
    ],
    affected_surfaces: [{ surface: "S1", evidence_refs: ["e1"] }],
    timeline_clues: [{ clue: "C1", evidence_refs: ["e1"] }],
    next_checks: [{ check: "look at X", why: "suspicion" }],
    coverage_notes: ["note1"],
    evidence: [
      { id: "e1", kind: "log", ref: "log:1-60", excerpt: "x" },
      { id: "e2", kind: "path", ref: "/repo/auth.ts", excerpt: "x" },
    ],
    weak: false,
    corpus_used: null,
    ...overrides,
  };
}

function repoBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo_thesis: "Original thesis statement about the repo.",
    key_surfaces: [
      { surface: "API", why: "entry", evidence_refs: [] },
      { surface: "DB", why: "store", evidence_refs: [] },
    ],
    architecture_shape: "Monolith with service layer.",
    risk_areas: [{ risk: "hot path", evidence_refs: [] }],
    read_next: [{ file: "src/index.ts", why: "entry" }],
    coverage_notes: [],
    evidence: [{ id: "e1", kind: "path", ref: "/repo/README.md", excerpt: "x" }],
    weak: false,
    corpus_used: null,
    ...overrides,
  };
}

function changeBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    change_summary: "Added X feature to Y module.",
    affected_surfaces: [{ surface: "Y module", evidence_refs: [] }],
    why_it_matters: "Unlocks Z workflow.",
    likely_breakpoints: [{ breakpoint: "downstream consumers of Y", evidence_refs: [] }],
    validation_checks: [{ check: "run Y integration suite", why: "covers the path" }],
    release_note_draft: "Added X feature.\nSee docs for details.",
    coverage_notes: [],
    evidence: [{ id: "e1", kind: "diff", ref: "diff:src/y.ts", excerpt: "x" }],
    weak: false,
    corpus_used: null,
    ...overrides,
  };
}

// ── Cross-pack refusal ─────────────────────────────────────

describe("handleArtifactDiff — cross-pack guards", () => {
  it("refuses cross-pack diff with SCHEMA_INVALID, before loading files", async () => {
    await expect(
      handleArtifactDiff(
        {
          a: { pack: "incident_pack", slug: "x" },
          b: { pack: "repo_pack", slug: "y" },
        },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID", message: expect.stringContaining("Cross-pack") });
  });
});

// ── Incident diff ──────────────────────────────────────────

describe("handleArtifactDiff — incident_pack", () => {
  it("lists diff into {added, removed, unchanged} by hypothesis text", async () => {
    await writeArtifact("incident_pack", "a", {
      input: {}, triage: null,
      brief: incidentBrief({
        root_cause_hypotheses: [
          { hypothesis: "H1-shared", confidence: "high", evidence_refs: [] },
          { hypothesis: "H2-removed", confidence: "low", evidence_refs: [] },
        ],
      }),
    });
    await writeArtifact("incident_pack", "b", {
      input: {}, triage: null,
      brief: incidentBrief({
        root_cause_hypotheses: [
          { hypothesis: "H1-shared", confidence: "high", evidence_refs: [] },
          { hypothesis: "H3-added", confidence: "medium", evidence_refs: [] },
        ],
      }),
    });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "a" }, b: { pack: "incident_pack", slug: "b" } },
      makeCtx(),
    );
    expect(env.result.pack).toBe("incident_pack");
    if (env.result.pack !== "incident_pack") return;
    const h = env.result.diff.root_cause_hypotheses;
    expect(h.unchanged.map((x) => x.hypothesis)).toEqual(["H1-shared"]);
    expect(h.added.map((x) => x.hypothesis)).toEqual(["H3-added"]);
    expect(h.removed.map((x) => x.hypothesis)).toEqual(["H2-removed"]);
  });

  it("surfaces weak flip at the top level with direction", async () => {
    await writeArtifact("incident_pack", "strong", { input: {}, triage: null, brief: incidentBrief({ weak: false }) });
    await writeArtifact("incident_pack", "weak", { input: {}, triage: null, brief: incidentBrief({ weak: true }) });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "strong" }, b: { pack: "incident_pack", slug: "weak" } },
      makeCtx(),
    );
    expect(env.result.weak.a).toBe(false);
    expect(env.result.weak.b).toBe(true);
    expect(env.result.weak.flipped).toBe(true);
    expect(env.result.weak.direction).toBe("weakened");
  });

  it("weak flip direction is 'strengthened' when weak → strong", async () => {
    await writeArtifact("incident_pack", "aw", { input: {}, triage: null, brief: incidentBrief({ weak: true }) });
    await writeArtifact("incident_pack", "bw", { input: {}, triage: null, brief: incidentBrief({ weak: false }) });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "aw" }, b: { pack: "incident_pack", slug: "bw" } },
      makeCtx(),
    );
    expect(env.result.weak.direction).toBe("strengthened");
  });

  it("no weak flip when both sides agree", async () => {
    await writeArtifact("incident_pack", "s1", { input: {}, triage: null, brief: incidentBrief({ weak: false }) });
    await writeArtifact("incident_pack", "s2", { input: {}, triage: null, brief: incidentBrief({ weak: false }) });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "s1" }, b: { pack: "incident_pack", slug: "s2" } },
      makeCtx(),
    );
    expect(env.result.weak.flipped).toBe(false);
    expect(env.result.weak.direction).toBeUndefined();
  });

  it("evidence is summarized (counts + referenced_paths + path_delta)", async () => {
    await writeArtifact("incident_pack", "a", {
      input: {}, triage: null,
      brief: incidentBrief({
        evidence: [
          { id: "e1", kind: "path", ref: "/repo/a.ts", excerpt: "x" },
          { id: "e2", kind: "path", ref: "/repo/shared.ts", excerpt: "x" },
          { id: "e3", kind: "log", ref: "log:1-60", excerpt: "x" },
        ],
      }),
    });
    await writeArtifact("incident_pack", "b", {
      input: {}, triage: null,
      brief: incidentBrief({
        evidence: [
          { id: "e1", kind: "path", ref: "/repo/shared.ts", excerpt: "x" },
          { id: "e2", kind: "corpus", ref: "/doctrine/auth.md#3", excerpt: "x" },
        ],
      }),
    });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "a" }, b: { pack: "incident_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "incident_pack") return;
    const ev = env.result.diff.evidence_summary;
    expect(ev.a.count).toBe(3);
    expect(ev.b.count).toBe(2);
    expect(ev.a.referenced_paths).toEqual(["/repo/a.ts", "/repo/shared.ts"]);
    expect(ev.b.referenced_paths).toEqual(["/doctrine/auth.md", "/repo/shared.ts"]);
    expect(ev.path_delta.added).toEqual(["/doctrine/auth.md"]);
    expect(ev.path_delta.removed).toEqual(["/repo/a.ts"]);
  });

  it("list ordering is deterministic (sorted by primary key)", async () => {
    await writeArtifact("incident_pack", "a", {
      input: {}, triage: null,
      brief: incidentBrief({
        root_cause_hypotheses: [
          { hypothesis: "zebra", confidence: "low", evidence_refs: [] },
          { hypothesis: "alpha", confidence: "high", evidence_refs: [] },
          { hypothesis: "mango", confidence: "medium", evidence_refs: [] },
        ],
      }),
    });
    await writeArtifact("incident_pack", "b", { input: {}, triage: null, brief: incidentBrief({ root_cause_hypotheses: [] }) });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "a" }, b: { pack: "incident_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "incident_pack") return;
    const removed = env.result.diff.root_cause_hypotheses.removed.map((h) => h.hypothesis);
    expect(removed).toEqual(["alpha", "mango", "zebra"]); // sorted asc
  });

  it("identical artifacts produce all-unchanged, empty added/removed", async () => {
    await writeArtifact("incident_pack", "a", { input: {}, triage: null, brief: incidentBrief() });
    await writeArtifact("incident_pack", "b", { input: {}, triage: null, brief: incidentBrief() });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "a" }, b: { pack: "incident_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "incident_pack") return;
    const d = env.result.diff;
    expect(d.root_cause_hypotheses.added).toEqual([]);
    expect(d.root_cause_hypotheses.removed).toEqual([]);
    expect(d.root_cause_hypotheses.unchanged).toHaveLength(2);
  });
});

// ── Repo diff ──────────────────────────────────────────────

describe("handleArtifactDiff — repo_pack", () => {
  it("narrative fields diff as {before, after}", async () => {
    await writeArtifact("repo_pack", "a", {
      input: { source_paths: [] },
      brief: repoBrief({
        repo_thesis: "Original thesis.",
        architecture_shape: "Monolith.",
      }),
      extracted_facts: null,
    });
    await writeArtifact("repo_pack", "b", {
      input: { source_paths: [] },
      brief: repoBrief({
        repo_thesis: "Revised thesis.",
        architecture_shape: "Service-oriented.",
      }),
      extracted_facts: null,
    });
    const env = await handleArtifactDiff(
      { a: { pack: "repo_pack", slug: "a" }, b: { pack: "repo_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "repo_pack") return;
    expect(env.result.diff.repo_thesis.before).toBe("Original thesis.");
    expect(env.result.diff.repo_thesis.after).toBe("Revised thesis.");
    expect(env.result.diff.architecture_shape.before).toBe("Monolith.");
    expect(env.result.diff.architecture_shape.after).toBe("Service-oriented.");
  });

  it("key_surfaces matched by surface name", async () => {
    await writeArtifact("repo_pack", "a", {
      input: { source_paths: [] },
      brief: repoBrief({
        key_surfaces: [
          { surface: "API", why: "entry", evidence_refs: [] },
          { surface: "DB", why: "store", evidence_refs: [] },
        ],
      }),
      extracted_facts: null,
    });
    await writeArtifact("repo_pack", "b", {
      input: { source_paths: [] },
      brief: repoBrief({
        key_surfaces: [
          { surface: "API", why: "different reason", evidence_refs: [] }, // same surface, different why
          { surface: "Queue", why: "new", evidence_refs: [] },
        ],
      }),
      extracted_facts: null,
    });
    const env = await handleArtifactDiff(
      { a: { pack: "repo_pack", slug: "a" }, b: { pack: "repo_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "repo_pack") return;
    const ks = env.result.diff.key_surfaces;
    // API is matched (unchanged), DB is removed, Queue is added.
    expect(ks.unchanged.map((s) => s.surface)).toEqual(["API"]);
    expect(ks.added.map((s) => s.surface)).toEqual(["Queue"]);
    expect(ks.removed.map((s) => s.surface)).toEqual(["DB"]);
  });

  it("extracted_facts diff flags presence when one side is null", async () => {
    await writeArtifact("repo_pack", "a", {
      input: { source_paths: [] },
      brief: repoBrief(),
      extracted_facts: null,
    });
    await writeArtifact("repo_pack", "b", {
      input: { source_paths: [] },
      brief: repoBrief(),
      extracted_facts: { package_names: ["@x/y"] },
    });
    const env = await handleArtifactDiff(
      { a: { pack: "repo_pack", slug: "a" }, b: { pack: "repo_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "repo_pack") return;
    expect(env.result.diff.extracted_facts.a_present).toBe(false);
    expect(env.result.diff.extracted_facts.b_present).toBe(true);
    // No sub-diffs populated when one side is null.
    expect(env.result.diff.extracted_facts.package_names).toBeUndefined();
  });

  it("extracted_facts sub-diffs populated when both sides present", async () => {
    await writeArtifact("repo_pack", "a", {
      input: { source_paths: [] },
      brief: repoBrief(),
      extracted_facts: {
        package_names: ["@x/shared", "@x/old"],
        scripts: [{ name: "build", command: "tsc" }],
        config_files: ["tsconfig.json"],
      },
    });
    await writeArtifact("repo_pack", "b", {
      input: { source_paths: [] },
      brief: repoBrief(),
      extracted_facts: {
        package_names: ["@x/shared", "@x/new"],
        scripts: [{ name: "build", command: "tsc -p ." }, { name: "test", command: "vitest" }],
        config_files: ["tsconfig.json"],
      },
    });
    const env = await handleArtifactDiff(
      { a: { pack: "repo_pack", slug: "a" }, b: { pack: "repo_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "repo_pack") return;
    const f = env.result.diff.extracted_facts;
    expect(f.a_present).toBe(true);
    expect(f.b_present).toBe(true);
    expect(f.package_names?.added).toEqual(["@x/new"]);
    expect(f.package_names?.removed).toEqual(["@x/old"]);
    expect(f.package_names?.unchanged).toEqual(["@x/shared"]);
    expect(f.scripts?.added.map((s) => s.name)).toEqual(["test"]);
    expect(f.scripts?.unchanged.map((s) => s.name)).toEqual(["build"]); // matched by name, command change tolerated
    expect(f.config_files?.unchanged).toEqual(["tsconfig.json"]);
  });
});

// ── Change diff ────────────────────────────────────────────

describe("handleArtifactDiff — change_pack", () => {
  it("release_note_draft returns before/after AND a line_diff", async () => {
    await writeArtifact("change_pack", "a", {
      input: {}, triage: null,
      brief: changeBrief({
        release_note_draft: "Line one.\nLine two.\nLine three.",
      }),
      extracted_facts: null,
    });
    await writeArtifact("change_pack", "b", {
      input: {}, triage: null,
      brief: changeBrief({
        release_note_draft: "Line one.\nLine two revised.\nLine three.\nNew line four.",
      }),
      extracted_facts: null,
    });
    const env = await handleArtifactDiff(
      { a: { pack: "change_pack", slug: "a" }, b: { pack: "change_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "change_pack") return;
    const rn = env.result.diff.release_note_draft;
    expect(rn.before).toContain("Line two.");
    expect(rn.after).toContain("Line two revised.");
    // line_diff has same/add/remove ops. At minimum, "Line one." is unchanged,
    // "Line two." is removed, "Line two revised." is added, "New line four." is added.
    const ops = rn.line_diff.map((e) => `${e.op}:${e.line}`);
    expect(ops).toContain("same:Line one.");
    expect(ops).toContain("remove:Line two.");
    expect(ops).toContain("add:Line two revised.");
    expect(ops).toContain("add:New line four.");
  });

  it("likely_breakpoints matched by breakpoint text", async () => {
    await writeArtifact("change_pack", "a", {
      input: {}, triage: null,
      brief: changeBrief({
        likely_breakpoints: [
          { breakpoint: "downstream-old", evidence_refs: [] },
          { breakpoint: "shared-concern", evidence_refs: [] },
        ],
      }),
      extracted_facts: null,
    });
    await writeArtifact("change_pack", "b", {
      input: {}, triage: null,
      brief: changeBrief({
        likely_breakpoints: [
          { breakpoint: "shared-concern", evidence_refs: [] },
          { breakpoint: "new-risk", evidence_refs: [] },
        ],
      }),
      extracted_facts: null,
    });
    const env = await handleArtifactDiff(
      { a: { pack: "change_pack", slug: "a" }, b: { pack: "change_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "change_pack") return;
    const lb = env.result.diff.likely_breakpoints;
    expect(lb.added.map((x) => x.breakpoint)).toEqual(["new-risk"]);
    expect(lb.removed.map((x) => x.breakpoint)).toEqual(["downstream-old"]);
    expect(lb.unchanged.map((x) => x.breakpoint)).toEqual(["shared-concern"]);
  });

  it("change-pack extracted_facts uses the change schema (scripts_touched / config_surfaces / runtime_hints)", async () => {
    await writeArtifact("change_pack", "a", {
      input: {}, triage: null, brief: changeBrief(),
      extracted_facts: {
        scripts_touched: ["build"],
        config_surfaces: ["tsconfig.json"],
        runtime_hints: ["Node 18+"],
      },
    });
    await writeArtifact("change_pack", "b", {
      input: {}, triage: null, brief: changeBrief(),
      extracted_facts: {
        scripts_touched: ["build", "test"],
        config_surfaces: ["tsconfig.json"],
        runtime_hints: ["Node 20+"],
      },
    });
    const env = await handleArtifactDiff(
      { a: { pack: "change_pack", slug: "a" }, b: { pack: "change_pack", slug: "b" } },
      makeCtx(),
    );
    if (env.result.pack !== "change_pack") return;
    const f = env.result.diff.extracted_facts;
    expect(f.scripts_touched?.added).toEqual(["test"]);
    expect(f.config_surfaces?.unchanged).toEqual(["tsconfig.json"]);
    expect(f.runtime_hints?.added).toEqual(["Node 20+"]);
    expect(f.runtime_hints?.removed).toEqual(["Node 18+"]);
  });
});

// ── Shared helper: lineDiff ─────────────────────────────────

describe("lineDiff", () => {
  it("empty before → all new lines are 'add'", () => {
    const ops = lineDiff("", "one\ntwo");
    const adds = ops.filter((o) => o.op === "add").map((o) => o.line);
    expect(adds).toEqual(["one", "two"]);
  });

  it("identical → all same", () => {
    const ops = lineDiff("x\ny\nz", "x\ny\nz");
    expect(ops.map((o) => o.op)).toEqual(["same", "same", "same"]);
  });

  it("recognizes insertion in middle", () => {
    const ops = lineDiff("a\nc", "a\nb\nc");
    const ins = ops.find((o) => o.op === "add");
    expect(ins?.line).toBe("b");
  });

  it("recognizes deletion", () => {
    const ops = lineDiff("a\nb\nc", "a\nc");
    const del = ops.find((o) => o.op === "remove");
    expect(del?.line).toBe("b");
  });
});

// ── Identity resolution ────────────────────────────────────

describe("handleArtifactDiff — identity", () => {
  it("uses resolveArtifactByIdentity — missing slug fails SOURCE_PATH_NOT_FOUND", async () => {
    await writeArtifact("incident_pack", "exists", { input: {}, triage: null, brief: incidentBrief() });
    await expect(
      handleArtifactDiff(
        { a: { pack: "incident_pack", slug: "exists" }, b: { pack: "incident_pack", slug: "nope" } },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });

  it("response identity block carries slug + created_at + title", async () => {
    await writeArtifact("incident_pack", "a", { input: {}, triage: null, brief: incidentBrief() });
    await writeArtifact("incident_pack", "b", { input: {}, triage: null, brief: incidentBrief() });
    const env = await handleArtifactDiff(
      { a: { pack: "incident_pack", slug: "a" }, b: { pack: "incident_pack", slug: "b" } },
      makeCtx(),
    );
    expect(env.result.a.slug).toBe("a");
    expect(env.result.b.slug).toBe("b");
    expect(env.result.a.created_at).toBe("2026-04-17T10:00:00Z");
    expect(env.result.a.title).toBe("a");
  });
});
