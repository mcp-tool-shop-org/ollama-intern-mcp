import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadReceipts, aggregateStats } from "../../src/skills/traces.js";
import { proposeAll, DEFAULT_THRESHOLDS } from "../../src/skills/proposer.js";
import { promoteSkill, canTransition } from "../../src/skills/promoter.js";
import type { LoadedSkill, SkillReceipt } from "../../src/skills/types.js";

function tmpdir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "learning-test-"));
}

function receipt(overrides: Partial<SkillReceipt>): SkillReceipt {
  return {
    skill_id: "test",
    skill_version: 1,
    skill_source_path: "unused.json",
    started_at: "2026-04-18T10:00:00.000Z",
    elapsed_ms: 1000,
    hardware_profile: "dev-rtx5080",
    inputs: {},
    steps: [],
    result: null,
    ok: true,
    receipt_path: "unused-receipt.json",
    ...overrides,
  };
}

async function writeReceipt(dir: string, name: string, r: SkillReceipt): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name + ".json"), JSON.stringify(r, null, 2), "utf8");
}

function loaded(id: string, status: LoadedSkill["skill"]["status"], sourcePath: string): LoadedSkill {
  return {
    scope: "project",
    source_path: sourcePath,
    skill: {
      id,
      name: id,
      description: "desc",
      version: 1,
      status,
      trigger: { keywords: [], input_shape: {} },
      pipeline: [{ id: "x", tool: "ollama_classify", inputs: {} }],
      result_from: "x",
      provenance: { created_at: "2026-04-01T00:00:00Z", source: "hand_authored", runs: 0, promotion_history: [] },
    },
  };
}

describe("skills/traces", () => {
  let dir: string;
  beforeEach(() => { dir = tmpdir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("loads + sorts receipts by started_at", async () => {
    await writeReceipt(dir, "b", receipt({ skill_id: "x", started_at: "2026-04-18T10:01:00Z" }));
    await writeReceipt(dir, "a", receipt({ skill_id: "x", started_at: "2026-04-18T10:00:00Z" }));
    const all = await loadReceipts({ receiptsDir: dir });
    expect(all.map((r) => r.started_at)).toEqual(["2026-04-18T10:00:00Z", "2026-04-18T10:01:00Z"]);
  });

  it("filters by skill_id and since", async () => {
    await writeReceipt(dir, "old", receipt({ skill_id: "a", started_at: "2026-04-17T00:00:00Z" }));
    await writeReceipt(dir, "new_a", receipt({ skill_id: "a", started_at: "2026-04-18T00:00:00Z" }));
    await writeReceipt(dir, "new_b", receipt({ skill_id: "b", started_at: "2026-04-18T00:00:00Z" }));
    const filtered = await loadReceipts({ receiptsDir: dir, skill_id: "a", since: "2026-04-18T00:00:00Z" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].skill_id).toBe("a");
  });

  it("aggregateStats computes success_rate, median elapsed, and failure profile", () => {
    const stats = aggregateStats([
      receipt({ skill_id: "x", ok: true, elapsed_ms: 1000, steps: [
        { step_id: "s", tool: "ollama_classify", ok: true, elapsed_ms: 1000, envelope: { tokens_in: 100, tokens_out: 10 } },
      ] }),
      receipt({ skill_id: "x", ok: false, elapsed_ms: 2000, steps: [
        { step_id: "s", tool: "ollama_classify", ok: false, elapsed_ms: 2000, error: { code: "TIER_TIMEOUT", message: "m", hint: "h" } },
      ] }),
      receipt({ skill_id: "x", ok: false, elapsed_ms: 3000, steps: [
        { step_id: "s", tool: "ollama_classify", ok: false, elapsed_ms: 3000, error: { code: "TIER_TIMEOUT", message: "m", hint: "h" } },
      ] }),
    ]);
    expect(stats).toHaveLength(1);
    const x = stats[0];
    expect(x.run_count).toBe(3);
    expect(x.success_count).toBe(1);
    expect(x.failure_count).toBe(2);
    expect(x.success_rate).toBeCloseTo(1 / 3, 5);
    expect(x.median_elapsed_ms).toBe(2000);
    expect(x.total_tokens_in).toBe(100);
    expect(x.failure_profile).toHaveLength(1);
    expect(x.failure_profile[0].tool).toBe("ollama_classify");
    expect(x.failure_profile[0].top_error_code).toBe("TIER_TIMEOUT");
    expect(x.failure_profile[0].failure_count).toBe(2);
  });
});

describe("skills/proposer", () => {
  const now = "2026-04-18T12:00:00Z";

  it("proposes promote when draft skill succeeds ≥80% over ≥3 runs", () => {
    const skill = loaded("s", "draft", "/tmp/s.json");
    const stats = aggregateStats([
      receipt({ skill_id: "s", ok: true }),
      receipt({ skill_id: "s", ok: true }),
      receipt({ skill_id: "s", ok: true }),
      receipt({ skill_id: "s", ok: true }),
    ]);
    const proposals = proposeAll([skill], stats, now);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe("promote");
    expect(proposals[0].suggested_status).toBe("candidate");
  });

  it("proposes revise when a single step dominates failures", () => {
    const skill = loaded("s", "approved", "/tmp/s.json");
    const fail = (code: string): SkillReceipt =>
      receipt({
        skill_id: "s",
        ok: false,
        steps: [{ step_id: "brief", tool: "ollama_incident_brief", ok: false, elapsed_ms: 10, error: { code, message: "m", hint: "h" } }],
      });
    const stats = aggregateStats([fail("SCHEMA_INVALID"), fail("SCHEMA_INVALID"), fail("SCHEMA_INVALID")]);
    const proposals = proposeAll([skill], stats, now);
    const revise = proposals.find((p) => p.kind === "revise");
    expect(revise).toBeDefined();
    expect(revise?.evidence.dominant_failure?.step_id).toBe("brief");
    expect(revise?.evidence.dominant_failure?.error_code).toBe("SCHEMA_INVALID");
  });

  it("proposes deprecate when approved skill has low success rate", () => {
    const skill = loaded("s", "approved", "/tmp/s.json");
    const stats = aggregateStats([
      receipt({ skill_id: "s", ok: false }),
      receipt({ skill_id: "s", ok: false }),
      receipt({ skill_id: "s", ok: false }),
      receipt({ skill_id: "s", ok: true }),
    ]);
    const proposals = proposeAll([skill], stats, now);
    const deprecate = proposals.find((p) => p.kind === "deprecate");
    expect(deprecate).toBeDefined();
    expect(deprecate?.suggested_status).toBe("deprecated");
  });

  it("proposes deprecate when approved skill is idle beyond threshold", () => {
    const skill = loaded("s", "approved", "/tmp/s.json");
    const stats = aggregateStats([
      receipt({ skill_id: "s", ok: true, started_at: "2026-02-01T00:00:00Z" }),
    ]);
    const proposals = proposeAll([skill], stats, "2026-04-18T00:00:00Z");
    const deprecate = proposals.find((p) => p.kind === "deprecate");
    expect(deprecate).toBeDefined();
    expect(deprecate?.evidence.idle_days).toBeGreaterThanOrEqual(30);
  });

  it("does not propose anything for skills with no runs", () => {
    const skill = loaded("s", "draft", "/tmp/s.json");
    expect(proposeAll([skill], [], now)).toEqual([]);
  });

  it("respects overridden thresholds", () => {
    const skill = loaded("s", "draft", "/tmp/s.json");
    const stats = aggregateStats([
      receipt({ skill_id: "s", ok: true }),
      receipt({ skill_id: "s", ok: true }),
    ]);
    const strict = { ...DEFAULT_THRESHOLDS, min_runs_for_lifecycle: 10 };
    expect(proposeAll([skill], stats, now, strict)).toEqual([]);
    const loose = { ...DEFAULT_THRESHOLDS, min_runs_for_lifecycle: 2 };
    expect(proposeAll([skill], stats, now, loose).some((p) => p.kind === "promote")).toBe(true);
  });
});

describe("skills/promoter", () => {
  it("canTransition enforces the lifecycle graph", () => {
    expect(canTransition("draft", "candidate")).toBe(true);
    expect(canTransition("candidate", "approved")).toBe(true);
    expect(canTransition("approved", "deprecated")).toBe(true);
    expect(canTransition("approved", "draft")).toBe(false);
    expect(canTransition("draft", "draft")).toBe(false);
  });

  it("promoteSkill rewrites the file, appends promotion_history, keeps other fields", async () => {
    const dir = tmpdir();
    try {
      const file = path.join(dir, "s.json");
      const original = {
        id: "s",
        name: "S",
        description: "d",
        version: 1,
        status: "draft",
        trigger: { keywords: ["a"], input_shape: {} },
        pipeline: [{ id: "x", tool: "ollama_classify", inputs: { text: "hi", labels: ["a", "b"] } }],
        result_from: "x",
        provenance: { created_at: "2026-04-01T00:00:00Z", source: "hand_authored", runs: 0, promotion_history: [] },
      };
      await fs.writeFile(file, JSON.stringify(original, null, 2), "utf8");
      const loadedSkill: LoadedSkill = { scope: "project", source_path: file, skill: original as unknown as LoadedSkill["skill"] };
      const out = await promoteSkill(loadedSkill, { target: "candidate", reason: "3 successful runs", at: "2026-04-18T12:00:00Z" });
      expect(out.from).toBe("draft");
      expect(out.to).toBe("candidate");
      const written = JSON.parse(await fs.readFile(file, "utf8"));
      expect(written.status).toBe("candidate");
      expect(written.pipeline).toEqual(original.pipeline);
      expect(written.provenance.promotion_history).toEqual([
        { from: "draft", to: "candidate", at: "2026-04-18T12:00:00Z", reason: "3 successful runs" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promoteSkill rejects invalid transitions", async () => {
    const dir = tmpdir();
    try {
      const file = path.join(dir, "s.json");
      const original = {
        id: "s", name: "S", description: "d", version: 1, status: "draft",
        trigger: { keywords: [], input_shape: {} },
        pipeline: [{ id: "x", tool: "ollama_classify", inputs: {} }],
        result_from: "x",
        provenance: { created_at: "2026-04-01T00:00:00Z", source: "hand_authored", runs: 0, promotion_history: [] },
      };
      await fs.writeFile(file, JSON.stringify(original, null, 2), "utf8");
      const loadedSkill: LoadedSkill = { scope: "project", source_path: file, skill: original as unknown as LoadedSkill["skill"] };
      await expect(promoteSkill(loadedSkill, { target: "draft", reason: "same" })).rejects.toThrow(/Invalid transition/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
