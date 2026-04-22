/**
 * ollama_doctor tests — no-LLM, probe + model-match + recent-errors surface.
 *
 * Uses a stub OllamaClient that responds to /api/ps + /api/tags via the
 * global fetch hook (vi.stubGlobal), plus a stubbed probe() return.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleDoctor } from "../../src/tools/doctor.js";
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

class StubClient implements OllamaClient {
  constructor(public readonly probeResult: { ok: boolean; reason?: string }) {}
  async generate(_: GenerateRequest): Promise<GenerateResponse> { throw new Error("n/a"); }
  async chat(_: ChatRequest): Promise<ChatResponse> { throw new Error("n/a"); }
  async embed(_: EmbedRequest): Promise<EmbedResponse> { throw new Error("n/a"); }
  async residency(_m: string): Promise<Residency | null> { return null; }
  async probe(_ms?: number): Promise<{ ok: boolean; reason?: string }> { return this.probeResult; }
}

function makeCtx(probeResult: { ok: boolean; reason?: string }): RunContext & { logger: NullLogger } {
  return {
    client: new StubClient(probeResult),
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

let tempDir: string;
let origLogPath: string | undefined;

const MODULE_ORIG_LOG_PATH = process.env.INTERN_LOG_PATH;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-doctor-"));
  origLogPath = process.env.INTERN_LOG_PATH;
  process.env.INTERN_LOG_PATH = join(tempDir, "log.ndjson");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const toRestore = origLogPath ?? MODULE_ORIG_LOG_PATH;
  try {
    if (toRestore === undefined) delete process.env.INTERN_LOG_PATH;
    else process.env.INTERN_LOG_PATH = toRestore;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function stubFetch(responses: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (url: string) => {
    for (const [suffix, payload] of Object.entries(responses)) {
      if (url.endsWith(suffix)) {
        return {
          ok: true,
          status: 200,
          json: async () => payload,
        } as unknown as Response;
      }
    }
    throw new Error(`fetch not stubbed: ${url}`);
  });
}

describe("ollama_doctor", () => {
  it("reports healthy when reachable + all required models pulled", async () => {
    stubFetch({
      "/api/tags": {
        models: [
          { name: "hermes3:8b", model: "hermes3:8b" },
          { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest" },
        ],
      },
      "/api/ps": {
        models: [{ name: "hermes3:8b", model: "hermes3:8b" }],
      },
    });
    const ctx = makeCtx({ ok: true });
    const env = await handleDoctor({}, ctx);
    expect(env.result.ollama.reachable).toBe(true);
    expect(env.result.models.missing).toEqual([]);
    expect(env.result.models.loaded).toContain("hermes3:8b");
    expect(env.result.healthy).toBe(true);
  });

  it("reports unhealthy when Ollama unreachable", async () => {
    const ctx = makeCtx({ ok: false, reason: "ECONNREFUSED" });
    const env = await handleDoctor({}, ctx);
    expect(env.result.ollama.reachable).toBe(false);
    expect(env.result.ollama.error).toContain("ECONNREFUSED");
    expect(env.result.healthy).toBe(false);
    expect(env.warnings?.some((w) => w.includes("unreachable"))).toBe(true);
  });

  it("flags missing models with suggested_pulls", async () => {
    stubFetch({
      "/api/tags": { models: [{ name: "hermes3:8b", model: "hermes3:8b" }] },
      "/api/ps": { models: [] },
    });
    const ctx = makeCtx({ ok: true });
    const env = await handleDoctor({}, ctx);
    expect(env.result.models.missing).toContain("nomic-embed-text");
    expect(env.result.models.suggested_pulls).toContain("ollama pull nomic-embed-text");
    expect(env.result.healthy).toBe(false);
  });

  it("surfaces recent errors from the NDJSON log", async () => {
    await mkdir(tempDir, { recursive: true });
    const logPath = join(tempDir, "log.ndjson");
    const lines = [
      JSON.stringify({
        kind: "call",
        ts: "2026-04-20T10:00:00Z",
        tool: "ollama_research",
        envelope: {
          result: { error: true, code: "OLLAMA_TIMEOUT", message: "x", hint: "y", retryable: true },
        },
      }),
      JSON.stringify({
        kind: "timeout",
        ts: "2026-04-20T10:05:00Z",
        tool: "ollama_draft",
        tier: "instant",
        timeout_ms: 15000,
      }),
      JSON.stringify({
        kind: "guardrail",
        ts: "2026-04-20T10:10:00Z",
        tool: "ollama_draft",
        rule: "protected_path",
        action: "deny",
      }),
      JSON.stringify({
        kind: "call",
        ts: "2026-04-20T10:15:00Z",
        tool: "ollama_chat",
        envelope: { result: "fine" },
      }),
    ];
    await writeFile(logPath, lines.join("\n") + "\n", "utf8");

    stubFetch({
      "/api/tags": { models: [{ name: "hermes3:8b", model: "hermes3:8b" }, { name: "nomic-embed-text", model: "nomic-embed-text" }] },
      "/api/ps": { models: [] },
    });
    const ctx = makeCtx({ ok: true });
    const env = await handleDoctor({}, ctx);
    expect(env.result.recent_errors.length).toBe(3);
    const codes = env.result.recent_errors.map((e) => e.code);
    expect(codes).toContain("OLLAMA_TIMEOUT");
    expect(codes).toContain("TIER_TIMEOUT");
    expect(codes.some((c) => c.startsWith("GUARDRAIL:"))).toBe(true);
  });

  it("matches bare model names against tagged entries (hermes3 → hermes3:8b)", async () => {
    stubFetch({
      "/api/tags": {
        models: [
          { name: "hermes3:8b" },
          { name: "nomic-embed-text:latest" },
        ],
      },
      "/api/ps": { models: [] },
    });
    const ctx = makeCtx({ ok: true });
    const env = await handleDoctor({}, ctx);
    // nomic-embed-text without a tag should match nomic-embed-text:latest.
    expect(env.result.models.missing).not.toContain("nomic-embed-text");
  });
});
