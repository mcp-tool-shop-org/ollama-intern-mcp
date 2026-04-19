import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { summarizeInputShape } from "../../src/observability.js";
import { reconstructChains } from "../../src/skills/chains.js";
import { proposeNewSkills, DEFAULT_NEW_SKILL_THRESHOLDS } from "../../src/skills/newSkillProposer.js";
import type { LogEvent } from "../../src/observability.js";
import type { LoadedSkill } from "../../src/skills/types.js";
import type { Chain } from "../../src/skills/chains.js";

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), "newskills-")); }

function mkCallEvent(tool: string, ts: string, ok: boolean, input: Record<string, unknown>): LogEvent {
  return {
    kind: "call",
    ts,
    tool,
    envelope: { tier_used: "instant", model: "m", tokens_in: 10, tokens_out: 5, elapsed_ms: 1000, result: ok ? {} : { error: true } } as never,
    input_shape: summarizeInputShape(input),
  };
}

async function writeLog(dir: string, events: LogEvent[]): Promise<string> {
  const logPath = path.join(dir, "log.ndjson");
  await fs.writeFile(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return logPath;
}

describe("observability/summarizeInputShape", () => {
  it("records presence, string buckets, array length, object keys — never content", () => {
    const out = summarizeInputShape({
      text: "x".repeat(200),
      log_text: "x".repeat(1200),
      source_paths: ["a", "b", "c"],
      options: { a: 1, b: 2 },
      verbose: true,
      count: 5,
      missing: undefined,
    });
    expect(out.text).toEqual({ kind: "string", bucket: "small" });
    expect(out.log_text).toEqual({ kind: "string", bucket: "medium" });
    expect(out.source_paths).toEqual({ kind: "array", length: 3 });
    expect(out.options).toEqual({ kind: "object", keys: ["a", "b"] });
    expect(out.verbose).toEqual({ kind: "boolean", value: true });
    expect(out.count).toEqual({ kind: "number" });
    expect(out.missing).toEqual({ kind: "absent" });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/x{50}/);
    expect(serialized.length).toBeLessThan(300);
  });
});

describe("skills/chains", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("splits calls into chains by the silence-gap heuristic", async () => {
    const logPath = await writeLog(dir, [
      mkCallEvent("ollama_triage_logs", "2026-04-18T10:00:00.000Z", true, { log_text: "x".repeat(500) }),
      mkCallEvent("ollama_incident_brief", "2026-04-18T10:00:30.000Z", true, { log_text: "x".repeat(500) }),
      // 5-minute gap → new chain
      mkCallEvent("ollama_classify", "2026-04-18T10:06:00.000Z", true, { text: "hi", labels: ["a", "b"] }),
    ]);
    const chains = await reconstructChains({ logPath, gapMs: 180_000 });
    expect(chains).toHaveLength(2);
    expect(chains[0].signature).toBe("ollama_triage_logs→ollama_incident_brief");
    expect(chains[0].steps).toHaveLength(2);
    expect(chains[1].signature).toBe("ollama_classify");
  });

  it("excludes skill-layer self-reference tools by default", async () => {
    const logPath = await writeLog(dir, [
      mkCallEvent("ollama_skill_list", "2026-04-18T10:00:00.000Z", true, {}),
      mkCallEvent("ollama_triage_logs", "2026-04-18T10:00:30.000Z", true, { log_text: "x" }),
    ]);
    const chains = await reconstructChains({ logPath });
    expect(chains.flatMap((c) => c.steps.map((s) => s.tool))).not.toContain("ollama_skill_list");
  });

  it("returns empty array when log is missing", async () => {
    const chains = await reconstructChains({ logPath: path.join(dir, "nonexistent.ndjson") });
    expect(chains).toEqual([]);
  });
});

describe("skills/newSkillProposer", () => {
  function makeChain(signature: string, ok: boolean, when: string, shape: Record<string, unknown>): Chain {
    const steps = signature.split("→").map((tool) => ({
      tool,
      ts: when,
      ok,
      input_shape: summarizeInputShape(shape),
    }));
    return {
      chain_id: `${when}_${signature}`,
      started_at: when,
      ended_at: when,
      duration_ms: 1000,
      steps,
      ok_count: ok ? steps.length : 0,
      fail_count: ok ? 0 : steps.length,
      signature,
    };
  }

  it("proposes a new skill when support and success thresholds are met and shapes agree", () => {
    const sig = "ollama_triage_logs→ollama_incident_brief";
    const shape = { log_text: "x".repeat(500) };
    const chains = [
      makeChain(sig, true, "2026-04-18T10:00:00Z", shape),
      makeChain(sig, true, "2026-04-18T11:00:00Z", shape),
      makeChain(sig, true, "2026-04-18T12:00:00Z", shape),
    ];
    const proposals = proposeNewSkills(chains, []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].pipeline_tools).toEqual(["ollama_triage_logs", "ollama_incident_brief"]);
    expect(proposals[0].suggested_id).toBe("triage-logs-then-incident-brief");
    expect(proposals[0].evidence.support).toBe(3);
    expect(proposals[0].evidence.success_rate).toBe(1);
    expect(proposals[0].evidence.shape_agreement).toBeGreaterThanOrEqual(0.6);
  });

  it("excludes signatures already formalized as skills", () => {
    const sig = "ollama_triage_logs→ollama_incident_brief";
    const shape = { log_text: "x".repeat(500) };
    const chains = Array.from({ length: 5 }, (_, i) =>
      makeChain(sig, true, `2026-04-18T10:0${i}:00Z`, shape),
    );
    const existing: LoadedSkill[] = [
      {
        scope: "project",
        source_path: "/tmp/s.json",
        skill: {
          id: "existing",
          name: "Already here",
          description: "d",
          version: 1,
          status: "approved",
          trigger: { keywords: [], input_shape: {} },
          pipeline: [
            { id: "a", tool: "ollama_triage_logs", inputs: {} },
            { id: "b", tool: "ollama_incident_brief", inputs: {} },
          ],
          result_from: "b",
          provenance: { created_at: "2026-04-01T00:00:00Z", source: "hand_authored", runs: 0, promotion_history: [] },
        },
      },
    ];
    const proposals = proposeNewSkills(chains, existing);
    expect(proposals).toEqual([]);
  });

  it("requires min_support — 2 matching chains is not enough by default", () => {
    const sig = "ollama_triage_logs→ollama_incident_brief";
    const shape = { log_text: "x".repeat(500) };
    const chains = [
      makeChain(sig, true, "2026-04-18T10:00:00Z", shape),
      makeChain(sig, true, "2026-04-18T11:00:00Z", shape),
    ];
    expect(proposeNewSkills(chains, [])).toEqual([]);
  });

  it("rejects signatures with success rate below floor", () => {
    const sig = "ollama_triage_logs→ollama_incident_brief";
    const shape = { log_text: "x".repeat(500) };
    const chains = [
      makeChain(sig, true, "2026-04-18T10:00:00Z", shape),
      makeChain(sig, false, "2026-04-18T11:00:00Z", shape),
      makeChain(sig, false, "2026-04-18T12:00:00Z", shape),
      makeChain(sig, false, "2026-04-18T13:00:00Z", shape),
    ];
    expect(proposeNewSkills(chains, [])).toEqual([]);
  });

  it("rejects single-step chains — not a workflow", () => {
    const chains = Array.from({ length: 5 }, (_, i) =>
      makeChain("ollama_classify", true, `2026-04-18T10:0${i}:00Z`, { text: "x", labels: ["a", "b"] }),
    );
    expect(proposeNewSkills(chains, [])).toEqual([]);
  });

  it("respects overridden thresholds", () => {
    const sig = "ollama_triage_logs→ollama_incident_brief";
    const shape = { log_text: "x".repeat(500) };
    const chains = [
      makeChain(sig, true, "2026-04-18T10:00:00Z", shape),
      makeChain(sig, true, "2026-04-18T11:00:00Z", shape),
    ];
    expect(proposeNewSkills(chains, [], { ...DEFAULT_NEW_SKILL_THRESHOLDS, min_support: 2 })).toHaveLength(1);
  });
});
