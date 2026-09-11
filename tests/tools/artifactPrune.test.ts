/**
 * ollama_artifact_prune tests — dry-run default, filters, real delete.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, utimes, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleArtifactPrune } from "../../src/tools/artifactPrune.js";
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

class QuietClient implements OllamaClient {
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> { throw new Error("n/a"); }
  async residency(_m: string): Promise<Residency | null> { return null; }
  async probe(_ms?: number): Promise<{ ok: boolean; reason?: string }> { return { ok: true }; }
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
const MODULE_ORIG = process.env.INTERN_ARTIFACT_DIR;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "intern-prune-"));
  origArtifactDir = process.env.INTERN_ARTIFACT_DIR;
  process.env.INTERN_ARTIFACT_DIR = tempRoot;
});

afterEach(async () => {
  const toRestore = origArtifactDir ?? MODULE_ORIG;
  try {
    if (toRestore === undefined) delete process.env.INTERN_ARTIFACT_DIR;
    else process.env.INTERN_ARTIFACT_DIR = toRestore;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function writeArtifact(
  pack: "incident" | "change" | "repo",
  slug: string,
  ageDays: number,
): Promise<{ json: string; md: string }> {
  const dir = join(tempRoot, pack);
  await mkdir(dir, { recursive: true });
  const json = join(dir, `${slug}.json`);
  const md = join(dir, `${slug}.md`);
  // A REAL pack artifact shape (what the pack tools write) so metadataFromArtifact
  // recognizes it — the M6 shape gate skips anything that doesn't.
  await writeFile(
    json,
    JSON.stringify({
      pack: `${pack}_pack`,
      slug,
      title: `${slug} title`,
      generated_at: new Date().toISOString(),
      artifact: { markdown_path: md, json_path: json },
      brief: {},
    }),
    "utf8",
  );
  await writeFile(md, `# ${slug}`, "utf8");
  // Backdate mtime so age filters exercise properly.
  const ageMs = ageDays * 24 * 60 * 60 * 1000;
  const when = new Date(Date.now() - ageMs);
  await utimes(json, when, when);
  await utimes(md, when, when);
  return { json, md };
}

describe("ollama_artifact_prune", () => {
  it("defaults to dry_run — no files deleted, reports matches", async () => {
    await writeArtifact("incident", "a", 0);
    await writeArtifact("repo", "b", 0);
    const env = await handleArtifactPrune({}, makeCtx());
    expect(env.result.dry_run).toBe(true);
    expect(env.result.deleted).toBe(false);
    expect(env.result.total_matched).toBe(2);
    // Files still exist.
    const incidentFiles = await readdir(join(tempRoot, "incident"));
    expect(incidentFiles.sort()).toEqual(["a.json", "a.md"]);
    expect(env.warnings?.some((w) => w.toLowerCase().includes("dry run")), `env.warnings = ${JSON.stringify(env.warnings)}`).toBe(true);
  });

  it("filters by older_than_days", async () => {
    await writeArtifact("incident", "fresh", 1);
    await writeArtifact("incident", "old", 30);
    const env = await handleArtifactPrune({ older_than_days: 14 }, makeCtx());
    expect(env.result.matched.length).toBe(1);
    expect(env.result.matched[0].slug).toBe("old");
  });

  it("filters by pack_type", async () => {
    await writeArtifact("incident", "i", 5);
    await writeArtifact("repo", "r", 5);
    await writeArtifact("change", "c", 5);
    const env = await handleArtifactPrune({ pack_type: "incident" }, makeCtx());
    expect(env.result.matched.length).toBe(1);
    expect(env.result.matched[0].pack).toBe("incident");
  });

  it("actually deletes when dry_run: false", async () => {
    const { json, md } = await writeArtifact("incident", "zap", 5);
    expect(existsSync(json)).toBe(true);
    expect(existsSync(md)).toBe(true);
    const env = await handleArtifactPrune({ dry_run: false }, makeCtx());
    expect(env.result.deleted).toBe(true);
    expect(env.result.total_matched).toBe(1);
    expect(existsSync(json)).toBe(false);
    expect(existsSync(md)).toBe(false);
  });

  it("handles missing artifact dirs gracefully (no matches, no throw)", async () => {
    // tempRoot has no subdirs.
    const env = await handleArtifactPrune({ pack_type: "all" }, makeCtx());
    expect(env.result.total_matched).toBe(0);
    expect(env.result.dry_run).toBe(true);
  });

  it("only deletes real pack artifacts — a foreign json+md pair survives and is reported skipped (M6)", async () => {
    const real = await writeArtifact("incident", "real", 5);
    const foreign = await writeForeign("incident", "notes");

    const env = await handleArtifactPrune({ dry_run: false }, makeCtx());

    // The real artifact is deleted (both files).
    expect(existsSync(real.json)).toBe(false);
    expect(existsSync(real.md)).toBe(false);
    // The hand-parked foreign pair survives untouched.
    expect(existsSync(foreign.json)).toBe(true);
    expect(existsSync(foreign.md)).toBe(true);
    // Only the real artifact matched; the foreign json is reported skipped.
    expect(env.result.total_matched).toBe(1);
    expect(env.result.matched[0].slug).toBe("real");
    expect(env.result.skipped.some((s) => s.path === foreign.json)).toBe(true);
  });
});

/** A non-artifact json + md pair a user or another tool parked in an artifact dir. */
async function writeForeign(
  pack: "incident" | "change" | "repo",
  name: string,
): Promise<{ json: string; md: string }> {
  const dir = join(tempRoot, pack);
  await mkdir(dir, { recursive: true });
  const json = join(dir, `${name}.json`);
  const md = join(dir, `${name}.md`);
  // No `pack` field — not a pack artifact shape at all.
  await writeFile(json, JSON.stringify({ note: "hand-written triage notes", items: [1, 2, 3] }), "utf8");
  await writeFile(md, `# ${name} notes`, "utf8");
  return { json, md };
}
