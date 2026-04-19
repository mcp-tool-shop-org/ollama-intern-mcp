import { describe, it, expect } from "vitest";
import {
  route,
  rankCandidates,
  scoreCandidate,
  generateCandidates,
  KNOWN_PACKS,
  ROUTING_SUGGEST_FLOOR,
  bandFor,
  ROUTING_SCHEMA_VERSION,
} from "../../src/routing/index.js";
import type { RoutingContext } from "../../src/routing/types.js";
import type { Skill } from "../../src/skills/types.js";
import type { MemoryRecord } from "../../src/memory/types.js";

function skill(overrides: Partial<Skill> & { id: string }): Skill {
  return {
    id: overrides.id,
    name: overrides.id,
    description: "test",
    version: 1,
    status: "approved",
    trigger: { keywords: [], input_shape: {} },
    pipeline: [{ id: "a", tool: "ollama_classify", inputs: {} }],
    result_from: "a",
    provenance: { created_at: "t", source: "hand_authored", runs: 0, promotion_history: [] },
    ...overrides,
  } as Skill;
}

function memRecord(overrides: Partial<MemoryRecord> & { id: string; kind: MemoryRecord["kind"] }): MemoryRecord {
  return {
    id: overrides.id,
    kind: overrides.kind,
    schema_version: 1,
    created_at: "2026-04-18T10:00:00Z",
    indexed_at: "2026-04-18T10:00:00Z",
    title: "t",
    summary: "s",
    tags: [],
    facets: {},
    content_digest: "d".repeat(64),
    provenance: { source_kind: overrides.kind, source_path: "/tmp/x", ref: "x" },
    ...overrides,
  } as MemoryRecord;
}

function ctx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    schema_version: ROUTING_SCHEMA_VERSION,
    built_at: "2026-04-18T20:00:00Z",
    job_hint: null,
    input_shape: {},
    input_flags: {
      has_log_text: false,
      has_source_paths: false,
      has_diff_text: false,
      has_corpus: false,
      has_question: false,
      has_text: false,
      has_items_batch: false,
    },
    available_skills: [],
    memory_hits: [],
    candidate_proposals: [],
    ...overrides,
  } as RoutingContext;
}

describe("routing/candidates", () => {
  it("generates one candidate per skill, one per pack, plus abstain", () => {
    const context = ctx({ available_skills: [skill({ id: "a" }), skill({ id: "b" })] });
    const cands = generateCandidates(context);
    expect(cands.filter((c) => c.target.kind === "skill")).toHaveLength(2);
    expect(cands.filter((c) => c.target.kind === "pack")).toHaveLength(KNOWN_PACKS.length);
    expect(cands.filter((c) => c.target.kind === "no_suggestion")).toHaveLength(1);
  });

  it("dedups candidate_proposal signatures that already exist as skill pipelines", () => {
    const s = skill({
      id: "existing",
      pipeline: [
        { id: "a", tool: "ollama_triage_logs", inputs: {} },
        { id: "b", tool: "ollama_incident_brief", inputs: {} },
      ],
    });
    const proposal = memRecord({
      id: "p", kind: "candidate_proposal",
      provenance: { source_kind: "candidate_proposal", source_path: "/tmp/l", ref: "ollama_triage_logs→ollama_incident_brief" },
    });
    const cands = generateCandidates(ctx({ available_skills: [s], candidate_proposals: [proposal] }));
    expect(cands.filter((c) => c.target.kind === "atoms")).toHaveLength(0);
  });

  it("emits atom-chain candidates for proposals without a matching skill", () => {
    const proposal = memRecord({
      id: "p", kind: "candidate_proposal",
      provenance: { source_kind: "candidate_proposal", source_path: "/tmp/l", ref: "ollama_research→ollama_extract→ollama_draft" },
    });
    const cands = generateCandidates(ctx({ candidate_proposals: [proposal] }));
    const atomC = cands.find((c) => c.target.kind === "atoms");
    expect(atomC?.target.ref).toBe("ollama_research→ollama_extract→ollama_draft");
    expect(atomC?.target.expected_tools).toEqual(["ollama_research", "ollama_extract", "ollama_draft"]);
  });
});

describe("routing/scoring — skills", () => {
  it("rewards keyword+status+input-shape match", () => {
    const s = skill({
      id: "triage-then-brief",
      status: "approved",
      trigger: {
        keywords: ["triage", "incident", "logs"],
        input_shape: { log_text: "raw log text" },
      },
    });
    const context = ctx({
      available_skills: [s],
      job_hint: "triage these logs for an incident",
      input_shape: { log_text: { kind: "string", bucket: "medium" } },
      input_flags: { ...ctx().input_flags, has_log_text: true },
    });
    const base = generateCandidates(context).find((c) => c.target.kind === "skill" && c.target.ref === "triage-then-brief")!;
    const scored = scoreCandidate(base, context);
    expect(scored.score).toBeGreaterThan(ROUTING_SUGGEST_FLOOR);
    const names = scored.signals.map((s) => s.name);
    expect(names).toContain("skill_keyword_hit");
    expect(names).toContain("skill_status_bump");
    expect(names).toContain("input_shape_match");
    expect(scored.band).not.toBe("abstain");
  });

  it("penalizes missing declared inputs", () => {
    const s = skill({
      id: "needs-logs",
      trigger: { keywords: [], input_shape: { log_text: "required" } },
    });
    const context = ctx({ available_skills: [s] });
    const base = generateCandidates(context).find((c) => c.target.kind === "skill")!;
    const scored = scoreCandidate(base, context);
    const missing = scored.signals.find((sg) => sg.name === "missing_required_input");
    expect(missing).toBeTruthy();
    expect(scored.missing_signals).toContain("input.log_text");
  });

  it("deprecated skills get crushed by a penalty signal", () => {
    const s = skill({ id: "old", status: "deprecated" });
    const context = ctx({ available_skills: [s] });
    const base = generateCandidates(context).find((c) => c.target.ref === "old")!;
    const scored = scoreCandidate(base, context);
    expect(scored.score).toBeLessThan(0);
    expect(scored.signals.some((sg) => sg.name === "deprecated_penalty")).toBe(true);
  });

  it("memory_hits of prior successful runs lift the score and add provenance", () => {
    const s = skill({ id: "tb", status: "approved", trigger: { keywords: [], input_shape: {} } });
    const prior = memRecord({
      id: "mem:1", kind: "skill_receipt",
      facets: { skill_id: "tb", ok: true },
    });
    const prior2 = memRecord({
      id: "mem:2", kind: "skill_receipt",
      facets: { skill_id: "tb", ok: true },
    });
    const context = ctx({ available_skills: [s], memory_hits: [prior, prior2] });
    const base = generateCandidates(context).find((c) => c.target.ref === "tb")!;
    const scored = scoreCandidate(base, context);
    const sigNames = scored.signals.map((x) => x.name);
    expect(sigNames).toContain("memory_success_history");
    const provIds = scored.provenance.map((p) => p.ref);
    expect(provIds).toEqual(expect.arrayContaining(["tb", "mem:1", "mem:2"]));
  });
});

describe("routing/scoring — packs", () => {
  it("incident_pack wins when only log_text is present", () => {
    const context = ctx({
      input_flags: { ...ctx().input_flags, has_log_text: true },
    });
    const base = generateCandidates(context).find((c) => c.target.ref === "incident_pack")!;
    const scored = scoreCandidate(base, context);
    expect(scored.signals.some((s) => s.name === "pack_shape_fit" && s.reason.includes("log_text"))).toBe(true);
    expect(scored.score).toBeGreaterThan(0);
  });

  it("change_pack accepts either diff_text or source_paths", () => {
    const ctxDiff = ctx({ input_flags: { ...ctx().input_flags, has_diff_text: true } });
    const ctxSrc = ctx({ input_flags: { ...ctx().input_flags, has_source_paths: true } });
    for (const c of [ctxDiff, ctxSrc]) {
      const base = generateCandidates(c).find((x) => x.target.ref === "change_pack")!;
      const scored = scoreCandidate(base, c);
      expect(scored.signals.some((s) => s.name === "pack_shape_fit")).toBe(true);
    }
  });

  it("incident_pack is penalized when log_text is absent", () => {
    const context = ctx();
    const base = generateCandidates(context).find((c) => c.target.ref === "incident_pack")!;
    const scored = scoreCandidate(base, context);
    expect(scored.signals.some((s) => s.name === "missing_required_input")).toBe(true);
    expect(scored.score).toBeLessThanOrEqual(0);
  });

  it("corpus presence lifts grounded packs via corpus_available bonus", () => {
    const withCorpus = ctx({
      input_flags: { ...ctx().input_flags, has_source_paths: true, has_corpus: true },
    });
    const noCorpus = ctx({
      input_flags: { ...ctx().input_flags, has_source_paths: true },
    });
    const findRepo = (c: RoutingContext) => {
      const base = generateCandidates(c).find((x) => x.target.ref === "repo_pack")!;
      return scoreCandidate(base, c);
    };
    expect(findRepo(withCorpus).score).toBeGreaterThan(findRepo(noCorpus).score);
  });
});

describe("routing/scoring — atom chains", () => {
  it("weights atom-chain candidates by captured support × success_rate", () => {
    const proposal = memRecord({
      id: "p", kind: "candidate_proposal",
      provenance: { source_kind: "candidate_proposal", source_path: "/tmp/l", ref: "ollama_research→ollama_extract→ollama_draft" },
      facets: { support: 5, success_rate: 1 },
    });
    const context = ctx({ candidate_proposals: [proposal] });
    const base = generateCandidates(context).find((c) => c.target.kind === "atoms")!;
    const scored = scoreCandidate(base, context);
    expect(scored.signals[0].name).toBe("candidate_proposal_support");
    expect(scored.provenance[0].kind).toBe("candidate_proposal");
  });

  it("atom chains with no supporting proposal get a weak_evidence penalty", () => {
    const base = { target: { kind: "atoms" as const, ref: "a→b", expected_tools: ["a", "b"] }, score: 0, band: "low" as const, signals: [], missing_signals: [], provenance: [] };
    const scored = scoreCandidate(base, ctx());
    expect(scored.signals.some((s) => s.name === "weak_evidence")).toBe(true);
  });
});

describe("routing/router — deterministic rank + abstain", () => {
  it("ranks by score descending, breaks ties on kind order then ref", () => {
    const c = (kind: "skill" | "pack" | "atoms", ref: string, score: number) => ({
      target: { kind, ref, expected_tools: [] }, score, band: "low" as const, signals: [], missing_signals: [], provenance: [],
    });
    const ranked = rankCandidates([
      c("pack", "incident_pack", 1.0),
      c("skill", "z-skill", 1.0),
      c("atoms", "a→b", 1.0),
      c("skill", "a-skill", 1.0),
    ]);
    expect(ranked.map((x) => `${x.target.kind}:${x.target.ref}`)).toEqual([
      "skill:a-skill",
      "skill:z-skill",
      "pack:incident_pack",
      "atoms:a→b",
    ]);
  });

  it("bandFor returns abstain below suggest floor", () => {
    expect(bandFor(0.1, [])).toBe("abstain");
  });

  it("bandFor requires evidence beyond status bump for high", () => {
    // A "skill_status_bump" by itself cannot reach high, even at high score.
    const lowEvidence = bandFor(3.0, [
      { name: "skill_status_bump", weight: 0.4, reason: "approved" },
    ]);
    expect(lowEvidence).toBe("low");

    const realEvidence = bandFor(3.0, [
      { name: "input_shape_match", weight: 1.0, reason: "r" },
      { name: "skill_keyword_hit", weight: 2.0, reason: "r" },
    ]);
    expect(realEvidence).toBe("high");
  });

  it("route abstains when evidence is thin — top is always no_suggestion slot", () => {
    const decision = route(ctx());
    expect(decision.suggested).toBeNull();
    expect(decision.abstain_reason).toBeTruthy();
    // The abstain candidate itself should be in the ranked field.
    expect(decision.candidates.some((c) => c.target.kind === "no_suggestion")).toBe(true);
  });

  it("route suggests a skill when shape + keywords + status all line up", () => {
    const s = skill({
      id: "triage-then-brief",
      status: "approved",
      trigger: {
        keywords: ["triage", "incident", "logs"],
        input_shape: { log_text: "raw log text" },
      },
      provenance: { created_at: "t", source: "hand_authored", runs: 3, promotion_history: [] },
    });
    const context = ctx({
      available_skills: [s],
      job_hint: "triage these logs for an incident",
      input_shape: { log_text: { kind: "string", bucket: "medium" } },
      input_flags: { ...ctx().input_flags, has_log_text: true },
    });
    const decision = route(context);
    expect(decision.suggested?.kind).toBe("skill");
    expect(decision.suggested?.ref).toBe("triage-then-brief");
    expect(decision.abstain_reason).toBeNull();
    expect(["high", "medium"]).toContain(decision.candidates[0].band);
  });

  it("route prefers a matching skill over a matching pack (same input shape)", () => {
    const s = skill({
      id: "triage-then-brief",
      status: "approved",
      trigger: {
        keywords: ["triage", "incident", "logs"],
        input_shape: { log_text: "raw log text" },
      },
    });
    const context = ctx({
      available_skills: [s],
      job_hint: "triage these logs",
      input_shape: { log_text: { kind: "string", bucket: "medium" } },
      input_flags: { ...ctx().input_flags, has_log_text: true },
    });
    const decision = route(context);
    expect(decision.suggested?.kind).toBe("skill");
    const bestPack = decision.candidates.find((c) => c.target.kind === "pack");
    expect(decision.candidates[0].score).toBeGreaterThan(bestPack!.score);
  });

  it("route decision snapshots the full context — audits are self-contained", () => {
    const decision = route(ctx({ job_hint: "x" }));
    expect(decision.context.job_hint).toBe("x");
    expect(decision.schema_version).toBe(ROUTING_SCHEMA_VERSION);
  });
});
