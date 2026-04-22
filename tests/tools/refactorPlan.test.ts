/**
 * Tests for ollama_refactor_plan.
 *
 * Locks:
 *   - happy path produces phases with renumbered indices
 *   - empty rollback_strategy → weak=true even with phases present
 *   - priority flag makes it into the prompt so the caller's bias is honored
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleRefactorPlan,
  refactorPlanSchema,
} from "../../src/tools/refactorPlan.js";
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

describe("ollama_refactor_plan — happy path", () => {
  it("returns phases, renumbers them 1..N, and keeps only in-scope files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rp-happy-"));
    try {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      await writeFile(a, "// a\n", "utf8");
      await writeFile(b, "// b\n", "utf8");

      const modelOut = JSON.stringify({
        // Intentionally out-of-order phases + bogus file → tests sort + filter.
        phases: [
          { phase: 3, files_involved: [a], reason: "rename step", tests_to_write: ["unit test A"], parallelizable: false },
          { phase: 1, files_involved: [a, "/totally/not/in/input.ts"], reason: "prep tests", tests_to_write: ["baseline coverage"], parallelizable: true },
          { phase: 2, files_involved: [b], reason: "follow-on consumer update", tests_to_write: [], parallelizable: false },
        ],
        sequencing_notes: "Tests first, then rename, then consumer.",
        rollback_strategy: "Revert commit per phase; tests from phase 1 serve as a safety net.",
      });

      const client = new MockClient(modelOut);
      const env = await handleRefactorPlan(
        {
          files: [a, b],
          change_description: "Rename a shared symbol across both files; tests land first.",
          priority: "safety",
        },
        makeCtx(client),
      );

      expect(env.result.phases).toHaveLength(3);
      // Renumbered 1..3.
      expect(env.result.phases.map((p) => p.phase)).toEqual([1, 2, 3]);
      // Bogus out-of-scope file stripped.
      const firstPhase = env.result.phases[0];
      expect(firstPhase.files_involved).toContain(a);
      expect(firstPhase.files_involved.every((f) => f === a || f === b)).toBe(true);
      expect(env.result.estimated_phases).toBe(3);
      expect(env.result.weak).toBe(false);
      // Priority hint made it into the prompt.
      expect(client.lastPrompt ?? "").toMatch(/SAFETY/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ollama_refactor_plan — weak detection", () => {
  it("flips weak=true when rollback_strategy is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rp-weak-"));
    try {
      const a = join(dir, "a.ts");
      await writeFile(a, "// a\n", "utf8");

      const modelOut = JSON.stringify({
        phases: [
          { phase: 1, files_involved: [a], reason: "do it", tests_to_write: ["t"], parallelizable: false },
        ],
        sequencing_notes: "Just do it.",
        rollback_strategy: "",
      });

      const client = new MockClient(modelOut);
      const env = await handleRefactorPlan(
        { files: [a], change_description: "Refactor the one-file utility for clarity." },
        makeCtx(client),
      );
      expect(env.result.weak).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ollama_refactor_plan — input validation", () => {
  it("rejects change_description < 20 chars at schema parse", () => {
    const res = refactorPlanSchema.safeParse({
      files: ["/tmp/a.ts"],
      change_description: "too short",
    });
    expect(res.success).toBe(false);
  });
});

describe("ollama_refactor_plan — priority hinting", () => {
  it("passes a 'PARALLELISM' hint into the prompt when priority='parallelism'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rp-prio-"));
    try {
      const a = join(dir, "a.ts");
      await writeFile(a, "// a\n", "utf8");
      const client = new MockClient(JSON.stringify({
        phases: [{ phase: 1, files_involved: [a], reason: "r", tests_to_write: ["t"], parallelizable: true }],
        sequencing_notes: "n",
        rollback_strategy: "r",
      }));
      await handleRefactorPlan(
        { files: [a], change_description: "A one-file refactor for tests of priority.", priority: "parallelism" },
        makeCtx(client),
      );
      expect(client.lastPrompt ?? "").toMatch(/PARALLELISM/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
