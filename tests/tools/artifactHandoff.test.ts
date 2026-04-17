/**
 * Artifact Spine C tests — export + three snippet tools.
 *
 * Locks the handoff-surface contract:
 *
 *   artifact_export_to_path
 *     - reads EXISTING markdown, no re-render, no model call
 *     - prepends a provenance header (HTML comment) with identity
 *     - path safety: absolute, ends in .md, no '..' segments
 *     - target must live under caller-supplied allowed_roots
 *     - empty allowed_roots refused (no default write-anywhere)
 *     - overwrite is opt-in; default refuses existing files
 *
 *   snippet tools (pack-shaped, pure renderers)
 *     - render from existing artifact JSON only
 *     - return {rendered, metadata}; rendered stays clean
 *     - pack-scoped by tool: each resolves its own pack's namespace
 *     - weak flag surfaces visibly (banner / note)
 *     - release-note snippet preserves DRAFT framing via blockquote
 *       + caveat line
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleArtifactExportToPath } from "../../src/tools/artifactExportToPath.js";
import {
  handleArtifactIncidentNoteSnippet,
  handleArtifactOnboardingSectionSnippet,
  handleArtifactReleaseNoteSnippet,
} from "../../src/tools/artifactSnippets.js";
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

class NoModelClient implements OllamaClient {
  public generateCalls = 0;
  public embedCalls = 0;
  async generate(_: GenerateRequest): Promise<GenerateResponse> {
    this.generateCalls += 1;
    throw new Error("model should not be invoked in handoff tools");
  }
  async chat(_: ChatRequest): Promise<ChatResponse> {
    throw new Error("model should not be invoked in handoff tools");
  }
  async embed(_: EmbedRequest): Promise<EmbedResponse> {
    this.embedCalls += 1;
    throw new Error("embed should not be invoked in handoff tools");
  }
  async residency(_m: string): Promise<Residency | null> { return null; }
}

function makeCtx(client: OllamaClient = new NoModelClient()): RunContext & { logger: NullLogger } {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

let tempRoot: string;
let exportRoot: string;
let origArtifactDir: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "intern-handoff-src-"));
  exportRoot = await mkdtemp(join(tmpdir(), "intern-handoff-dst-"));
  origArtifactDir = process.env.INTERN_ARTIFACT_DIR;
  process.env.INTERN_ARTIFACT_DIR = tempRoot;
});

afterEach(async () => {
  if (origArtifactDir === undefined) delete process.env.INTERN_ARTIFACT_DIR;
  else process.env.INTERN_ARTIFACT_DIR = origArtifactDir;
  await rm(tempRoot, { recursive: true, force: true });
  await rm(exportRoot, { recursive: true, force: true });
});

async function writeArtifactPair(
  packDir: "incident" | "repo" | "change",
  pack: "incident_pack" | "repo_pack" | "change_pack",
  slug: string,
  payload: Record<string, unknown>,
  markdownBody: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  const dir = join(tempRoot, packDir);
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, `${slug}.json`);
  const mdPath = join(dir, `${slug}.md`);
  const full = {
    schema_version: 1,
    pack,
    title: payload.title ?? slug,
    slug,
    generated_at: "2026-04-17T10:00:00Z",
    hardware_profile: "dev-rtx5080",
    ...payload,
    artifact: { markdown_path: mdPath, json_path: jsonPath },
    steps: [],
  };
  await writeFile(jsonPath, JSON.stringify(full), "utf8");
  await writeFile(mdPath, markdownBody, "utf8");
  return { jsonPath, mdPath };
}

function incidentArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: { has_log_text: true, source_paths: [], corpus: null, corpus_query: null },
    triage: null,
    brief: {
      root_cause_hypotheses: [
        { hypothesis: "upstream dependency flaking", confidence: "high", evidence_refs: ["e1"] },
        { hypothesis: "network partition at edge", confidence: "medium", evidence_refs: ["e1"] },
      ],
      affected_surfaces: [{ surface: "checkout service", evidence_refs: ["e1"] }],
      timeline_clues: [{ clue: "retry storm at 14:52", evidence_refs: ["e1"] }],
      next_checks: [
        { check: "inspect upstream health dashboard", why: "confirm the dependency was degraded" },
        { check: "verify retry/backoff config", why: "see if storm was amplified" },
      ],
      evidence: [
        { id: "e1", kind: "log", ref: "log:1-60", excerpt: "ERROR: timeout" },
      ],
      weak: false,
      coverage_notes: [],
      corpus_used: null,
    },
    ...overrides,
  };
}

function repoArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: { source_paths: [], corpus: null, corpus_query: null },
    brief: {
      repo_thesis: "FoundryOS coordinates sprite production for JRPG pipelines.",
      key_surfaces: [
        { surface: "MCP tool spine", why: "138 tools drive the pipeline", evidence_refs: ["e1"] },
        { surface: "Godot export contract", why: "frozen interface", evidence_refs: ["e1"] },
      ],
      architecture_shape: "Single MCP server with file-backed stores.",
      risk_areas: [{ risk: "schema drift between MCP and Godot", evidence_refs: ["e1"] }],
      read_next: [
        { file: "src/export.ts", why: "Godot export contract" },
        { file: "README.md", why: "orientation" },
      ],
      evidence: [{ id: "e1", kind: "path", ref: "/repo/README.md", excerpt: "x" }],
      weak: false,
      coverage_notes: [],
      corpus_used: null,
    },
    extracted_facts: {
      package_names: ["@mcptoolshop/foundry"],
      entrypoints: [{ file: "src/index.ts", purpose: "MCP server entry" }],
      scripts: [{ name: "build", command: "tsc" }],
      config_files: ["tsconfig.json"],
      exposed_surfaces: ["MCP stdio"],
      runtime_hints: ["Node 18+", "TypeScript ES2022"],
    },
    ...overrides,
  };
}

function changeArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: { has_diff_text: true, has_log_text: false, source_paths: [], corpus: null, corpus_query: null },
    triage: null,
    brief: {
      change_summary: "Flipped default for auth session to signed tokens.",
      affected_surfaces: [{ surface: "AuthMiddleware", evidence_refs: ["e1"] }],
      why_it_matters: "Closes a replay vector.",
      likely_breakpoints: [{ breakpoint: "old-format session callers", evidence_refs: ["e1"] }],
      validation_checks: [{ check: "run auth integration suite", why: "covers the rename" }],
      release_note_draft: "Session tokens now signed by default.\nOld-format tokens remain valid through 2026-05-01.",
      evidence: [{ id: "e1", kind: "diff", ref: "diff:src/auth.ts", excerpt: "x" }],
      weak: false,
      coverage_notes: [],
      corpus_used: null,
    },
    extracted_facts: null,
    ...overrides,
  };
}

// ── artifact_export_to_path ────────────────────────────────

describe("handleArtifactExportToPath — handoff move", () => {
  it("writes the artifact's existing markdown with a provenance header prepended", async () => {
    const sourceMd = "# Incident — Checkout outage\n\nOriginal body text.\n";
    const { jsonPath } = await writeArtifactPair(
      "incident", "incident_pack", "inc-1",
      incidentArtifact(), sourceMd,
    );
    const target = join(exportRoot, "docs", "incident-note.md");
    const env = await handleArtifactExportToPath(
      {
        pack: "incident_pack",
        slug: "inc-1",
        target_path: target,
        allowed_roots: [exportRoot],
      },
      makeCtx(),
    );
    expect(env.result.target_path).toBe(target);
    expect(env.result.overwrote).toBe(false);
    expect(existsSync(target)).toBe(true);
    const written = await readFile(target, "utf8");
    // Provenance header first.
    expect(written.startsWith("<!--\nExported from ollama-intern artifact")).toBe(true);
    expect(written).toContain(`source_json:  ${jsonPath}`);
    expect(written).toContain("  pack:         incident_pack");
    expect(written).toContain("  slug:         inc-1");
    // Original markdown body preserved verbatim AFTER the header.
    expect(written).toContain(sourceMd);
  });

  it("rejects empty allowed_roots (no default write-anywhere)", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "md");
    const target = join(exportRoot, "x.md");
    await expect(
      handleArtifactExportToPath(
        { pack: "incident_pack", slug: "x", target_path: target, allowed_roots: [] },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects target_path that doesn't end in .md", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "md");
    await expect(
      handleArtifactExportToPath(
        {
          pack: "incident_pack",
          slug: "x",
          target_path: join(exportRoot, "x.txt"),
          allowed_roots: [exportRoot],
        },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects relative target_path", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "md");
    await expect(
      handleArtifactExportToPath(
        { pack: "incident_pack", slug: "x", target_path: "./out.md", allowed_roots: [exportRoot] },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects target_path with parent traversal even when it would collapse safely", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "md");
    // Use string concat so the '..' survives; join() would silently collapse it.
    const sneaky = `${exportRoot}/docs/../out.md`;
    await expect(
      handleArtifactExportToPath(
        { pack: "incident_pack", slug: "x", target_path: sneaky, allowed_roots: [exportRoot] },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
  });

  it("rejects target_path outside every allowed_root", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "md");
    const otherDir = await mkdtemp(join(tmpdir(), "intern-handoff-other-"));
    try {
      await expect(
        handleArtifactExportToPath(
          {
            pack: "incident_pack",
            slug: "x",
            target_path: join(otherDir, "x.md"),
            allowed_roots: [exportRoot],
          },
          makeCtx(),
        ),
      ).rejects.toMatchObject({ code: "SCHEMA_INVALID", message: expect.stringContaining("not under any allowed_root") });
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing file by default", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "# md\n");
    const target = join(exportRoot, "existing.md");
    await writeFile(target, "hand-edited content", "utf8");
    await expect(
      handleArtifactExportToPath(
        { pack: "incident_pack", slug: "x", target_path: target, allowed_roots: [exportRoot] },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID", message: expect.stringContaining("overwrite=false") });
    // Hand-edit preserved.
    expect(await readFile(target, "utf8")).toBe("hand-edited content");
  });

  it("replaces an existing file when overwrite: true and reports overwrote=true", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "# fresh\n");
    const target = join(exportRoot, "existing.md");
    await writeFile(target, "old content", "utf8");
    const env = await handleArtifactExportToPath(
      {
        pack: "incident_pack",
        slug: "x",
        target_path: target,
        allowed_roots: [exportRoot],
        overwrite: true,
      },
      makeCtx(),
    );
    expect(env.result.overwrote).toBe(true);
    const body = await readFile(target, "utf8");
    expect(body).toContain("# fresh");
    expect(body).not.toContain("old content");
  });

  it("refuses when target_path names an existing directory", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "md");
    const dir = join(exportRoot, "subdir.md");
    await mkdir(dir, { recursive: true });
    await expect(
      handleArtifactExportToPath(
        {
          pack: "incident_pack",
          slug: "x",
          target_path: dir,
          allowed_roots: [exportRoot],
          overwrite: true,
        },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "SCHEMA_INVALID", message: expect.stringContaining("directory") });
  });

  it("never invokes the model", async () => {
    await writeArtifactPair("incident", "incident_pack", "x", incidentArtifact(), "# md\n");
    const target = join(exportRoot, "o.md");
    const client = new NoModelClient();
    const env = await handleArtifactExportToPath(
      { pack: "incident_pack", slug: "x", target_path: target, allowed_roots: [exportRoot] },
      makeCtx(client),
    );
    expect(client.generateCalls).toBe(0);
    expect(client.embedCalls).toBe(0);
    expect(env.tokens_in).toBe(0);
  });

  it("result.provenance records pack, slug, created_at, source_json", async () => {
    const { jsonPath } = await writeArtifactPair(
      "repo", "repo_pack", "provenance-test",
      repoArtifact(), "# repo md\n",
    );
    const env = await handleArtifactExportToPath(
      {
        pack: "repo_pack",
        slug: "provenance-test",
        target_path: join(exportRoot, "repo.md"),
        allowed_roots: [exportRoot],
      },
      makeCtx(),
    );
    expect(env.result.provenance).toEqual({
      pack: "repo_pack",
      slug: "provenance-test",
      created_at: "2026-04-17T10:00:00Z",
      source_json_path: jsonPath,
    });
  });
});

// ── incident_note_snippet ──────────────────────────────────

describe("handleArtifactIncidentNoteSnippet — operator note fragment", () => {
  it("renders a compact note with hypotheses / surfaces / next checks", async () => {
    await writeArtifactPair("incident", "incident_pack", "inc", incidentArtifact(), "# md");
    const env = await handleArtifactIncidentNoteSnippet({ slug: "inc" }, makeCtx());
    const md = env.result.rendered;
    expect(md).toContain("# Incident:");
    expect(md).toContain("**Root cause (likely)**");
    expect(md).toContain("[high] upstream dependency flaking");
    expect(md).toContain("[medium] network partition at edge");
    expect(md).toContain("**Affected**");
    expect(md).toContain("- checkout service");
    expect(md).toContain("**Next checks**");
    expect(md).toContain("1. inspect upstream health dashboard");
    expect(md).toMatch(/_Source: incident_pack artifact `inc`/);
  });

  it("shows a weak banner when brief.weak is true", async () => {
    await writeArtifactPair(
      "incident", "incident_pack", "inc-weak",
      incidentArtifact({ brief: { ...(incidentArtifact().brief as object), weak: true } }),
      "# md",
    );
    const env = await handleArtifactIncidentNoteSnippet({ slug: "inc-weak" }, makeCtx());
    expect(env.result.rendered).toMatch(/Weak brief/);
  });

  it("metadata block is populated; rendered text stays clean", async () => {
    await writeArtifactPair("incident", "incident_pack", "inc", incidentArtifact(), "# md");
    const env = await handleArtifactIncidentNoteSnippet({ slug: "inc" }, makeCtx());
    expect(env.result.metadata.pack).toBe("incident_pack");
    expect(env.result.metadata.slug).toBe("inc");
    expect(env.result.metadata.section_counts.root_cause_hypotheses).toBe(2);
    // rendered shouldn't contain the metadata block verbatim — keep clean.
    expect(env.result.rendered).not.toContain("section_counts");
  });

  it("rejects slug that doesn't belong to an incident_pack artifact", async () => {
    await writeArtifactPair("repo", "repo_pack", "r1", repoArtifact(), "# md");
    await expect(
      handleArtifactIncidentNoteSnippet({ slug: "r1" }, makeCtx()),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });

  it("never invokes the model", async () => {
    await writeArtifactPair("incident", "incident_pack", "inc", incidentArtifact(), "# md");
    const client = new NoModelClient();
    await handleArtifactIncidentNoteSnippet({ slug: "inc" }, makeCtx(client));
    expect(client.generateCalls).toBe(0);
    expect(client.embedCalls).toBe(0);
  });
});

// ── onboarding_section_snippet ─────────────────────────────

describe("handleArtifactOnboardingSectionSnippet — handbook fragment", () => {
  it("renders `## What this repo is` with thesis, key surfaces, read next, runtime", async () => {
    await writeArtifactPair("repo", "repo_pack", "r1", repoArtifact(), "# md");
    const env = await handleArtifactOnboardingSectionSnippet({ slug: "r1" }, makeCtx());
    const md = env.result.rendered;
    expect(md).toContain("## What this repo is");
    expect(md).toContain("FoundryOS coordinates sprite production");
    expect(md).toContain("### Key surfaces");
    expect(md).toContain("- **MCP tool spine**");
    expect(md).toContain("### Read next");
    expect(md).toContain("`src/export.ts`");
    expect(md).toContain("### Runtime");
    expect(md).toContain("- Node 18+");
    expect(md).toMatch(/_Source: repo_pack artifact `r1`/);
  });

  it("omits Runtime section when extracted_facts is null", async () => {
    await writeArtifactPair(
      "repo", "repo_pack", "r-nofacts",
      repoArtifact({ extracted_facts: null }),
      "# md",
    );
    const env = await handleArtifactOnboardingSectionSnippet({ slug: "r-nofacts" }, makeCtx());
    expect(env.result.rendered).not.toContain("### Runtime");
  });

  it("shows weak banner when brief.weak is true", async () => {
    await writeArtifactPair(
      "repo", "repo_pack", "r-weak",
      repoArtifact({
        brief: { ...(repoArtifact().brief as Record<string, unknown>), weak: true },
      }),
      "# md",
    );
    const env = await handleArtifactOnboardingSectionSnippet({ slug: "r-weak" }, makeCtx());
    expect(env.result.rendered).toMatch(/Weak brief/);
  });

  it("never invokes the model", async () => {
    await writeArtifactPair("repo", "repo_pack", "r1", repoArtifact(), "# md");
    const client = new NoModelClient();
    await handleArtifactOnboardingSectionSnippet({ slug: "r1" }, makeCtx(client));
    expect(client.generateCalls).toBe(0);
    expect(client.embedCalls).toBe(0);
  });
});

// ── release_note_snippet ───────────────────────────────────

describe("handleArtifactReleaseNoteSnippet — DRAFT fragment", () => {
  it("wraps each line of the draft as a blockquote with the DRAFT caveat preserved", async () => {
    await writeArtifactPair("change", "change_pack", "c1", changeArtifact(), "# md");
    const env = await handleArtifactReleaseNoteSnippet({ slug: "c1" }, makeCtx());
    const md = env.result.rendered;
    expect(md).toMatch(/^> Session tokens now signed by default\.$/m);
    expect(md).toMatch(/^> Old-format tokens remain valid through 2026-05-01\.$/m);
    expect(md).toContain("_Draft — the operator reviews before publishing._");
    expect(md).toMatch(/_Source: change_pack artifact `c1`/);
  });

  it("renders a clear empty-draft marker when draft is empty", async () => {
    await writeArtifactPair(
      "change", "change_pack", "c-empty",
      changeArtifact({
        brief: { ...(changeArtifact().brief as Record<string, unknown>), release_note_draft: "" },
      }),
      "# md",
    );
    const env = await handleArtifactReleaseNoteSnippet({ slug: "c-empty" }, makeCtx());
    expect(env.result.rendered).toContain("_No release note draft was produced for this change._");
  });

  it("rejects slug that doesn't belong to a change_pack artifact", async () => {
    await writeArtifactPair("incident", "incident_pack", "notchange", incidentArtifact(), "# md");
    await expect(
      handleArtifactReleaseNoteSnippet({ slug: "notchange" }, makeCtx()),
    ).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_FOUND" });
  });

  it("never invokes the model", async () => {
    await writeArtifactPair("change", "change_pack", "c1", changeArtifact(), "# md");
    const client = new NoModelClient();
    await handleArtifactReleaseNoteSnippet({ slug: "c1" }, makeCtx(client));
    expect(client.generateCalls).toBe(0);
    expect(client.embedCalls).toBe(0);
  });
});

// ── End-to-end: export + snippet produce distinct artifacts ────

describe("handoff integration", () => {
  it("export and snippet tools produce independent outputs from the same artifact", async () => {
    const { mdPath } = await writeArtifactPair(
      "incident", "incident_pack", "combo",
      incidentArtifact(),
      "# Full incident markdown\n\nMany sections here.\n",
    );

    const exported = await handleArtifactExportToPath(
      {
        pack: "incident_pack",
        slug: "combo",
        target_path: join(exportRoot, "combo.md"),
        allowed_roots: [exportRoot],
      },
      makeCtx(),
    );
    const snippet = await handleArtifactIncidentNoteSnippet(
      { slug: "combo" },
      makeCtx(),
    );

    // Export is the full markdown + provenance — not the snippet.
    const exportedBody = await readFile(exported.result.target_path, "utf8");
    expect(exportedBody).toContain("# Full incident markdown");
    expect(exportedBody).toContain("Exported from ollama-intern artifact");

    // Snippet is a compact fragment — not the full markdown.
    expect(snippet.result.rendered).not.toContain("Many sections here.");
    expect(snippet.result.rendered).toContain("**Root cause (likely)**");

    // Source artifact md file unchanged.
    const sourceStat = await stat(mdPath);
    expect(sourceStat.isFile()).toBe(true);
  });
});
