import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  loadEmbeddings,
  saveEmbeddings,
  refreshEmbeddings,
  recordEmbedText,
  queryEmbedText,
  type EmbeddingsStore,
} from "../../src/memory/embeddings.js";
import { prefilter, searchMemory } from "../../src/memory/retrieval.js";
import type { MemoryIndex, MemoryRecord } from "../../src/memory/types.js";
import type { OllamaClient, EmbedRequest, EmbedResponse } from "../../src/ollama.js";

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), "memret-")); }

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
    provenance: { source_kind: "skill_receipt", source_path: "/tmp/x", ref: "x" },
    ...overrides,
  } as MemoryRecord;
}

class FakeOllama implements Partial<OllamaClient> {
  public calls: EmbedRequest[] = [];
  public vectorFor: (text: string) => number[];
  constructor(vectorFor: (text: string) => number[]) {
    this.vectorFor = vectorFor;
  }
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    this.calls.push(req);
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    return { model: req.model, embeddings: inputs.map((t) => this.vectorFor(t)) };
  }
}

// Toy 3-dim "embedding" that makes similarity deterministic in tests:
// tokens become coordinates and vectors are normalized so cosine ≈ dot.
function toyVec(text: string): number[] {
  const bag: Record<string, number> = {};
  for (const w of text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)) {
    bag[w] = (bag[w] ?? 0) + 1;
  }
  const v = [bag["logs"] ?? 0, bag["brief"] ?? 0, bag["classify"] ?? 0];
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe("memory/embeddings", () => {
  let dir: string;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("recordEmbedText includes title + summary + tags and the `search_document:` prefix", () => {
    const r = rec({ id: "x", title: "T", summary: "S", tags: ["a", "b"] });
    const text = recordEmbedText(r);
    expect(text.startsWith("search_document:")).toBe(true);
    expect(text).toContain("T");
    expect(text).toContain("S");
    expect(text).toContain("a, b");
    expect(text).not.toContain("content_digest");
    expect(text).not.toContain("provenance");
  });

  it("queryEmbedText applies the `search_query:` prefix", () => {
    expect(queryEmbedText("hello")).toBe("search_query: hello");
  });

  it("load/save round-trip is stable", async () => {
    const store: EmbeddingsStore = {
      schema_version: 1,
      embed_model: "nomic-embed-text",
      embed_model_resolved: "nomic-embed-text:latest",
      written_at: "2026-04-18T10:00:00Z",
      entries: { "r:1": { content_digest: "d".repeat(64), embed_model: "nomic-embed-text", embed_model_resolved: "nomic-embed-text:latest", embedded_at: "2026-04-18T10:00:00Z", vector: [0.1, 0.2, 0.3] } },
    };
    await saveEmbeddings(store, { dir });
    const loaded = await loadEmbeddings({ dir });
    expect(loaded).toEqual(store);
  });

  it("refresh embeds only added + content-changed records", async () => {
    const client = new FakeOllama(toyVec);
    const r1 = rec({ id: "a", title: "a1", summary: "one", tags: [], content_digest: "a".repeat(64) });
    const r2 = rec({ id: "b", title: "b1", summary: "two", tags: [], content_digest: "b".repeat(64) });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r1, r2] };
    const first = await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });
    expect(first.drift.added_count).toBe(2);
    expect(first.drift.embed_calls).toBe(1); // batched

    // Second run with no changes → zero embed calls
    client.calls = [];
    const second = await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });
    expect(second.drift.added_count).toBe(0);
    expect(second.drift.unchanged_count).toBe(2);
    expect(second.drift.embed_calls).toBe(0);

    // Change r1's digest → one re-embed
    const r1b = { ...r1, content_digest: "c".repeat(64) };
    const index2: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r1b, r2] };
    client.calls = [];
    const third = await refreshEmbeddings(index2, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });
    expect(third.drift.added_count).toBe(0);
    expect(third.drift.updated_count).toBe(1);
    expect(third.drift.unchanged_count).toBe(1);
    expect(third.drift.embed_calls).toBe(1);

    // Remove r2 from index → removed_count bumps, no re-embed
    const index3: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r1b] };
    client.calls = [];
    const fourth = await refreshEmbeddings(index3, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });
    expect(fourth.drift.removed_count).toBe(1);
    expect(fourth.drift.embed_calls).toBe(0);
    const store = await loadEmbeddings({ dir });
    expect(store.entries["b"]).toBeUndefined();
  });

  it("tag change invalidates all prior vectors", async () => {
    const client = new FakeOllama(toyVec);
    const r1 = rec({ id: "a", title: "a", summary: "s", content_digest: "a".repeat(64) });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r1] };
    await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "old-model" });
    client.calls = [];
    const drift = await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "new-model" });
    expect(drift.drift.model_invalidated_count).toBe(1);
    expect(drift.drift.added_count).toBe(1); // re-embedded as if new
  });

  it("silent tag drift (same tag, resolved id changed) invalidates all prior vectors", async () => {
    // Simulate Ollama silently bumping :latest — the tag stays "nomic-embed-text"
    // but the model the server returns changes id. This is the exact failure
    // mode the resolved-id tracking exists to catch.
    let currentResolved = "nomic-embed-text:v1";
    const client = {
      calls: [] as EmbedRequest[],
      async embed(req: EmbedRequest): Promise<EmbedResponse> {
        this.calls.push(req);
        const inputs = Array.isArray(req.input) ? req.input : [req.input];
        return { model: currentResolved, embeddings: inputs.map((t) => toyVec(t)) };
      },
    };
    const r1 = rec({ id: "a", title: "a", summary: "s", content_digest: "a".repeat(64) });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r1] };
    await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });

    // Ollama silently rotates :latest to v2.
    currentResolved = "nomic-embed-text:v2";
    const drift = await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });
    expect(drift.drift.model_invalidated_count).toBe(1);
    expect(drift.drift.added_count).toBe(1);
  });

  it("same resolved id → unchanged, no re-embed (no tag drift)", async () => {
    const client = new FakeOllama(toyVec); // returns model: req.model as resolved id
    const r1 = rec({ id: "a", title: "a", summary: "s", content_digest: "a".repeat(64) });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r1] };
    await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });
    client.calls = [];
    const drift = await refreshEmbeddings(index, { dir, client: client as unknown as OllamaClient, embedModel: "nomic-embed-text" });
    expect(drift.drift.model_invalidated_count).toBe(0);
    expect(drift.drift.unchanged_count).toBe(1);
  });
});

describe("memory/retrieval prefilter", () => {
  const r1 = rec({ id: "1", kind: "skill_receipt", tags: ["skill:triage", "outcome:ok"], facets: { ok: true, hardware_profile: "dev-rtx5080" } });
  const r2 = rec({ id: "2", kind: "approved_skill", tags: ["status:approved"], facets: { status: "approved" } });
  const r3 = rec({ id: "3", kind: "skill_receipt", tags: ["skill:triage", "outcome:failed"], facets: { ok: false } });

  it("filters by kind (OR across kinds)", () => {
    const { survivors } = prefilter([r1, r2, r3], { kinds: ["skill_receipt"] });
    expect(survivors.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("filters by tag (AND across tags)", () => {
    const { survivors, matchReasons } = prefilter([r1, r2, r3], { tags: ["skill:triage", "outcome:ok"] });
    expect(survivors.map((r) => r.id)).toEqual(["1"]);
    expect(matchReasons.get("1")?.tags).toEqual(["skill:triage", "outcome:ok"]);
  });

  it("filters by facet equality", () => {
    const { survivors } = prefilter([r1, r2, r3], { facets: { ok: { equals: true } } });
    expect(survivors.map((r) => r.id)).toEqual(["1"]);
  });

  it("combines kind + tag + facet (AND)", () => {
    const { survivors } = prefilter([r1, r2, r3], {
      kinds: ["skill_receipt"],
      tags: ["skill:triage"],
      facets: { ok: { equals: true } },
    });
    expect(survivors.map((r) => r.id)).toEqual(["1"]);
  });
});

describe("memory/retrieval searchMemory", () => {
  it("ranks by cosine, flags weak, applies prefilter, returns reasons", async () => {
    const client = new FakeOllama(toyVec);
    const r1 = rec({ id: "triage-hit", title: "Triage logs", summary: "errors in the logs", tags: ["skill:triage-then-brief"], content_digest: "1".repeat(64) });
    const r2 = rec({ id: "classify-hit", title: "Classify thing", summary: "classify classify classify", tags: ["skill:classify"], content_digest: "2".repeat(64) });
    const r3 = rec({ id: "brief-hit", title: "Brief it", summary: "brief brief logs", tags: ["skill:brief"], content_digest: "3".repeat(64) });
    const index: MemoryIndex = { schema_version: 1, indexed_at: "t", records: [r1, r2, r3] };
    const embeddings: EmbeddingsStore = {
      schema_version: 1,
      embed_model: "nomic-embed-text",
      embed_model_resolved: "nomic-embed-text:latest",
      written_at: "t",
      entries: {
        "triage-hit": { content_digest: r1.content_digest, embed_model: "nomic-embed-text", embed_model_resolved: "nomic-embed-text:latest", embedded_at: "t", vector: toyVec(recordEmbedText(r1)) },
        "classify-hit": { content_digest: r2.content_digest, embed_model: "nomic-embed-text", embed_model_resolved: "nomic-embed-text:latest", embedded_at: "t", vector: toyVec(recordEmbedText(r2)) },
        "brief-hit": { content_digest: r3.content_digest, embed_model: "nomic-embed-text", embed_model_resolved: "nomic-embed-text:latest", embedded_at: "t", vector: toyVec(recordEmbedText(r3)) },
      },
    };

    const result = await searchMemory(
      "help me triage logs for errors",
      {},
      {
        client: client as unknown as OllamaClient,
        embedModel: "nomic-embed-text",
        preloaded: { index, embeddings },
      },
    );
    expect(result.considered).toBe(3);
    expect(result.candidates_after_prefilter).toBe(3);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].record.id).toBe("triage-hit"); // "logs" token wins
    expect(result.hits[0].reasons.some((r) => r.startsWith("cosine:"))).toBe(true);
  });

  it("prefilter with zero matches returns empty + weak", async () => {
    const client = new FakeOllama(toyVec);
    const r1 = rec({ id: "a", kind: "skill_receipt", content_digest: "a".repeat(64) });
    const result = await searchMemory(
      "anything",
      { kinds: ["pack_artifact"] },
      {
        client: client as unknown as OllamaClient,
        embedModel: "nomic-embed-text",
        preloaded: {
          index: { schema_version: 1, indexed_at: "t", records: [r1] },
          embeddings: { schema_version: 1, embed_model: "nomic-embed-text", embed_model_resolved: "nomic-embed-text:latest", written_at: "t", entries: {} },
        },
      },
    );
    expect(result.candidates_after_prefilter).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.weak).toBe(true);
    expect(client.calls).toEqual([]); // never embedded the query
  });
});
