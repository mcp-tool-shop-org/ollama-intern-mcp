import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  shapeSignature,
  loadRoutingReceipts,
  buildSummary,
  generateFindings,
  DEFAULT_AUDIT_THRESHOLDS,
  AUDIT_SCHEMA_VERSION,
} from "../../src/routing/audit/index.js";
import type { RoutingReceipt } from "../../src/routing/receipts.js";
import type { RoutingDecision } from "../../src/routing/types.js";
import type { LoadedSkill } from "../../src/skills/types.js";
import type { MemoryRecord } from "../../src/memory/types.js";

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), "audit-")); }

function mkDecision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    schema_version: 1,
    decided_at: "2026-04-18T10:00:00Z",
    candidates: [],
    suggested: null,
    abstain_reason: "thin",
    context: {
      schema_version: 1,
      built_at: "2026-04-18T10:00:00Z",
      job_hint: null,
      input_shape: {},
      input_flags: {
        has_log_text: false, has_source_paths: false, has_diff_text: false,
        has_corpus: false, has_question: false, has_text: false, has_items_batch: false,
      },
      available_skills: [],
      memory_hits: [],
      candidate_proposals: [],
    },
    ...overrides,
  };
}

function mkReceipt(overrides: Partial<RoutingReceipt> & { id: string }): RoutingReceipt {
  return {
    schema_version: 1,
    recorded_at: "2026-04-18T10:00:00Z",
    actual: { route_identity: "atom:ollama_classify", tool: "ollama_classify", job_hint: null },
    decision: mkDecision(),
    match: { matched: false, kind: "abstain" },
    outcome: { ok: true, elapsed_ms: 100 },
    runtime: { hardware_profile: "dev-rtx5080", think: false },
    receipt_path: `/tmp/fake/${overrides.id}.json`,
    ...overrides,
  } as RoutingReceipt;
}

describe("routing/audit — shapeSignature", () => {
  it("returns a stable string across key order", () => {
    const a = shapeSignature({
      log_text: { kind: "string", bucket: "medium" },
      source_paths: { kind: "array", length: 3 },
    });
    const b = shapeSignature({
      source_paths: { kind: "array", length: 3 },
      log_text: { kind: "string", bucket: "medium" },
    });
    expect(a).toBe(b);
  });

  it("buckets array lengths so 3 and 4 cluster together", () => {
    const a = shapeSignature({ source_paths: { kind: "array", length: 3 } });
    const b = shapeSignature({ source_paths: { kind: "array", length: 4 } });
    expect(a).toBe(b);
  });

  it("groups absent keys separately from missing keys", () => {
    const withAbsent = shapeSignature({ log_text: { kind: "absent" } });
    const empty = shapeSignature({});
    expect(withAbsent).not.toBe(empty);
  });

  it("returns (empty) for empty shapes", () => {
    expect(shapeSignature({})).toBe("(empty)");
  });
});

describe("routing/audit — loadRoutingReceipts", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("filters by since/until window", async () => {
    const mk = (name: string, ts: string) => fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(mkReceipt({ id: name, recorded_at: ts })), "utf8");
    await mk("a", "2026-04-18T09:00:00Z");
    await mk("b", "2026-04-18T10:30:00Z");
    await mk("c", "2026-04-18T12:00:00Z");
    const since = await loadRoutingReceipts({ dir, since: "2026-04-18T10:00:00Z" });
    expect(since.map((r) => r.recorded_at)).toEqual(["2026-04-18T10:30:00Z", "2026-04-18T12:00:00Z"]);
    const until = await loadRoutingReceipts({ dir, until: "2026-04-18T11:00:00Z" });
    expect(until.map((r) => r.recorded_at)).toEqual(["2026-04-18T09:00:00Z", "2026-04-18T10:30:00Z"]);
  });

  it("tolerates corrupt files without breaking", async () => {
    await fs.writeFile(path.join(dir, "good.json"), JSON.stringify(mkReceipt({ id: "good" })), "utf8");
    await fs.writeFile(path.join(dir, "bad.json"), "{ not valid", "utf8");
    const loaded = await loadRoutingReceipts({ dir });
    expect(loaded).toHaveLength(1);
  });
});

describe("routing/audit — buildSummary", () => {
  const t = DEFAULT_AUDIT_THRESHOLDS;

  it("splits abstains into legit vs missed based on shape cluster size", () => {
    const shapeA = { log_text: { kind: "string" as const, bucket: "medium" as const } };
    const shapeB = { text: { kind: "string" as const, bucket: "small" as const } };
    const receipts: RoutingReceipt[] = [
      // 4 abstains on shapeA → missed_abstain cluster
      ...Array.from({ length: 4 }, (_, i) => mkReceipt({
        id: `a${i}`,
        match: { matched: false, kind: "abstain" },
        decision: mkDecision({ context: { ...mkDecision().context, input_shape: shapeA } }),
      })),
      // 1 abstain on shapeB → legit_abstain
      mkReceipt({
        id: "b0",
        match: { matched: false, kind: "abstain" },
        decision: mkDecision({ context: { ...mkDecision().context, input_shape: shapeB } }),
      }),
    ];
    const s = buildSummary(receipts, null, t);
    expect(s.match_breakdown.missed_abstain).toBe(4);
    expect(s.match_breakdown.legit_abstain).toBe(1);
    expect(s.match_breakdown.exact).toBe(0);
  });

  it("aggregates by_actual_route correctly", () => {
    const receipts = [
      mkReceipt({ id: "1", actual: { route_identity: "pack:ollama_incident_pack", tool: "ollama_incident_pack", job_hint: null }, match: { matched: true, kind: "exact" } }),
      mkReceipt({ id: "2", actual: { route_identity: "pack:ollama_incident_pack", tool: "ollama_incident_pack", job_hint: null }, match: { matched: true, kind: "exact" } }),
      mkReceipt({ id: "3", actual: { route_identity: "atom:ollama_classify", tool: "ollama_classify", job_hint: null } }),
    ];
    const s = buildSummary(receipts, null, t);
    const incident = s.by_actual_route.find((x) => x.route_identity === "pack:ollama_incident_pack");
    expect(incident?.count).toBe(2);
    expect(incident?.match_kinds.exact).toBe(2);
    expect(s.route_family_distribution).toEqual({ atom: 1, pack: 2 });
  });

  it("runtime breakdown counts think on/off and models", () => {
    const r = (id: string, think: boolean | null, model?: string) => mkReceipt({
      id,
      runtime: { hardware_profile: "dev-rtx5080", think },
      outcome: { ok: true, elapsed_ms: 50, ...(model ? { model } : {}) },
    });
    const receipts = [r("a", true, "qwen3:14b"), r("b", false, "qwen3:8b"), r("c", false, "qwen3:8b"), r("d", null)];
    const s = buildSummary(receipts, null, t);
    expect(s.runtime_breakdown.think_on).toBe(1);
    expect(s.runtime_breakdown.think_off).toBe(2);
    expect(s.runtime_breakdown.think_unknown).toBe(1);
    expect(s.runtime_breakdown.by_model).toEqual({ "qwen3:14b": 1, "qwen3:8b": 2 });
  });
});

describe("routing/audit — generateFindings", () => {
  const t = DEFAULT_AUDIT_THRESHOLDS;
  const emptyInputs = { approved_skills: [] as LoadedSkill[], candidate_proposals: [] as MemoryRecord[], thresholds: t };

  it("fires promotion_gap when pack succeeds N+ times on same shape and no skill exists", () => {
    const shape = { log_text: { kind: "string" as const, bucket: "medium" as const } };
    const packCand = {
      target: { kind: "pack" as const, ref: "incident_pack", expected_tools: ["ollama_triage_logs", "ollama_incident_brief"] },
      score: 0.9, band: "medium" as const, signals: [], missing_signals: [], provenance: [],
    };
    const receipts = Array.from({ length: 5 }, (_, i) => mkReceipt({
      id: `p${i}`,
      actual: { route_identity: "pack:ollama_incident_pack", tool: "ollama_incident_pack", job_hint: null },
      match: { matched: true, kind: "exact" },
      decision: mkDecision({
        context: { ...mkDecision().context, input_shape: shape },
        candidates: [packCand],
        suggested: packCand.target,
        abstain_reason: null,
      }),
      outcome: { ok: true, elapsed_ms: 1000, artifact_ref: { pack: "incident_pack", slug: `d${i}`, json_path: `/tmp/d${i}.json` } },
    }));
    const findings = generateFindings({ ...emptyInputs, receipts });
    const gap = findings.find((f) => f.kind === "promotion_gap");
    expect(gap).toBeTruthy();
    expect(gap?.severity).toBe("high");
    expect(gap?.evidence.artifact_refs?.length).toBeGreaterThan(0);
  });

  it("does NOT fire promotion_gap when an approved skill already encodes the pipeline", () => {
    const shape = { log_text: { kind: "string" as const, bucket: "medium" as const } };
    const packCand = {
      target: { kind: "pack" as const, ref: "incident_pack", expected_tools: ["ollama_triage_logs", "ollama_incident_brief"] },
      score: 0.9, band: "medium" as const, signals: [], missing_signals: [], provenance: [],
    };
    const receipts = Array.from({ length: 5 }, (_, i) => mkReceipt({
      id: `p${i}`,
      actual: { route_identity: "pack:ollama_incident_pack", tool: "ollama_incident_pack", job_hint: null },
      match: { matched: true, kind: "exact" },
      decision: mkDecision({
        context: { ...mkDecision().context, input_shape: shape },
        candidates: [packCand],
        suggested: packCand.target,
        abstain_reason: null,
      }),
      outcome: { ok: true, elapsed_ms: 100 },
    }));
    const approvedSkill: LoadedSkill = {
      scope: "project", source_path: "/tmp/s.json",
      skill: {
        id: "triage-then-brief", name: "x", description: "x", version: 1, status: "approved",
        trigger: { keywords: [], input_shape: {} },
        pipeline: [{ id: "a", tool: "ollama_triage_logs", inputs: {} }, { id: "b", tool: "ollama_incident_brief", inputs: {} }],
        result_from: "b", provenance: { created_at: "t", source: "hand_authored", runs: 0, promotion_history: [] },
      },
    };
    const findings = generateFindings({ ...emptyInputs, receipts, approved_skills: [approvedSkill] });
    expect(findings.find((f) => f.kind === "promotion_gap")).toBeUndefined();
  });

  it("fires override_hotspot when suggestion keeps differing from actual on same shape", () => {
    const shape = { source_paths: { kind: "array" as const, length: 3 } };
    const suggested = {
      target: { kind: "pack" as const, ref: "change_pack", expected_tools: [] },
      score: 0.9, band: "medium" as const, signals: [], missing_signals: [], provenance: [],
    };
    const receipts = Array.from({ length: 4 }, (_, i) => mkReceipt({
      id: `o${i}`,
      actual: { route_identity: "pack:ollama_repo_pack", tool: "ollama_repo_pack", job_hint: null },
      match: { matched: false, kind: "kind_match" },
      decision: mkDecision({
        context: { ...mkDecision().context, input_shape: shape },
        candidates: [suggested],
        suggested: suggested.target,
        abstain_reason: null,
      }),
      outcome: { ok: true, elapsed_ms: 100 },
    }));
    const findings = generateFindings({ ...emptyInputs, receipts });
    const hotspot = findings.find((f) => f.kind === "override_hotspot");
    expect(hotspot).toBeTruthy();
    expect(hotspot?.title).toMatch(/override/);
  });

  it("fires missed_abstain when router abstained N+ times and same actual route dominates", () => {
    const shape = { log_text: { kind: "string" as const, bucket: "large" as const } };
    const receipts = Array.from({ length: 4 }, (_, i) => mkReceipt({
      id: `m${i}`,
      actual: { route_identity: "pack:ollama_incident_pack", tool: "ollama_incident_pack", job_hint: null },
      match: { matched: false, kind: "abstain" },
      decision: mkDecision({ context: { ...mkDecision().context, input_shape: shape } }),
    }));
    const findings = generateFindings({ ...emptyInputs, receipts });
    const missed = findings.find((f) => f.kind === "missed_abstain");
    expect(missed).toBeTruthy();
    expect(missed?.severity).toBe("high");
    expect(missed?.detail).toContain("pack:ollama_incident_pack");
  });

  it("fires abstain_cluster (low severity) when abstentions recur but no dominant route", () => {
    const shape = { text: { kind: "string" as const, bucket: "small" as const } };
    const receipts = [
      ...Array.from({ length: 2 }, (_, i) => mkReceipt({
        id: `x${i}`,
        actual: { route_identity: "atom:ollama_classify", tool: "ollama_classify", job_hint: null },
        match: { matched: false, kind: "abstain" },
        decision: mkDecision({ context: { ...mkDecision().context, input_shape: shape } }),
      })),
      ...Array.from({ length: 2 }, (_, i) => mkReceipt({
        id: `y${i}`,
        actual: { route_identity: "atom:ollama_extract", tool: "ollama_extract", job_hint: null },
        match: { matched: false, kind: "abstain" },
        decision: mkDecision({ context: { ...mkDecision().context, input_shape: shape } }),
      })),
    ];
    const findings = generateFindings({ ...emptyInputs, receipts });
    expect(findings.find((f) => f.kind === "abstain_cluster")).toBeTruthy();
    expect(findings.find((f) => f.kind === "missed_abstain")).toBeUndefined();
  });

  it("fires unused_candidate for strong proposals not surfaced by any suggestion", () => {
    const proposal: MemoryRecord = {
      id: "candidate_proposal:xyz",
      kind: "candidate_proposal",
      schema_version: 1,
      created_at: "2026-04-18T10:00:00Z", indexed_at: "2026-04-18T10:00:00Z",
      title: "Candidate", summary: "s", tags: [],
      facets: { support: 5, success_rate: 1, shape_agreement: 0.9 },
      content_digest: "d".repeat(64),
      provenance: { source_kind: "candidate_proposal", source_path: "/tmp/log", ref: "a→b→c" },
    };
    const findings = generateFindings({ ...emptyInputs, receipts: [], candidate_proposals: [proposal] });
    const unused = findings.find((f) => f.kind === "unused_candidate");
    expect(unused).toBeTruthy();
    expect(unused?.evidence.proposal_refs).toEqual(["candidate_proposal:xyz"]);
  });

  it("does NOT fire unused_candidate when the proposal surfaces as a top suggestion", () => {
    const proposal: MemoryRecord = {
      id: "p", kind: "candidate_proposal",
      schema_version: 1, created_at: "t", indexed_at: "t",
      title: "C", summary: "s", tags: [],
      facets: { support: 5, success_rate: 1, shape_agreement: 0.9 },
      content_digest: "d".repeat(64),
      provenance: { source_kind: "candidate_proposal", source_path: "/tmp/log", ref: "a→b→c" },
    };
    const receipts = [mkReceipt({
      id: "r1",
      decision: mkDecision({
        suggested: { kind: "atoms", ref: "a→b→c", expected_tools: ["a", "b", "c"] },
        abstain_reason: null,
      }),
    })];
    const findings = generateFindings({ ...emptyInputs, receipts, candidate_proposals: [proposal] });
    expect(findings.find((f) => f.kind === "unused_candidate")).toBeUndefined();
  });

  it("fires overconfident_route when high-band suggestion is repeatedly overridden with success", () => {
    const highBandCand = {
      target: { kind: "pack" as const, ref: "change_pack", expected_tools: [] },
      score: 2.5, band: "high" as const, signals: [], missing_signals: [], provenance: [],
    };
    const receipts = Array.from({ length: 4 }, (_, i) => mkReceipt({
      id: `oc${i}`,
      actual: { route_identity: "pack:ollama_repo_pack", tool: "ollama_repo_pack", job_hint: null },
      match: { matched: false, kind: "kind_match" },
      decision: mkDecision({
        candidates: [highBandCand],
        suggested: highBandCand.target,
        abstain_reason: null,
      }),
      outcome: { ok: true, elapsed_ms: 100 },
    }));
    const findings = generateFindings({ ...emptyInputs, receipts });
    const over = findings.find((f) => f.kind === "overconfident_route");
    expect(over).toBeTruthy();
    expect(over?.severity).toBe("high");
  });
});
