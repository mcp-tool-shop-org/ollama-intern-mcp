/**
 * ollama_code_map tests — deterministic structural summary; no LLM.
 *
 * Fixtures are tiny tmpdir scaffolds so we prove:
 *   - a TS repo with package.json lights up vitest/typescript framework hints
 *   - max_files_hit surfaces the truncation warning
 *   - a multi-language tree aggregates by extension correctly
 *   - empty source_paths are rejected via zod
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleCodeMap, codeMapSchema } from "../../src/tools/codeMap.js";
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

class QuietClient implements OllamaClient {
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> { throw new Error("n/a"); }
  async residency(_m: string): Promise<Residency | null> { return null; }
  async probe(_ms?: number): Promise<{ ok: boolean; reason?: string }> { return { ok: true }; }
}

function makeCtx(): RunContext & { logger: NullLogger } {
  return {
    client: new QuietClient(),
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-codemap-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ollama_code_map", () => {
  it("recognizes a TS/vitest repo — frameworks + build_commands + notable", async () => {
    const pkg = {
      name: "tiny",
      version: "0.0.0",
      scripts: { test: "vitest run", build: "tsc -p ." },
      devDependencies: { vitest: "^1", typescript: "^5" },
      dependencies: { zod: "^3" },
      bin: "dist/cli.js",
    };
    await writeFile(join(tempDir, "package.json"), JSON.stringify(pkg), "utf8");
    await writeFile(join(tempDir, "README.md"), "# tiny\n", "utf8");
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "index.ts"), "export const x = 1;\n", "utf8");
    await writeFile(join(tempDir, "src", "main.ts"), "console.log('hi');\n", "utf8");
    await mkdir(join(tempDir, "tests"), { recursive: true });
    await writeFile(join(tempDir, "tests", "a.test.ts"), "test('x', () => {});\n", "utf8");

    const env = await handleCodeMap({ source_paths: [tempDir] }, makeCtx());
    expect(env.result.frameworks).toContain("vitest");
    expect(env.result.frameworks).toContain("typescript");
    expect(env.result.frameworks).toContain("zod");
    expect(env.result.build_commands).toContain("npm run test");
    expect(env.result.build_commands).toContain("npm run build");
    // notable_files should include both README and package.json
    expect(env.result.notable_files.some((f) => f.endsWith("README.md"))).toBe(true);
    expect(env.result.notable_files.some((f) => f.endsWith("package.json"))).toBe(true);
    // entrypoints: bin CLI + index.ts (lib) + main.ts (cli) + test file
    const types = env.result.entrypoints.map((e) => e.type);
    expect(types).toContain("cli");
    expect(types).toContain("lib");
    expect(types).toContain("test");
    // language tally includes .ts
    expect(env.result.languages.some((l) => l.ext === ".ts")).toBe(true);
  });

  it("rejects empty source_paths via zod", () => {
    const parsed = codeMapSchema.safeParse({ source_paths: [] });
    expect(parsed.success).toBe(false);
  });

  it("flips max_files_hit + warning when capped", async () => {
    const dir = join(tempDir, "src");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      await writeFile(join(dir, `f${i}.ts`), "// ignore\n", "utf8");
    }
    const env = await handleCodeMap({ source_paths: [dir], max_files: 5 }, makeCtx());
    expect(env.result.total_files_scanned).toBe(5);
    expect(env.result.max_files_hit).toBe(true);
    expect(env.warnings?.some((w) => w.includes("max_files"))).toBe(true);
  });

  it("aggregates a multi-language tree and skips node_modules", async () => {
    await writeFile(join(tempDir, "a.py"), "print('x')\n", "utf8");
    await writeFile(join(tempDir, "b.rs"), "fn main() {}\n", "utf8");
    await writeFile(join(tempDir, "c.go"), "package main\n", "utf8");
    // Files inside node_modules should be ignored.
    await mkdir(join(tempDir, "node_modules", "junk"), { recursive: true });
    await writeFile(join(tempDir, "node_modules", "junk", "x.js"), "", "utf8");

    const env = await handleCodeMap({ source_paths: [tempDir] }, makeCtx());
    const exts = env.result.languages.map((l) => l.ext);
    expect(exts).toContain(".py");
    expect(exts).toContain(".rs");
    expect(exts).toContain(".go");
    expect(exts).not.toContain(".js");
    expect(env.result.total_files_scanned).toBe(3);
  });

  it("surfaces Cargo.toml framework hints", async () => {
    const cargo = `[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\ntokio = "1"\nserde = "1"\nclap = "4"\n`;
    await writeFile(join(tempDir, "Cargo.toml"), cargo, "utf8");
    await writeFile(join(tempDir, "main.rs"), "fn main() {}\n", "utf8");
    const env = await handleCodeMap({ source_paths: [tempDir] }, makeCtx());
    expect(env.result.frameworks).toContain("tokio");
    expect(env.result.frameworks).toContain("serde");
    expect(env.result.frameworks).toContain("clap");
  });
});
