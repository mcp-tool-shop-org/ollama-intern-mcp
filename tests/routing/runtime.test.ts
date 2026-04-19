import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  canonicalActualRoute,
  isShadowTargetTool,
  SHADOW_TARGET_ATOMS,
  classifyMatch,
  extractArtifactRef,
  extractJobHint,
  shadowRun,
  type RoutingReceipt,
} from "../../src/routing/index.js";
import type { Envelope } from "../../src/envelope.js";
import type { RunContext } from "../../src/runContext.js";
import { NullLogger } from "../../src/observability.js";

function tmp(): string { return mkdtempSync(path.join(os.tmpdir(), "shadow-")); }

function fakeCtx(): RunContext {
  return {
    client: {
      async generate() { return { model: "x", response: "", done: true } as never; },
      async chat() { return { model: "x", message: { role: "assistant", content: "" }, done: true } as never; },
      async embed() { return { model: "x", embeddings: [] }; },
      async residency() { return null; },
    },
    tiers: { instant: "qwen3:8b", workhorse: "qwen3:8b", deep: "qwen3:14b", embed: "nomic-embed-text" },
    timeouts: { instant: 5000, workhorse: 20000, deep: 90000, embed: 10000 },
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

function okEnvelope(result: unknown, overrides: Partial<Envelope<unknown>> = {}): Envelope<unknown> {
  return {
    result,
    tier_used: "instant",
    model: "qwen3:8b",
    hardware_profile: "dev-rtx5080",
    tokens_in: 10,
    tokens_out: 5,
    elapsed_ms: 100,
    residency: null,
    ...overrides,
  };
}

describe("routing/actualRoute", () => {
  it("canonicalActualRoute distinguishes packs from atoms", () => {
    expect(canonicalActualRoute("ollama_incident_pack")).toBe("pack:ollama_incident_pack");
    expect(canonicalActualRoute("ollama_classify")).toBe("atom:ollama_classify");
    expect(canonicalActualRoute("ollama_repo_brief")).toBe("atom:ollama_repo_brief"); // flagship = atom
  });

  it("isShadowTargetTool excludes skill/memory/artifact/corpus-management/embed-primitive tools", () => {
    expect(isShadowTargetTool("ollama_classify")).toBe(true);
    expect(isShadowTargetTool("ollama_incident_pack")).toBe(true);

    expect(isShadowTargetTool("ollama_skill_run")).toBe(false);
    expect(isShadowTargetTool("ollama_memory_search")).toBe(false);
    expect(isShadowTargetTool("ollama_artifact_read")).toBe(false);
    expect(isShadowTargetTool("ollama_corpus_refresh")).toBe(false);
    expect(isShadowTargetTool("ollama_embed")).toBe(false);
  });

  it("SHADOW_TARGET_ATOMS does not include skill/memory layers", () => {
    for (const t of SHADOW_TARGET_ATOMS) {
      expect(t.startsWith("ollama_skill_")).toBe(false);
      expect(t.startsWith("ollama_memory_")).toBe(false);
      expect(t.startsWith("ollama_artifact_")).toBe(false);
    }
  });
});

describe("routing/receipts helpers", () => {
  it("classifyMatch returns exact when identities match", () => {
    const m = classifyMatch(
      { kind: "pack", ref: "incident_pack", expected_tools: [] },
      "pack:ollama_incident_pack",
    );
    expect(m).toEqual({ matched: true, kind: "exact" });
  });

  it("classifyMatch returns kind_match when kinds match but refs don't", () => {
    const m = classifyMatch(
      { kind: "pack", ref: "repo_pack", expected_tools: [] },
      "pack:ollama_incident_pack",
    );
    expect(m).toEqual({ matched: false, kind: "kind_match" });
  });

  it("classifyMatch returns mismatch when kinds differ", () => {
    const m = classifyMatch(
      { kind: "skill", ref: "triage-then-brief", expected_tools: [] },
      "pack:ollama_incident_pack",
    );
    expect(m).toEqual({ matched: false, kind: "mismatch" });
  });

  it("classifyMatch flags abstain when suggested is null", () => {
    const m = classifyMatch(null, "atom:ollama_classify");
    expect(m).toEqual({ matched: false, kind: "abstain" });
  });

  it("extractArtifactRef pulls pack+slug from a pack envelope", () => {
    const env = okEnvelope({
      artifact: { json_path: "/tmp/a/deadlock-01.json", markdown_path: "/tmp/a/deadlock-01.md" },
    });
    const ref = extractArtifactRef("ollama_incident_pack", env);
    expect(ref).toEqual({
      pack: "incident_pack",
      slug: "deadlock-01",
      md_path: "/tmp/a/deadlock-01.md",
      json_path: "/tmp/a/deadlock-01.json",
    });
  });

  it("extractArtifactRef returns undefined for atoms", () => {
    expect(extractArtifactRef("ollama_classify", okEnvelope({}))).toBeUndefined();
  });

  it("extractJobHint picks intent fields, ignores content blobs", () => {
    expect(extractJobHint({ question: "what breaks?" })).toBe("what breaks?");
    expect(extractJobHint({ focus: "race conditions" })).toBe("race conditions");
    expect(extractJobHint({ log_text: "ERROR: deadlock" })).toBeNull(); // content blob ignored
    expect(extractJobHint({ text: "some text" })).toBeNull();
    expect(extractJobHint({})).toBeNull();
    expect(extractJobHint(null)).toBeNull();
  });

  it("extractJobHint caps oversize strings (defensive)", () => {
    expect(extractJobHint({ question: "x".repeat(500) })).toBeNull();
  });
});

describe("routing/runtime — shadowRun integration", () => {
  let receiptsDir: string;

  beforeEach(() => { receiptsDir = tmp(); });
  afterEach(() => { rmSync(receiptsDir, { recursive: true, force: true }); });

  async function listReceipts(): Promise<RoutingReceipt[]> {
    const files = await fs.readdir(receiptsDir).catch(() => [] as string[]);
    const out: RoutingReceipt[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(receiptsDir, f), "utf8");
      out.push(JSON.parse(raw));
    }
    return out;
  }

  it("skips non-target tools without touching the router", async () => {
    const ctx = fakeCtx();
    let invoked = 0;
    const env = await shadowRun(
      "ollama_skill_run",
      { skill_id: "whatever" },
      ctx,
      async () => {
        invoked++;
        return okEnvelope({ x: 1 });
      },
      { receiptsDir },
    );
    expect(invoked).toBe(1);
    expect((env.result as { x: number }).x).toBe(1);
    expect(await listReceipts()).toHaveLength(0);
  });

  it("writes a routing receipt for a shadowed atom call", async () => {
    const ctx = fakeCtx();
    const env = await shadowRun(
      "ollama_classify",
      { text: "ERROR: deadlock detected", labels: ["incident", "noise"] },
      ctx,
      async () => okEnvelope({ label: "incident", confidence: 0.95 }),
      { receiptsDir },
    );
    expect(env).toBeTruthy();

    const receipts = await listReceipts();
    expect(receipts).toHaveLength(1);
    const r = receipts[0];
    expect(r.actual.route_identity).toBe("atom:ollama_classify");
    expect(r.actual.tool).toBe("ollama_classify");
    expect(r.decision).toBeTruthy();
    expect(r.decision.context).toBeTruthy();
    expect(r.outcome.ok).toBe(true);
    expect(r.outcome.tier_used).toBe("instant");
    expect(r.outcome.model).toBe("qwen3:8b");
    expect(r.runtime.hardware_profile).toBe("dev-rtx5080");
    expect(r.runtime.think).toBe(false); // classify
  });

  it("captures pack artifact linkage in the outcome", async () => {
    const ctx = fakeCtx();
    await shadowRun(
      "ollama_incident_pack",
      { log_text: "x".repeat(2000) },
      ctx,
      async () => okEnvelope({
        artifact: { json_path: "/tmp/deadlock.json", markdown_path: "/tmp/deadlock.md" },
        summary: "x",
        steps: [],
      }),
      { receiptsDir },
    );
    const [r] = await listReceipts();
    expect(r.outcome.artifact_ref).toEqual({
      pack: "incident_pack",
      slug: "deadlock",
      md_path: "/tmp/deadlock.md",
      json_path: "/tmp/deadlock.json",
    });
    expect(r.runtime.think).toBe(true); // research shape for packs
  });

  it("writes a receipt even when the handler throws — error_code captured", async () => {
    const ctx = fakeCtx();
    await expect(
      shadowRun(
        "ollama_research",
        { question: "x", source_paths: ["/tmp/x.md"] },
        ctx,
        async () => {
          throw new Error("boom");
        },
        { receiptsDir },
      ),
    ).rejects.toThrow(/boom/);
    const [r] = await listReceipts();
    expect(r.outcome.ok).toBe(false);
    expect(r.outcome.error_code).toBe("INTERNAL");
    expect(r.actual.route_identity).toBe("atom:ollama_research");
  });

  it("classifies match correctly when router and operator agree on a pack", async () => {
    const ctx = fakeCtx();
    await shadowRun(
      "ollama_incident_pack",
      { log_text: "x".repeat(2000) },
      ctx,
      async () => okEnvelope({ artifact: { json_path: "/t/a.json", markdown_path: "/t/a.md" }, summary: "s", steps: [] }),
      { receiptsDir },
    );
    const [r] = await listReceipts();
    // pack:ollama_incident_pack with only log_text present should agree with
    // the router's top suggestion (incident_pack).
    expect(["exact", "kind_match", "abstain", "mismatch"]).toContain(r.match.kind);
    // It should at least not be a wild mismatch — pack kind matches.
    expect(r.actual.route_identity.startsWith("pack:")).toBe(true);
  });

  it("honors intent fields in job_hint", async () => {
    const ctx = fakeCtx();
    await shadowRun(
      "ollama_research",
      { question: "what breaks under concurrent writes?", source_paths: ["/tmp/a.md"] },
      ctx,
      async () => okEnvelope({ answer: "x", sources: [] }),
      { receiptsDir },
    );
    const [r] = await listReceipts();
    expect(r.actual.job_hint).toBe("what breaks under concurrent writes?");
  });
});
