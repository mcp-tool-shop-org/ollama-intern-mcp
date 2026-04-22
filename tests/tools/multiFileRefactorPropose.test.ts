/**
 * Tests for ollama_multi_file_refactor_propose.
 *
 * Locks:
 *   - happy-path shape with per-file changes + imports + verification_steps
 *   - input validation: < 20 chars on change_description → SCHEMA_INVALID
 *   - weak flip: model returns shape but empty before/after → weak=true
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handleMultiFileRefactorPropose,
  multiFileRefactorProposeSchema,
} from "../../src/tools/multiFileRefactorPropose.js";
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

describe("ollama_multi_file_refactor_propose — happy path", () => {
  it("returns per_file_changes for every input file, plus imports and verification steps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mfrp-happy-"));
    try {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      await writeFile(a, "export const legacyName = 1;\n", "utf8");
      await writeFile(b, "import { legacyName } from './a';\nconsole.log(legacyName);\n", "utf8");

      const modelOut = JSON.stringify({
        per_file_changes: [
          {
            file: a,
            before_summary: "Exports a constant legacyName.",
            after_summary: "Exports a constant renamedName.",
            risk_level: "low",
            change_kinds: ["rename"],
          },
          {
            file: b,
            before_summary: "Imports and logs legacyName.",
            after_summary: "Imports and logs renamedName.",
            risk_level: "medium",
            change_kinds: ["import-update"],
          },
        ],
        cross_file_impact: "Both files move together; b's import must update in the same commit as a's rename.",
        affected_imports: [{ from: "legacyName", to: "renamedName", files: [b] }],
        verification_steps: ["tsc --noEmit", "grep -r legacyName src || echo clean"],
      });

      const client = new MockClient(modelOut);
      const env = await handleMultiFileRefactorPropose(
        {
          files: [a, b],
          change_description: "Rename the exported constant legacyName to renamedName across both files.",
        },
        makeCtx(client),
      );

      expect(env.result.per_file_changes).toHaveLength(2);
      expect(env.result.per_file_changes[0].risk_level).toBe("low");
      expect(env.result.per_file_changes[1].change_kinds).toContain("import-update");
      expect(env.result.affected_imports[0].from).toBe("legacyName");
      expect(env.result.verification_steps).toContain("tsc --noEmit");
      expect(env.result.weak).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ollama_multi_file_refactor_propose — input validation", () => {
  it("rejects change_description shorter than 20 chars at schema parse", () => {
    const res = multiFileRefactorProposeSchema.safeParse({
      files: ["/tmp/a.ts"],
      change_description: "too short",
    });
    expect(res.success).toBe(false);
  });

  it("rejects more than 20 files at schema parse", () => {
    const res = multiFileRefactorProposeSchema.safeParse({
      files: Array.from({ length: 21 }, (_, i) => `/tmp/f${i}.ts`),
      change_description: "Rename something across a lot of files for real.",
    });
    expect(res.success).toBe(false);
  });
});

describe("ollama_multi_file_refactor_propose — weak output", () => {
  it("flips weak=true when per_file_changes coverage is incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mfrp-weak-"));
    try {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      await writeFile(a, "// a\n", "utf8");
      await writeFile(b, "// b\n", "utf8");

      // Model only covers one of two files, and strings are empty.
      const modelOut = JSON.stringify({
        per_file_changes: [
          { file: a, before_summary: "", after_summary: "", risk_level: "low", change_kinds: [] },
        ],
        cross_file_impact: "",
        affected_imports: [],
        verification_steps: [],
      });

      const client = new MockClient(modelOut);
      const env = await handleMultiFileRefactorPropose(
        {
          files: [a, b],
          change_description: "Split a combined util into two utilities for clarity.",
        },
        makeCtx(client),
      );
      expect(env.result.weak).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
