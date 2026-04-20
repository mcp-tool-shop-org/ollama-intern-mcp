/**
 * Artifact Spine commit A tests — artifact_list + artifact_read.
 *
 * Locks the continuity-surface contract:
 *   - list: metadata-only, cheap, filter → sort → limit, no full payloads
 *   - list: duplicates surface as warnings but every colliding record still appears
 *   - read primary: {pack, slug} — identity-based, collisions fail loud
 *   - read secondary: {json_path} — strict path safety, must live under an
 *     allowed artifact dir, must end in .json, no traversal
 *   - read: discriminated union on pack — payloads stay distinct
 *   - extra_artifact_dirs widens the search surface without shifting identity
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleArtifactList } from "../../src/tools/artifactList.js";
import { handleArtifactRead } from "../../src/tools/artifactRead.js";
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

// Module-load snapshot — bulletproof restore even if beforeEach throws
// before its own snapshot line runs. (T001)
const MODULE_ORIG_ARTIFACT_DIR = process.env.INTERN_ARTIFACT_DIR;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "intern-artifact-spine-"));
  origArtifactDir = process.env.INTERN_ARTIFACT_DIR;
  process.env.INTERN_ARTIFACT_DIR = tempRoot;
});

afterEach(async () => {
  const toRestore = origArtifactDir ?? MODULE_ORIG_ARTIFACT_DIR;
  try {
    if (toRestore === undefined) delete process.env.INTERN_ARTIFACT_DIR;
    else process.env.INTERN_ARTIFACT_DIR = toRestore;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function writeIncident(opts: {
  slug: string;
  title: string;
  createdAt: string;
  weak?: boolean;
  hypotheses?: number;
  evidenceCount?: number;
  corpusUsed?: { name: string; chunks_used: number } | null;
  dir?: string;
}): Promise<{ mdPath: string; jsonPath: string }> {
  const dir = opts.dir ?? join(tempRoot, "incident");
  await mkdir(dir, { recursive: true });
  const mdPath = join(dir, `${opts.slug}.md`);
  const jsonPath = join(dir, `${opts.slug}.json`);
  const hypotheses = Array.from({ length: opts.hypotheses ?? 2 }, (_, i) => ({
    hypothesis: `H${i}`, confidence: "medium", evidence_refs: ["e1"],
  }));
  const evidence = Array.from({ length: opts.evidenceCount ?? 3 }, (_, i) => ({
    id: `e${i + 1}`, kind: "log", ref: `log:${i + 1}-60`, excerpt: `chunk ${i}`,
  }));
  const artifact = {
    schema_version: 1,
    pack: "incident_pack",
    generated_at: opts.createdAt,
    hardware_profile: "dev-rtx5080",
    title: opts.title,
    slug: opts.slug,
    input: { has_log_text: true, source_paths: [], corpus: null, corpus_query: null },
    triage: null,
    brief: {
      root_cause_hypotheses: hypotheses,
      affected_surfaces: [{ surface: "x", evidence_refs: ["e1"] }],
      timeline_clues: [],
      next_checks: [],
      evidence,
      weak: opts.weak ?? false,
      coverage_notes: [],
      corpus_used: opts.corpusUsed ?? null,
    },
    steps: [],
    artifact: { markdown_path: mdPath, json_path: jsonPath },
  };
  await writeFile(mdPath, `# Incident — ${opts.title}\n`, "utf8");
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2), "utf8");
  return { mdPath, jsonPath };
}

async function writeRepo(opts: { slug: string; title: string; createdAt: string; dir?: string }): Promise<{ jsonPath: string }> {
  const dir = opts.dir ?? join(tempRoot, "repo");
  await mkdir(dir, { recursive: true });
  const mdPath = join(dir, `${opts.slug}.md`);
  const jsonPath = join(dir, `${opts.slug}.json`);
  const artifact = {
    schema_version: 1,
    pack: "repo_pack",
    generated_at: opts.createdAt,
    hardware_profile: "dev-rtx5080",
    title: opts.title,
    slug: opts.slug,
    input: { source_paths: [], corpus: null, corpus_query: null },
    brief: {
      repo_thesis: "T",
      key_surfaces: [{ surface: "s1", why: "w", evidence_refs: [] }, { surface: "s2", why: "w", evidence_refs: [] }],
      architecture_shape: "A",
      risk_areas: [{ risk: "r1", evidence_refs: [] }],
      read_next: [{ file: "f", why: "w" }],
      evidence: [{ id: "e1", kind: "path", ref: "/p", excerpt: "x" }],
      weak: false,
      coverage_notes: [],
      corpus_used: null,
    },
    extracted_facts: null,
    steps: [],
    artifact: { markdown_path: mdPath, json_path: jsonPath },
  };
  await writeFile(mdPath, "# repo md", "utf8");
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2), "utf8");
  return { jsonPath };
}

async function writeChange(opts: { slug: string; title: string; createdAt: string }): Promise<{ jsonPath: string }> {
  const dir = join(tempRoot, "change");
  await mkdir(dir, { recursive: true });
  const mdPath = join(dir, `${opts.slug}.md`);
  const jsonPath = join(dir, `${opts.slug}.json`);
  const artifact = {
    schema_version: 1,
    pack: "change_pack",
    generated_at: opts.createdAt,
    hardware_profile: "dev-rtx5080",
    title: opts.title,
    slug: opts.slug,
    input: { has_diff_text: true, has_log_text: false, source_paths: [], corpus: null, corpus_query: null },
    triage: null,
    brief: {
      change_summary: "s",
      affected_surfaces: [{ surface: "s1", evidence_refs: [] }],
      why_it_matters: "w",
      likely_breakpoints: [{ breakpoint: "b", evidence_refs: [] }, { breakpoint: "b2", evidence_refs: [] }],
      validation_checks: [{ check: "c", why: "" }],
      release_note_draft: "RN",
      evidence: [{ id: "e1", kind: "diff", ref: "diff:x", excerpt: "x" }, { id: "e2", kind: "diff", ref: "diff:y", excerpt: "y" }],
      weak: false,
      coverage_notes: [],
      corpus_used: null,
    },
    extracted_facts: null,
    steps: [],
    artifact: { markdown_path: mdPath, json_path: jsonPath },
  };
  await writeFile(mdPath, "# change md", "utf8");
  await writeFile(jsonPath, JSON.stringify(artifact, null, 2), "utf8");
  return { jsonPath };
}

// ── artifact_list ───────────────────────────────────────────

describe("handleArtifactList — metadata-only index", () => {
  it("returns one metadata record per artifact with pack-specific section_counts", async () => {
    await writeIncident({ slug: "2026-04-17-1400-inc", title: "Inc One", createdAt: "2026-04-17T14:00:00Z", hypotheses: 3, evidenceCount: 5 });
    await writeRepo({ slug: "2026-04-17-1500-repo", title: "Repo One", createdAt: "2026-04-17T15:00:00Z" });
    await writeChange({ slug: "2026-04-17-1600-chg", title: "Chg One", createdAt: "2026-04-17T16:00:00Z" });

    const env = await handleArtifactList({}, makeCtx());
    expect(env.result.items).toHaveLength(3);
    const inc = env.result.items.find((m) => m.pack === "incident_pack")!;
    expect(inc.evidence_count).toBe(5);
    expect(inc.section_counts.root_cause_hypotheses).toBe(3);
    const repo = env.result.items.find((m) => m.pack === "repo_pack")!;
    expect(repo.section_counts.key_surfaces).toBe(2);
    expect(repo.section_counts.risk_areas).toBe(1);
    const chg = env.result.items.find((m) => m.pack === "change_pack")!;
    expect(chg.section_counts.likely_breakpoints).toBe(2);
  });

  it("result items do NOT include full brief or payload", async () => {
    await writeIncident({ slug: "x", title: "X", createdAt: "2026-04-17T10:00:00Z" });
    const env = await handleArtifactList({}, makeCtx());
    const keys = Object.keys(env.result.items[0]).sort();
    // Exact metadata shape — nothing else leaks.
    expect(keys).toEqual([
      "corpus_used",
      "created_at",
      "evidence_count",
      "json_path",
      "md_path",
      "pack",
      "section_counts",
      "slug",
      "title",
      "weak",
    ]);
  });

  it("sorts newest first by default, then pack asc, then slug asc", async () => {
    await writeIncident({ slug: "a-old", title: "OLD", createdAt: "2026-04-10T00:00:00Z" });
    await writeIncident({ slug: "a-new", title: "NEW", createdAt: "2026-04-17T00:00:00Z" });
    await writeRepo({ slug: "b-new", title: "RNEW", createdAt: "2026-04-17T00:00:00Z" });
    const env = await handleArtifactList({}, makeCtx());
    // Newest first → the two 2026-04-17 entries, then the old one.
    expect(env.result.items[0].created_at).toBe("2026-04-17T00:00:00Z");
    expect(env.result.items[1].created_at).toBe("2026-04-17T00:00:00Z");
    expect(env.result.items[2].slug).toBe("a-old");
    // Tie-break on pack asc: change < incident < repo alphabetically.
    expect(env.result.items[0].pack).toBe("incident_pack");
    expect(env.result.items[1].pack).toBe("repo_pack");
  });

  it("filters by pack", async () => {
    await writeIncident({ slug: "i1", title: "I", createdAt: "2026-04-17T10:00:00Z" });
    await writeRepo({ slug: "r1", title: "R", createdAt: "2026-04-17T10:00:00Z" });
    const env = await handleArtifactList({ pack: "incident_pack" }, makeCtx());
    expect(env.result.items).toHaveLength(1);
    expect(env.result.items[0].pack).toBe("incident_pack");
  });

  it("filters by date_after / date_before (inclusive)", async () => {
    await writeIncident({ slug: "early", title: "E", createdAt: "2026-04-01T00:00:00Z" });
    await writeIncident({ slug: "mid", title: "M", createdAt: "2026-04-15T00:00:00Z" });
    await writeIncident({ slug: "late", title: "L", createdAt: "2026-04-30T00:00:00Z" });
    const env = await handleArtifactList(
      { date_after: "2026-04-10T00:00:00Z", date_before: "2026-04-20T00:00:00Z" },
      makeCtx(),
    );
    expect(env.result.items.map((m) => m.slug)).toEqual(["mid"]);
  });

  it("filters by weak_only / strong_only and rejects both-at-once", async () => {
    await writeIncident({ slug: "strong", title: "S", createdAt: "2026-04-17T10:00:00Z", weak: false });
    await writeIncident({ slug: "weak", title: "W", createdAt: "2026-04-17T11:00:00Z", weak: true });

    const weakOnly = await handleArtifactList({ weak_only: true }, makeCtx());
    expect(weakOnly.result.items.map((m) => m.slug)).toEqual(["weak"]);

    const strongOnly = await handleArtifactList({ strong_only: true }, makeCtx());
    expect(strongOnly.result.items.map((m) => m.slug)).toEqual(["strong"]);

    await expect(
      handleArtifactList({ weak_only: true, strong_only: true }, makeCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("reports total_matches BEFORE limit is applied", async () => {
    for (let i = 0; i < 5; i++) {
      await writeIncident({ slug: `x${i}`, title: `T${i}`, createdAt: `2026-04-${10 + i}T00:00:00Z` });
    }
    const env = await handleArtifactList({ limit: 2 }, makeCtx());
    expect(env.result.items).toHaveLength(2);
    expect(env.result.total_matches).toBe(5);
  });

  it("duplicate (pack, slug) across dirs surfaces in result.duplicates and as an envelope warning", async () => {
    const extraDir = join(tempRoot, "elsewhere", "incident");
    await writeIncident({ slug: "dup", title: "Canonical", createdAt: "2026-04-17T10:00:00Z" });
    await writeIncident({ slug: "dup", title: "Extra", createdAt: "2026-04-17T11:00:00Z", dir: extraDir });
    const env = await handleArtifactList(
      { extra_artifact_dirs: [extraDir] },
      makeCtx(),
    );
    // Both entries still returned — listing doesn't hide the truth.
    const dups = env.result.items.filter((m) => m.slug === "dup");
    expect(dups).toHaveLength(2);
    expect(env.result.duplicates).toHaveLength(1);
    expect(env.result.duplicates[0].paths).toHaveLength(2);
    expect(env.warnings?.[0]).toMatch(/slug collision/);
  });

  it("extra_artifact_dirs widens the search surface without shifting canonical identity", async () => {
    const extraDir = join(tempRoot, "elsewhere", "incident");
    await writeIncident({ slug: "out-of-tree", title: "X", createdAt: "2026-04-17T10:00:00Z", dir: extraDir });
    const envDefault = await handleArtifactList({}, makeCtx());
    expect(envDefault.result.items).toEqual([]);
    const envWithExtras = await handleArtifactList({ extra_artifact_dirs: [extraDir] }, makeCtx());
    expect(envWithExtras.result.items).toHaveLength(1);
    // The json_path is preserved verbatim from wherever it lived.
    expect(envWithExtras.result.items[0].json_path.startsWith(extraDir)).toBe(true);
  });

  it("silently skips malformed JSON files in artifact dirs", async () => {
    await writeIncident({ slug: "good", title: "G", createdAt: "2026-04-17T10:00:00Z" });
    // Plant a non-artifact file with the wrong shape in the incident dir.
    await writeFile(join(tempRoot, "incident", "not-an-artifact.json"), '{"hello": "world"}', "utf8");
    await writeFile(join(tempRoot, "incident", "broken.json"), "not json at all", "utf8");
    const env = await handleArtifactList({}, makeCtx());
    expect(env.result.items.map((m) => m.slug)).toEqual(["good"]);
  });
});

// ── artifact_read ───────────────────────────────────────────

describe("handleArtifactRead — typed read by identity or path", () => {
  it("reads by {pack, slug} and returns the full artifact + metadata", async () => {
    const { jsonPath } = await writeIncident({
      slug: "inc-read",
      title: "Read Me",
      createdAt: "2026-04-17T10:00:00Z",
    });
    const env = await handleArtifactRead(
      { pack: "incident_pack", slug: "inc-read" },
      makeCtx(),
    );
    expect(env.result.metadata.pack).toBe("incident_pack");
    expect(env.result.metadata.slug).toBe("inc-read");
    expect(env.result.artifact.pack).toBe("incident_pack");
    expect(env.result.artifact.slug).toBe("inc-read");
    // Discriminated union — type narrow by pack.
    if (env.result.artifact.pack === "incident_pack") {
      expect(env.result.artifact.brief.root_cause_hypotheses).toHaveLength(2);
    }
    // Sanity: the json_path matches.
    expect(env.result.metadata.json_path).toBe(jsonPath);
  });

  it("reads by {json_path} when the path is under a recognized artifact dir", async () => {
    const { jsonPath } = await writeIncident({
      slug: "inc-path",
      title: "P",
      createdAt: "2026-04-17T10:00:00Z",
    });
    const env = await handleArtifactRead({ json_path: jsonPath }, makeCtx());
    expect(env.result.metadata.slug).toBe("inc-path");
  });

  it("refuses {json_path} outside all recognized artifact dirs (path safety)", async () => {
    const badDir = await mkdtemp(join(tmpdir(), "intern-outside-"));
    const badPath = join(badDir, "sneaky.json");
    await writeFile(badPath, JSON.stringify({
      schema_version: 1, pack: "incident_pack", title: "X", slug: "X",
      generated_at: "2026-04-17T00:00:00Z", hardware_profile: "x",
      input: {}, triage: null,
      brief: { root_cause_hypotheses: [], affected_surfaces: [], timeline_clues: [], next_checks: [], evidence: [], weak: false, coverage_notes: [], corpus_used: null },
      steps: [], artifact: { markdown_path: "x", json_path: badPath },
    }), "utf8");
    try {
      await expect(
        handleArtifactRead({ json_path: badPath }, makeCtx()),
      ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    } finally {
      await rm(badDir, { recursive: true, force: true });
    }
  });

  it("accepts {json_path} under extra_artifact_dirs when explicitly allowed", async () => {
    const extraDir = await mkdtemp(join(tmpdir(), "intern-extra-"));
    const { jsonPath } = await writeIncident({
      slug: "inc-extra",
      title: "E",
      createdAt: "2026-04-17T10:00:00Z",
      dir: extraDir,
    });
    try {
      const env = await handleArtifactRead(
        { json_path: jsonPath, extra_artifact_dirs: [extraDir] },
        makeCtx(),
      );
      expect(env.result.metadata.slug).toBe("inc-extra");
    } finally {
      await rm(extraDir, { recursive: true, force: true });
    }
  });

  it("refuses {json_path} not ending in .json", async () => {
    const { jsonPath } = await writeIncident({
      slug: "inc-md",
      title: "M",
      createdAt: "2026-04-17T10:00:00Z",
    });
    const mdPath = jsonPath.replace(/\.json$/, ".md");
    await expect(
      handleArtifactRead({ json_path: mdPath }, makeCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects relative paths", async () => {
    await expect(
      handleArtifactRead({ json_path: "relative/path.json" }, makeCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects paths with parent traversal", async () => {
    // Use string concat to preserve the literal '..' segment — join() would
    // silently collapse it during construction, hiding the traversal attempt.
    const sneaky = `${tempRoot}/incident/../etc/passwd.json`;
    await expect(
      handleArtifactRead({ json_path: sneaky }, makeCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("fails loud on {pack, slug} collision rather than silently picking one", async () => {
    const extraDir = join(tempRoot, "elsewhere", "incident");
    await writeIncident({ slug: "dup", title: "A", createdAt: "2026-04-17T10:00:00Z" });
    await writeIncident({ slug: "dup", title: "B", createdAt: "2026-04-17T11:00:00Z", dir: extraDir });
    await expect(
      handleArtifactRead(
        { pack: "incident_pack", slug: "dup", extra_artifact_dirs: [extraDir] },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID", message: expect.stringContaining("Ambiguous") });
  });

  it("fails with SOURCE_PATH_NOT_FOUND on missing {pack, slug}", async () => {
    await expect(
      handleArtifactRead({ pack: "incident_pack", slug: "nope" }, makeCtx()),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });

  it("rejects calls with neither identity nor json_path", async () => {
    await expect(
      handleArtifactRead({}, makeCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects calls with both identity and json_path", async () => {
    const { jsonPath } = await writeIncident({
      slug: "x",
      title: "X",
      createdAt: "2026-04-17T10:00:00Z",
    });
    await expect(
      handleArtifactRead(
        { pack: "incident_pack", slug: "x", json_path: jsonPath },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects partial identity (pack without slug, or slug without pack)", async () => {
    await expect(
      handleArtifactRead({ pack: "incident_pack" }, makeCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
    await expect(
      handleArtifactRead({ slug: "x" }, makeCtx()),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("discriminates across all three pack payloads", async () => {
    await writeIncident({ slug: "inc", title: "I", createdAt: "2026-04-17T10:00:00Z" });
    await writeRepo({ slug: "repo", title: "R", createdAt: "2026-04-17T10:00:00Z" });
    await writeChange({ slug: "chg", title: "C", createdAt: "2026-04-17T10:00:00Z" });

    const i = await handleArtifactRead({ pack: "incident_pack", slug: "inc" }, makeCtx());
    const r = await handleArtifactRead({ pack: "repo_pack", slug: "repo" }, makeCtx());
    const c = await handleArtifactRead({ pack: "change_pack", slug: "chg" }, makeCtx());
    expect(i.result.artifact.pack).toBe("incident_pack");
    expect(r.result.artifact.pack).toBe("repo_pack");
    expect(c.result.artifact.pack).toBe("change_pack");
    // Payload keys differ per pack — they're not flattened.
    if (r.result.artifact.pack === "repo_pack") {
      expect(Object.keys(r.result.artifact.brief)).toContain("key_surfaces");
      expect(Object.keys(r.result.artifact.brief)).not.toContain("root_cause_hypotheses");
    }
  });
});
