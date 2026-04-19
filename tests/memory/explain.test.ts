import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  tokenize,
  resolveProvenance,
  computeAge,
  findDuplicates,
  readMemory,
  explainRecord,
  neighborsOf,
} from "../../src/memory/explain.js";
import type { MemoryIndex, MemoryRecord } from "../../src/memory/types.js";
import type { EmbeddingsStore } from "../../src/memory/embeddings.js";

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), "c3-")); }

function rec(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  return {
    id: overrides.id,
    kind: "skill_receipt",
    schema_version: 1,
    created_at: "2026-04-18T10:00:00Z",
    indexed_at: "2026-04-18T10:00:00Z",
    title: "t",
    summary: "s",
    tags: [],
    facets: {},
    content_digest: "d".repeat(64),
    provenance: { source_kind: "skill_receipt", source_path: "/tmp/x", ref: "x|t" },
    ...overrides,
  } as MemoryRecord;
}

describe("memory/explain — tokenize", () => {
  it("lowercases, splits on non-alnum, drops stopwords and 1-char", () => {
    expect(tokenize("Triage the NOISY logs for errors"))
      .toEqual(["triage", "noisy", "logs", "errors"]);
  });
});

describe("memory/explain — resolveProvenance", () => {
  it("skill_receipt → typed block with read_hint and receipt_ref", async () => {
    const dir = tmp();
    try {
      const file = path.join(dir, "r.json");
      await fs.writeFile(file, "{}", "utf8");
      const r = rec({ id: "x", kind: "skill_receipt", provenance: { source_kind: "skill_receipt", source_path: file, ref: "sk|2026" } });
      const p = resolveProvenance(r);
      expect(p.source_kind).toBe("skill_receipt");
      expect(p.exists).toBe(true);
      if (p.source_kind === "skill_receipt") {
        expect(p.receipt_ref).toBe("sk|2026");
        expect(p.read_hint).toContain("operator-owned");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("pack_artifact → typed block with pack+slug+md_path", () => {
    const r = rec({
      id: "x",
      kind: "pack_artifact",
      facets: { pack: "incident_pack", slug: "deadlock-01" },
      provenance: { source_kind: "pack_artifact", source_path: "/tmp/a.json", ref: "incident_pack:deadlock-01" },
    });
    const p = resolveProvenance(r);
    if (p.source_kind === "pack_artifact") {
      expect(p.pack).toBe("incident_pack");
      expect(p.slug).toBe("deadlock-01");
      expect(p.md_path).toBe("/tmp/a.md");
      expect(p.read_hint).toContain("ollama_artifact_read");
    }
  });

  it("approved_skill → typed block with skill_id+scope", () => {
    const r = rec({
      id: "x",
      kind: "approved_skill",
      facets: { skill_id: "triage-then-brief", scope: "project" },
      provenance: { source_kind: "approved_skill", source_path: "/tmp/s.json", ref: "triage-then-brief" },
    });
    const p = resolveProvenance(r);
    if (p.source_kind === "approved_skill") {
      expect(p.skill_id).toBe("triage-then-brief");
      expect(p.scope).toBe("project");
    }
  });

  it("candidate_proposal → typed block pointing at skill_propose", () => {
    const r = rec({
      id: "x",
      kind: "candidate_proposal",
      provenance: { source_kind: "candidate_proposal", source_path: "/tmp/log.ndjson", ref: "a→b→c" },
    });
    const p = resolveProvenance(r);
    if (p.source_kind === "candidate_proposal") {
      expect(p.pipeline_ref).toBe("a→b→c");
      expect(p.read_hint).toContain("ollama_skill_propose");
    }
  });
});

describe("memory/explain — computeAge + findDuplicates", () => {
  it("computeAge flags stale past 30 days", () => {
    const r = rec({ id: "x", created_at: "2026-03-01T00:00:00Z", indexed_at: "2026-04-01T00:00:00Z" });
    const age = computeAge(r, "2026-04-18T00:00:00Z");
    expect(age.age_days).toBe(48);
    expect(age.stale).toBe(true);
  });

  it("findDuplicates returns other records with same content_digest", () => {
    const a = rec({ id: "a", content_digest: "same".repeat(16) });
    const b = rec({ id: "b", content_digest: "same".repeat(16), kind: "approved_skill" });
    const c = rec({ id: "c", content_digest: "diff".repeat(16) });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [a, b, c] };
    const dups = findDuplicates(a, index);
    expect(dups).toHaveLength(1);
    expect(dups[0].id).toBe("b");
    expect(dups[0].kind).toBe("approved_skill");
  });
});

describe("memory/explain — readMemory", () => {
  it("returns record + resolved provenance + age + duplicates + notes", async () => {
    const r = rec({ id: "a", title: "T", summary: "S" });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
    const result = await readMemory("a", { preloaded: { index } });
    expect(result.record.id).toBe("a");
    expect(result.provenance_resolved.source_kind).toBe("skill_receipt");
    expect(result.age).toBeTruthy();
    expect(result.duplicates).toEqual([]);
    expect(result.source_excerpt).toBeNull(); // excerpt opt-in
    expect(result.notes.some((n) => n.includes("Source file not found"))).toBe(true);
  });

  it("throws on unknown id", async () => {
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [] };
    await expect(readMemory("nope", { preloaded: { index } })).rejects.toThrow(/Unknown memory_id/);
  });

  it("include_excerpt reads the source file and returns a typed excerpt for skill_receipt", async () => {
    const dir = tmp();
    try {
      const file = path.join(dir, "r.json");
      await fs.writeFile(file, JSON.stringify({
        skill_id: "s", skill_version: 1, skill_source_path: "x", started_at: "t",
        elapsed_ms: 1234, hardware_profile: "dev", inputs: {}, result: null, ok: true,
        receipt_path: file,
        steps: [
          { step_id: "a", tool: "ollama_triage_logs", ok: true, elapsed_ms: 100, envelope: { tier_used: "instant", model: "qwen", tokens_in: 10, tokens_out: 5 } },
          { step_id: "b", tool: "ollama_incident_brief", ok: false, elapsed_ms: 2000, error: { code: "TIER_TIMEOUT", message: "m", hint: "h" } },
        ],
      }), "utf8");
      const r = rec({ id: "a", kind: "skill_receipt", provenance: { source_kind: "skill_receipt", source_path: file, ref: "s|t" } });
      const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
      const result = await readMemory("a", { preloaded: { index }, include_excerpt: true });
      expect(result.source_excerpt).not.toBeNull();
      if (result.source_excerpt && result.source_excerpt.kind === "skill_receipt") {
        expect(result.source_excerpt.step_count).toBe(2);
        expect(result.source_excerpt.steps[1].error_code).toBe("TIER_TIMEOUT");
        expect(result.source_excerpt.steps[0].tier_used).toBe("instant");
        expect(result.source_excerpt.total_elapsed_ms).toBe(1234);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("include_excerpt on candidate_proposal returns facet-derived excerpt (no source file needed)", async () => {
    const r = rec({
      id: "a",
      kind: "candidate_proposal",
      facets: { support: 4, success_rate: 1, shape_agreement: 1, avg_duration_ms: 20000 },
      provenance: { source_kind: "candidate_proposal", source_path: "/tmp/log.ndjson", ref: "a→b→c" },
    });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
    const result = await readMemory("a", { preloaded: { index }, include_excerpt: true });
    if (result.source_excerpt && result.source_excerpt.kind === "candidate_proposal") {
      expect(result.source_excerpt.pipeline_tools).toEqual(["a", "b", "c"]);
      expect(result.source_excerpt.support).toBe(4);
    }
  });
});

describe("memory/explain — explainRecord (deterministic, no model)", () => {
  it("reports matched tokens per field + filter effects", async () => {
    const r = rec({
      id: "hit",
      title: "Triage logs then brief",
      summary: "Detect errors in a noisy log blob",
      tags: ["skill:triage-then-brief", "outcome:ok"],
      facets: { skill_id: "triage-then-brief", ok: true },
    });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
    const result = await explainRecord("hit", {
      query: "triage logs for errors",
      filters: { kinds: ["skill_receipt"], tags: ["skill:triage-then-brief"], facets: { ok: { equals: true } } },
      preloaded: { index },
    });
    expect(result.query_tokens).toContain("triage");
    expect(result.field_matches.title).toEqual(expect.arrayContaining(["triage", "logs"]));
    expect(result.field_matches.summary).toContain("errors");
    expect(result.filter_effects.passed_prefilter).toBe(true);
    expect(result.filter_effects.predicate_results.every((p) => p.passed)).toBe(true);
    expect(result.total_matched_tokens).toBeGreaterThan(0);
  });

  it("flags pure-semantic match when lexical overlap is zero", async () => {
    const r = rec({
      id: "semantic",
      title: "Deadlock playbook",
      summary: "A durable record of the approach we took",
      tags: [],
    });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
    const result = await explainRecord("semantic", {
      query: "triage logs for errors",
      preloaded: { index },
    });
    expect(result.total_matched_tokens).toBe(0);
    expect(result.notes.some((n) => n.includes("match is semantic"))).toBe(true);
  });

  it("flags filter failures explicitly", async () => {
    const r = rec({ id: "x", kind: "skill_receipt", tags: [] });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
    const result = await explainRecord("x", {
      query: "whatever",
      filters: { kinds: ["approved_skill"] },
      preloaded: { index },
    });
    expect(result.filter_effects.passed_prefilter).toBe(false);
    expect(result.filter_effects.predicate_results[0].passed).toBe(false);
  });

  it("narrate=true with a client adds a one-sentence narration", async () => {
    const r = rec({ id: "x", title: "Triage logs", summary: "A skill that triages logs" });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
    const fakeClient = {
      async generate() { return { model: "m", response: "Matched because the query shares 'triage' with the record title and tags.", done: true }; },
      async chat() { return { model: "m", message: { role: "assistant", content: "x" }, done: true } as never; },
      async embed() { return { model: "m", embeddings: [] }; },
      async residency() { return null; },
    };
    const result = await explainRecord("x", {
      query: "triage logs",
      preloaded: { index },
      narrate: true,
      client: fakeClient as never,
      instantModel: "m",
    });
    expect(result.narration).toBe("Matched because the query shares 'triage' with the record title and tags.");
  });

  it("narrate=false (default) adds no narration", async () => {
    const r = rec({ id: "x" });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r] };
    const result = await explainRecord("x", { query: "q", preloaded: { index } });
    expect(result.narration).toBeUndefined();
  });
});

describe("memory/explain — neighborsOf (pure math, no model)", () => {
  function mkVec(seed: number, len = 4): number[] {
    const v = Array.from({ length: len }, (_, i) => Math.sin(seed + i));
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  }

  it("ranks peers by stored-vector cosine, excludes self, kind-filters when asked", async () => {
    const a = rec({ id: "a", kind: "skill_receipt" });
    const b = rec({ id: "b", kind: "skill_receipt" });
    const c = rec({ id: "c", kind: "approved_skill" });
    const aVec = mkVec(0);
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [a, b, c] };
    const embeddings: EmbeddingsStore = {
      schema_version: 1,
      embed_model: "m",
      written_at: "t",
      entries: {
        a: { content_digest: a.content_digest, embed_model: "m", embedded_at: "t", vector: aVec },
        b: { content_digest: b.content_digest, embed_model: "m", embedded_at: "t", vector: aVec.map((x, i) => x + (i === 0 ? 0.01 : 0)) }, // very close
        c: { content_digest: c.content_digest, embed_model: "m", embedded_at: "t", vector: mkVec(5) }, // far
      },
    };
    // Self not in neighbors; 2 peers considered.
    const both = await neighborsOf("a", { preloaded: { index, embeddings }, top_k: 5 });
    expect(both.neighbors.map((n) => n.id)).not.toContain("a");
    expect(both.neighbors[0].id).toBe("b");
    expect(both.considered).toBe(2);

    // Filter to skill_receipt only — excludes c.
    const same = await neighborsOf("a", {
      preloaded: { index, embeddings },
      kinds: ["skill_receipt"],
      top_k: 5,
    });
    expect(same.neighbors.map((n) => n.id)).toEqual(["b"]);
    expect(same.neighbors_by_kind.skill_receipt).toHaveLength(1);
    expect(same.neighbors_by_kind.approved_skill).toHaveLength(0);
  });

  it("returns empty neighbors when anchor has no embedding", async () => {
    const a = rec({ id: "a" });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [a] };
    const embeddings: EmbeddingsStore = { schema_version: 1, embed_model: null, written_at: "t", entries: {} };
    const result = await neighborsOf("a", { preloaded: { index, embeddings } });
    expect(result.neighbors).toEqual([]);
    expect(result.notes[0]).toMatch(/no stored embedding/);
  });
});
