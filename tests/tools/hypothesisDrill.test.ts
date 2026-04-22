/**
 * Tests for ollama_hypothesis_drill.
 *
 * Locks:
 *   - happy path over a fixture incident_pack artifact
 *   - out-of-range hypothesis_index → HYPOTHESIS_INDEX_INVALID
 *   - missing artifact slug → ARTIFACT_NOT_FOUND
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleHypothesisDrill } from "../../src/tools/hypothesisDrill.js";
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
import type { IncidentPackArtifact } from "../../src/tools/packs/incidentPack.js";

class MockClient implements OllamaClient {
  public lastPrompt?: string;
  constructor(private raw: string) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.lastPrompt = req.prompt;
    return { model: req.model, response: this.raw, done: true, prompt_eval_count: 100, eval_count: 40 };
  }
  async chat(_r: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(_r: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
  async residency(_m: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient): RunContext {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

function sampleArtifact(slug: string, jsonPath: string, mdPath: string): IncidentPackArtifact {
  return {
    schema_version: 1,
    pack: "incident_pack",
    generated_at: "2026-04-21T00:00:00.000Z",
    hardware_profile: "dev-rtx5080",
    title: "Fixture incident",
    slug,
    input: { has_log_text: true, source_paths: [], corpus: null, corpus_query: null },
    triage: null,
    brief: {
      root_cause_hypotheses: [
        { hypothesis: "DNS flapping upstream", confidence: "medium", evidence_refs: ["e1"] },
        { hypothesis: "TLS cert renewal slipped", confidence: "low", evidence_refs: [] },
      ],
      affected_surfaces: [{ surface: "auth service", evidence_refs: ["e1"] }],
      timeline_clues: [],
      next_checks: [{ check: "inspect resolv.conf", why: "DNS suspect" }],
      evidence: [
        { id: "e1", kind: "log", ref: "log-window-1", excerpt: "EAI_AGAIN on upstream resolver at 02:17" },
      ],
      weak: false,
      coverage_notes: [],
      corpus_used: null,
    },
    steps: [],
    artifact: { markdown_path: mdPath, json_path: jsonPath },
  };
}

async function writeFixture(dir: string, slug: string): Promise<{ jsonPath: string }> {
  const jsonPath = join(dir, `${slug}.json`);
  const mdPath = join(dir, `${slug}.md`);
  const art = sampleArtifact(slug, jsonPath, mdPath);
  await writeFile(jsonPath, JSON.stringify(art, null, 2), "utf8");
  await writeFile(mdPath, "# fixture\n", "utf8");
  return { jsonPath };
}

describe("ollama_hypothesis_drill — happy path", () => {
  it("drills into the selected hypothesis with evidence previews and summarizes the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hd-happy-"));
    try {
      const slug = "fixture-happy";
      await writeFixture(dir, slug);

      const modelOut = JSON.stringify({
        supporting_reasoning: "The log shows intermittent EAI_AGAIN errors consistent with upstream DNS flapping.",
        ruled_out_reasons: "No correlated TLS errors in the window.",
        confidence: "medium",
      });
      const client = new MockClient(modelOut);

      const env = await handleHypothesisDrill(
        { artifact_slug: slug, hypothesis_index: 0, extra_artifact_dirs: [dir] },
        makeCtx(client),
      );

      expect(env.result.parent_artifact_slug).toBe(slug);
      expect(env.result.drilled_hypothesis.statement).toMatch(/DNS flapping/);
      expect(env.result.drilled_hypothesis.evidence_cited).toHaveLength(1);
      expect(env.result.drilled_hypothesis.evidence_cited[0].id).toBe("e1");
      expect(env.result.drilled_hypothesis.confidence).toBe("medium");
      expect(env.result.other_hypotheses_summary).toHaveLength(1);
      expect(env.result.other_hypotheses_summary[0].index).toBe(1);
      expect(env.result.weak).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ollama_hypothesis_drill — invalid index", () => {
  it("throws HYPOTHESIS_INDEX_INVALID when the index exceeds the hypothesis count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hd-idx-"));
    try {
      const slug = "fixture-idx";
      await writeFixture(dir, slug);
      const client = new MockClient("{}");
      await expect(
        handleHypothesisDrill(
          { artifact_slug: slug, hypothesis_index: 99, extra_artifact_dirs: [dir] },
          makeCtx(client),
        ),
      ).rejects.toThrow(/HYPOTHESIS_INDEX_INVALID|out of range/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ollama_hypothesis_drill — missing artifact", () => {
  it("throws ARTIFACT_NOT_FOUND when the slug has no matching incident_pack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hd-miss-"));
    try {
      const client = new MockClient("{}");
      await expect(
        handleHypothesisDrill(
          { artifact_slug: "does-not-exist", hypothesis_index: 0, extra_artifact_dirs: [dir] },
          makeCtx(client),
        ),
      ).rejects.toThrow(/ARTIFACT_NOT_FOUND|No incident_pack artifact/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
