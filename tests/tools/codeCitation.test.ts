/**
 * Tests for ollama_code_citation.
 *
 * Locks:
 *   - happy path: per-claim citations with excerpts pulled from the loaded file
 *   - out-of-scope citations are stripped and warning added (same rule as research)
 *   - bad line ranges are stripped
 *   - answer-without-citations flips weak=true
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleCodeCitation } from "../../src/tools/codeCitation.js";
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

describe("ollama_code_citation — happy path", () => {
  it("returns per-claim citations with excerpts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-happy-"));
    try {
      const a = join(dir, "a.ts");
      const body = [
        "export function validate(x: string): boolean {",
        "  if (!x) return false;",
        "  return x.length > 3;",
        "}",
        "",
        "export const NAME = 'demo';",
      ].join("\n");
      await writeFile(a, body, "utf8");

      const modelOut = JSON.stringify({
        answer: "The validate function rejects empty input and requires length > 3.",
        citations: [
          { claim_fragment: "rejects empty input", file: a, start_line: 2, end_line: 2 },
          { claim_fragment: "requires length > 3", file: a, start_line: 3, end_line: 3 },
        ],
        uncited_fragments: [],
      });
      const client = new MockClient(modelOut);

      const env = await handleCodeCitation(
        {
          question: "How does the validate function reject input?",
          source_paths: [a],
        },
        makeCtx(client),
      );

      expect(env.result.citations).toHaveLength(2);
      expect(env.result.citations[0].excerpt).toContain("if (!x)");
      expect(env.result.citations[1].excerpt).toContain("length > 3");
      expect(env.result.weak).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ollama_code_citation — citation validation", () => {
  it("strips citations pointing at files outside source_paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-scope-"));
    try {
      const a = join(dir, "a.ts");
      await writeFile(a, "const x = 1;\nconst y = 2;\n", "utf8");

      const modelOut = JSON.stringify({
        answer: "x is 1 per a.ts; y comes from another file.",
        citations: [
          { claim_fragment: "x is 1", file: a, start_line: 1, end_line: 1 },
          { claim_fragment: "y comes from another file", file: "/not/in/scope.ts", start_line: 1, end_line: 1 },
        ],
        uncited_fragments: [],
      });

      const client = new MockClient(modelOut);
      const env = await handleCodeCitation(
        { question: "Where is x defined and what is it?", source_paths: [a] },
        makeCtx(client),
      );
      expect(env.result.citations).toHaveLength(1);
      expect(env.result.citations[0].file).toBe(a);
      expect((env.warnings ?? []).some((w) => /not in source_paths/.test(w))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strips citations whose line range exceeds the file bounds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-range-"));
    try {
      const a = join(dir, "a.ts");
      await writeFile(a, "const x = 1;\n", "utf8"); // 2 lines (with trailing newline producing empty second).

      const modelOut = JSON.stringify({
        answer: "x is 1.",
        citations: [{ claim_fragment: "x is 1", file: a, start_line: 999, end_line: 1000 }],
        uncited_fragments: [],
      });

      const client = new MockClient(modelOut);
      const env = await handleCodeCitation(
        { question: "What value does x hold in this file?", source_paths: [a] },
        makeCtx(client),
      );
      expect(env.result.citations).toHaveLength(0);
      expect((env.warnings ?? []).some((w) => /outside the loaded file bounds/.test(w))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ollama_code_citation — weak detection", () => {
  it("flips weak=true when the answer has no citations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-weak-"));
    try {
      const a = join(dir, "a.ts");
      await writeFile(a, "const x = 1;\n", "utf8");

      const modelOut = JSON.stringify({
        answer: "Something vague with no anchors.",
        citations: [],
        uncited_fragments: ["Something vague"],
      });

      const client = new MockClient(modelOut);
      const env = await handleCodeCitation(
        { question: "What does this file define?", source_paths: [a] },
        makeCtx(client),
      );
      expect(env.result.weak).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
