/**
 * ollama_log_tail tests — limit, filters, truncated-line tolerance,
 * missing-log soft-empty.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleLogTail } from "../../src/tools/logTail.js";
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
let origLogPath: string | undefined;
const MODULE_ORIG = process.env.INTERN_LOG_PATH;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-log-tail-"));
  origLogPath = process.env.INTERN_LOG_PATH;
  process.env.INTERN_LOG_PATH = join(tempDir, "log.ndjson");
});

afterEach(async () => {
  const toRestore = origLogPath ?? MODULE_ORIG;
  try {
    if (toRestore === undefined) delete process.env.INTERN_LOG_PATH;
    else process.env.INTERN_LOG_PATH = toRestore;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("ollama_log_tail", () => {
  it("returns empty when log file does not exist (soft-empty)", async () => {
    const env = await handleLogTail({}, makeCtx());
    expect(env.result.total_returned).toBe(0);
    expect(env.result.events).toEqual([]);
    expect(env.result.log_present).toBe(false);
  });

  it("tails events newest-first with default limit", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ kind: "call", ts: `2026-04-20T10:0${i}:00Z`, tool: "t", seq: i }));
    }
    await writeFile(join(tempDir, "log.ndjson"), lines.join("\n") + "\n", "utf8");
    const env = await handleLogTail({}, makeCtx());
    expect(env.result.total_returned).toBe(5);
    expect((env.result.events[0] as { seq: number }).seq).toBe(4);
    expect((env.result.events[4] as { seq: number }).seq).toBe(0);
  });

  it("respects limit", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ kind: "call", ts: `2026-04-20T10:${String(i).padStart(2, "0")}:00Z`, tool: "t", seq: i }));
    }
    await writeFile(join(tempDir, "log.ndjson"), lines.join("\n") + "\n", "utf8");
    const env = await handleLogTail({ limit: 3 }, makeCtx());
    expect(env.result.total_returned).toBe(3);
    expect((env.result.events[0] as { seq: number }).seq).toBe(19);
  });

  it("filters by kind and tool", async () => {
    const lines = [
      JSON.stringify({ kind: "call", ts: "2026-04-20T10:00:00Z", tool: "ollama_research" }),
      JSON.stringify({ kind: "timeout", ts: "2026-04-20T10:01:00Z", tool: "ollama_research" }),
      JSON.stringify({ kind: "call", ts: "2026-04-20T10:02:00Z", tool: "ollama_chat" }),
    ];
    await writeFile(join(tempDir, "log.ndjson"), lines.join("\n") + "\n", "utf8");
    const byKind = await handleLogTail({ filter_kind: "timeout" }, makeCtx());
    expect(byKind.result.total_returned).toBe(1);
    expect((byKind.result.events[0] as { kind: string }).kind).toBe("timeout");

    const byTool = await handleLogTail({ filter_tool: "ollama_chat" }, makeCtx());
    expect(byTool.result.total_returned).toBe(1);
    expect((byTool.result.events[0] as { tool: string }).tool).toBe("ollama_chat");
  });

  it("skips truncated final line gracefully", async () => {
    const good = JSON.stringify({ kind: "call", ts: "2026-04-20T10:00:00Z", tool: "t" });
    const truncated = `{"kind":"call","ts":"2026-04-20T10:01:00Z","tool":"t","partial":tr`;
    await writeFile(join(tempDir, "log.ndjson"), good + "\n" + truncated, "utf8");
    const env = await handleLogTail({}, makeCtx());
    expect(env.result.total_returned).toBe(1);
  });

  it("rejects invalid since timestamp with SCHEMA_INVALID", async () => {
    await writeFile(join(tempDir, "log.ndjson"), "", "utf8");
    await expect(handleLogTail({ since: "not-a-date" }, makeCtx())).rejects.toThrow(/Invalid ISO/);
  });

  it("applies since filter", async () => {
    const lines = [
      JSON.stringify({ kind: "call", ts: "2026-04-20T09:00:00Z", tool: "t" }),
      JSON.stringify({ kind: "call", ts: "2026-04-20T11:00:00Z", tool: "t" }),
    ];
    await writeFile(join(tempDir, "log.ndjson"), lines.join("\n") + "\n", "utf8");
    const env = await handleLogTail({ since: "2026-04-20T10:00:00Z" }, makeCtx());
    expect(env.result.total_returned).toBe(1);
  });
});
