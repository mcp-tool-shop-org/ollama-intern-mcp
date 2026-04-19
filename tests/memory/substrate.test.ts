import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { memoryId, contentDigest } from "../../src/memory/ids.js";
import {
  normalizeSkillReceipt,
  normalizePackArtifact,
  normalizeSkill,
  normalizeCandidateProposal,
} from "../../src/memory/normalizers.js";
import { loadIndex } from "../../src/memory/store.js";
import { refreshMemory } from "../../src/memory/refresh.js";
import type { SkillReceipt, LoadedSkill } from "../../src/skills/types.js";
import type { ArtifactMetadata } from "../../src/tools/artifacts/scan.js";
import type { NewSkillProposal } from "../../src/skills/newSkillProposer.js";

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), "memory-test-")); }

describe("memory/ids", () => {
  it("memoryId is deterministic and kind-prefixed", () => {
    const a = memoryId("skill_receipt", "abc");
    const b = memoryId("skill_receipt", "abc");
    expect(a).toBe(b);
    expect(a.startsWith("skill_receipt:")).toBe(true);
  });

  it("different kinds with same identity produce different ids", () => {
    expect(memoryId("skill_receipt", "abc")).not.toBe(memoryId("pack_artifact", "abc"));
  });

  it("contentDigest stable across tag and facet key ordering", () => {
    const a = contentDigest({ title: "t", summary: "s", tags: ["b", "a"], facets: { y: 1, x: 2 } });
    const b = contentDigest({ title: "t", summary: "s", tags: ["a", "b"], facets: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });

  it("contentDigest changes on any field change", () => {
    const base = contentDigest({ title: "t", summary: "s", tags: ["a"], facets: {} });
    expect(contentDigest({ title: "different", summary: "s", tags: ["a"], facets: {} })).not.toBe(base);
    expect(contentDigest({ title: "t", summary: "different", tags: ["a"], facets: {} })).not.toBe(base);
    expect(contentDigest({ title: "t", summary: "s", tags: ["different"], facets: {} })).not.toBe(base);
    expect(contentDigest({ title: "t", summary: "s", tags: ["a"], facets: { x: 1 } })).not.toBe(base);
  });
});

describe("memory/normalizers", () => {
  const now = "2026-04-18T20:00:00.000Z";

  it("normalizeSkillReceipt produces shape-correct record", () => {
    const r: SkillReceipt = {
      skill_id: "triage-then-brief",
      skill_version: 2,
      skill_source_path: "/tmp/s.json",
      started_at: "2026-04-18T10:00:00Z",
      elapsed_ms: 48000,
      hardware_profile: "dev-rtx5080",
      inputs: {},
      steps: [
        { step_id: "a", tool: "ollama_triage_logs", ok: true, elapsed_ms: 6000, envelope: { tokens_in: 100, tokens_out: 50 } },
        { step_id: "b", tool: "ollama_incident_brief", ok: true, elapsed_ms: 42000, envelope: { tokens_in: 200, tokens_out: 300 } },
      ],
      result: { x: 1 },
      ok: true,
      receipt_path: "/tmp/r.json",
    };
    const mem = normalizeSkillReceipt(r, now);
    expect(mem.kind).toBe("skill_receipt");
    expect(mem.title).toMatch(/triage-then-brief v2/);
    expect(mem.facets.skill_id).toBe("triage-then-brief");
    expect(mem.facets.ok).toBe(true);
    expect(mem.facets.tokens_in_total).toBe(300);
    expect(mem.facets.tokens_out_total).toBe(350);
    expect(mem.tags).toContain("skill:triage-then-brief");
    expect(mem.tags).toContain("outcome:ok");
    expect(mem.tags).toContain("tool:ollama_triage_logs");
    expect(mem.provenance.ref).toBe("triage-then-brief|2026-04-18T10:00:00Z");
    expect(mem.content_digest).toHaveLength(64);
  });

  it("normalizeSkillReceipt captures failure reason in the summary", () => {
    const r: SkillReceipt = {
      skill_id: "x",
      skill_version: 1,
      skill_source_path: "/tmp/s.json",
      started_at: "2026-04-18T10:00:00Z",
      elapsed_ms: 15000,
      hardware_profile: "dev-rtx5080",
      inputs: {},
      steps: [
        { step_id: "triage", tool: "ollama_triage_logs", ok: false, elapsed_ms: 15000, error: { code: "TIER_TIMEOUT", message: "m", hint: "h" } },
      ],
      result: null,
      ok: false,
      receipt_path: "/tmp/r.json",
    };
    const mem = normalizeSkillReceipt(r, now);
    expect(mem.summary).toContain("failed at triage");
    expect(mem.summary).toContain("TIER_TIMEOUT");
    expect(mem.tags).toContain("outcome:failed");
  });

  it("normalizePackArtifact pulls identity from (pack, slug)", () => {
    const meta: ArtifactMetadata = {
      pack: "incident_pack",
      slug: "deadlock-2026-04-18",
      title: "Deadlock on db-primary-01",
      created_at: "2026-04-18T09:15:00Z",
      weak: false,
      corpus_used: { name: "memory", chunks_used: 4 },
      evidence_count: 8,
      section_counts: { root_cause_hypotheses: 3, next_checks: 4 },
      md_path: "/tmp/a.md",
      json_path: "/tmp/a.json",
    };
    const mem = normalizePackArtifact(meta, now);
    expect(mem.kind).toBe("pack_artifact");
    expect(mem.provenance.ref).toBe("incident_pack:deadlock-2026-04-18");
    expect(mem.facets.pack).toBe("incident_pack");
    expect(mem.facets.weak).toBe(false);
    expect(mem.facets.corpus_used).toBe("memory");
    expect(mem.tags).toContain("pack:incident_pack");
    expect(mem.tags).toContain("corpus:memory");
  });

  it("normalizeSkill distinguishes scope + status", () => {
    const loaded: LoadedSkill = {
      scope: "project",
      source_path: "/tmp/s.json",
      skill: {
        id: "triage-then-brief",
        name: "Triage then brief",
        description: "Test skill.",
        version: 2,
        status: "approved",
        trigger: { keywords: ["incident", "triage"], input_shape: {} },
        pipeline: [
          { id: "a", tool: "ollama_triage_logs", inputs: {} },
          { id: "b", tool: "ollama_incident_brief", inputs: {} },
        ],
        result_from: "b",
        provenance: { created_at: "2026-04-01T00:00:00Z", source: "hand_authored", runs: 3, promotion_history: [] },
      },
    };
    const mem = normalizeSkill(loaded, now);
    expect(mem.kind).toBe("approved_skill");
    expect(mem.facets.status).toBe("approved");
    expect(mem.facets.scope).toBe("project");
    expect(mem.facets.runs).toBe(3);
    expect(mem.tags).toContain("scope:project");
    expect(mem.tags).toContain("status:approved");
    expect(mem.tags).toContain("keyword:incident");
  });

  it("normalizeCandidateProposal records support + shape agreement", () => {
    const p: NewSkillProposal = {
      suggested_id: "research-then-extract-then-draft",
      suggested_name: "research, extract, then draft",
      description: "Detected recurring workflow.",
      pipeline_tools: ["ollama_research", "ollama_extract", "ollama_draft"],
      first_step_shape: {},
      evidence: { support: 4, success_rate: 1, avg_duration_ms: 20000, shape_agreement: 1, examples: [] },
    };
    const mem = normalizeCandidateProposal(p, "/tmp/log.ndjson", now);
    expect(mem.kind).toBe("candidate_proposal");
    expect(mem.facets.support).toBe(4);
    expect(mem.facets.shape_agreement).toBe(1);
    expect(mem.tags).toContain("candidate");
    expect(mem.tags).toContain("support:4");
    expect(mem.provenance.ref).toBe("ollama_research→ollama_extract→ollama_draft");
  });
});

describe("memory/refresh integration", () => {
  let memDir: string;
  let artifactDir: string;
  let receiptsDir: string;
  let skillsDir: string;
  let globalSkillsDir: string;
  let logPath: string;
  let prevEnv: { memory?: string; artifact?: string; log?: string };

  beforeEach(async () => {
    memDir = tmp();
    artifactDir = tmp();
    receiptsDir = tmp();
    skillsDir = tmp();
    globalSkillsDir = tmp();
    logPath = path.join(tmp(), "log.ndjson");
    prevEnv = {
      memory: process.env.INTERN_MEMORY_DIR,
      artifact: process.env.INTERN_ARTIFACT_DIR,
      log: process.env.INTERN_LOG_PATH,
    };
    process.env.INTERN_MEMORY_DIR = memDir;
    process.env.INTERN_ARTIFACT_DIR = artifactDir;
    process.env.INTERN_LOG_PATH = logPath;

    // Seed one skill file
    await fs.writeFile(
      path.join(skillsDir, "triage-then-brief.json"),
      JSON.stringify({
        id: "triage-then-brief",
        name: "Triage then brief",
        description: "d",
        version: 2,
        status: "approved",
        trigger: { keywords: ["triage"], input_shape: {} },
        pipeline: [{ id: "a", tool: "ollama_triage_logs", inputs: {} }],
        result_from: "a",
        provenance: { created_at: "2026-04-18T00:00:00Z", source: "hand_authored", runs: 0, promotion_history: [] },
      }, null, 2),
      "utf8",
    );

    // Seed one receipt
    await fs.writeFile(
      path.join(receiptsDir, "triage-then-brief_2026-04-18T20-30.json"),
      JSON.stringify({
        skill_id: "triage-then-brief",
        skill_version: 2,
        skill_source_path: path.join(skillsDir, "triage-then-brief.json"),
        started_at: "2026-04-18T20:30:00Z",
        elapsed_ms: 4000,
        hardware_profile: "dev-rtx5080",
        inputs: {},
        steps: [{ step_id: "a", tool: "ollama_triage_logs", ok: true, elapsed_ms: 4000, envelope: { tokens_in: 100, tokens_out: 50 } }],
        result: { x: 1 },
        ok: true,
        receipt_path: "will-be-overwritten",
      } satisfies SkillReceipt, null, 2),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(memDir, { recursive: true, force: true });
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(receiptsDir, { recursive: true, force: true });
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(globalSkillsDir, { recursive: true, force: true });
    rmSync(path.dirname(logPath), { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      const envKey = k === "memory" ? "INTERN_MEMORY_DIR" : k === "artifact" ? "INTERN_ARTIFACT_DIR" : "INTERN_LOG_PATH";
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  });

  it("first refresh writes the index and reports added records", async () => {
    const result = await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
    });
    expect(result.drift.added_count).toBe(2); // 1 skill + 1 receipt
    expect(result.drift.updated_count).toBe(0);
    expect(result.drift.removed_count).toBe(0);
    expect(result.total_records).toBe(2);
    expect(result.per_kind_counts.approved_skill).toBe(1);
    expect(result.per_kind_counts.skill_receipt).toBe(1);
    expect(result.per_kind_counts.pack_artifact).toBe(0);
    expect(result.per_kind_counts.candidate_proposal).toBe(0);

    const index = await loadIndex();
    expect(index.records).toHaveLength(2);
    expect(index.schema_version).toBe(1);
  });

  it("second refresh with no changes reports zero drift", async () => {
    await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
    });
    const second = await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
    });
    expect(second.drift.added_count).toBe(0);
    expect(second.drift.updated_count).toBe(0);
    expect(second.drift.removed_count).toBe(0);
    expect(second.drift.unchanged_count).toBe(2);
  });

  it("detects updated records when source content changes", async () => {
    await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
    });
    // Mutate the skill's description
    const skillFile = path.join(skillsDir, "triage-then-brief.json");
    const skill = JSON.parse(await fs.readFile(skillFile, "utf8"));
    skill.description = "updated description";
    await fs.writeFile(skillFile, JSON.stringify(skill, null, 2), "utf8");

    const result = await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
    });
    expect(result.drift.updated_count).toBe(1);
    expect(result.drift.added_count).toBe(0);
    expect(result.drift.unchanged_count).toBe(1);
  });

  it("detects removed records when the source file is deleted", async () => {
    await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
    });
    await fs.rm(path.join(skillsDir, "triage-then-brief.json"));
    const result = await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
    });
    expect(result.drift.removed_count).toBe(1);
    expect(result.drift.unchanged_count).toBe(1);
  });

  it("dry_run reports drift but does not write the index", async () => {
    const result = await refreshMemory({
      receiptsDir,
      skillStoreOptions: { globalDir: globalSkillsDir, projectDir: skillsDir },
      skip_candidates: true,
      dryRun: true,
    });
    expect(result.dry_run).toBe(true);
    expect(result.drift.added_count).toBe(2);
    const index = await loadIndex();
    expect(index.records).toHaveLength(0);
  });
});
