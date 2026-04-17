/**
 * MCP end-to-end golden test.
 *
 * Spawns the built dist/index.js as a subprocess (exactly as Claude Code does),
 * sends the MCP handshake over stdio, and asserts on tools/list response shape.
 *
 * This is what caught commit 259a949 (Windows isMain check was string-comparing
 * url vs path with different slashes — main() never ran, Claude Code saw
 * "connected then immediately disconnected"). A unit test cannot catch that.
 *
 * Does NOT require Ollama to be running. We stop at tools/list — no tools/call.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST = resolve(__dirname, "../dist/index.js");
const ISOLATED_LOG = join(tmpdir(), "intern-golden-ignore.ndjson");

beforeAll(() => {
  if (!existsSync(DIST)) {
    throw new Error(
      `dist/index.js not built. Run \`npm run build\` before running the MCP golden tests.`,
    );
  }
});

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Spawn the MCP server, send a sequence of JSON-RPC messages, collect responses
 * by id, kill the process. Returns responses keyed by id.
 */
async function roundTrip(messages: Array<Record<string, unknown>>): Promise<Map<number, RpcResponse>> {
  return new Promise((resolveFn, reject) => {
    const proc: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [DIST],
      {
        env: {
          ...process.env,
          OLLAMA_HOST: "http://127.0.0.1:11434",
          INTERN_PROFILE: "m5-max", // m5-max has prewarm: [] so boot is instant
          INTERN_LOG_PATH: ISOLATED_LOG, // isolated log — doesn't pollute user's ~/.ollama-intern/
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const responses = new Map<number, RpcResponse>();
    let buf = "";
    let expectedIds = new Set(
      messages
        .filter((m) => typeof m.id === "number")
        .map((m) => m.id as number),
    );
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`MCP golden test timeout. Received ids: ${[...responses.keys()].join(",")}, expected: ${[...expectedIds].join(",")}`));
    }, 15_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as RpcResponse;
          if (typeof msg.id === "number") {
            responses.set(msg.id, msg);
            expectedIds.delete(msg.id);
            if (expectedIds.size === 0) {
              clearTimeout(timeout);
              proc.kill("SIGKILL");
              resolveFn(responses);
            }
          }
        } catch {
          // ignore non-JSON lines (log output, etc.)
        }
      }
    });

    proc.stderr.on("data", () => {
      // MCP servers may use stderr; we just don't crash on it.
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("exit", (code) => {
      if (expectedIds.size > 0) {
        clearTimeout(timeout);
        reject(new Error(`Server exited (code ${code}) before all expected responses: missing ${[...expectedIds].join(",")}`));
      }
    });

    for (const msg of messages) {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    }
  });
}

describe("MCP end-to-end golden — stdio round-trip", () => {
  it("responds to initialize with a valid server info block", async () => {
    const resp = await roundTrip([
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "golden-test", version: "0.0.1" },
        },
      },
    ]);
    const initResp = resp.get(0);
    expect(initResp).toBeDefined();
    expect(initResp?.error).toBeUndefined();
    const result = initResp?.result as { serverInfo?: { name?: string; version?: string }; capabilities?: { tools?: unknown } };
    expect(result?.serverInfo?.name).toBe("ollama-intern-mcp");
    expect(result?.serverInfo?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result?.capabilities?.tools).toBeDefined();
  }, 30_000);

  it("tools/list returns all 20 registered tools with flagship tools first", async () => {
    const resp = await roundTrip([
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    ]);
    const listResp = resp.get(1);
    expect(listResp?.error).toBeUndefined();
    const tools = (listResp?.result as { tools?: Array<{ name: string; description: string }> })?.tools;
    expect(tools).toBeDefined();

    const names = tools!.map((t) => t.name);
    // All 20 expected tools present. The atom surface is frozen at 18;
    // packs (incident_pack, repo_pack) are the compound-job tier above.
    expect(names).toEqual(
      expect.arrayContaining([
        "ollama_research",
        "ollama_corpus_search",
        "ollama_corpus_answer",
        "ollama_incident_brief",
        "ollama_repo_brief",
        "ollama_change_brief",
        "ollama_incident_pack",
        "ollama_repo_pack",
        "ollama_embed_search",
        "ollama_embed",
        "ollama_corpus_index",
        "ollama_corpus_refresh",
        "ollama_corpus_list",
        "ollama_classify",
        "ollama_triage_logs",
        "ollama_summarize_fast",
        "ollama_summarize_deep",
        "ollama_draft",
        "ollama_extract",
        "ollama_chat",
      ]),
    );
    expect(names).toHaveLength(20);

    // Flagship surface discipline: retrieval/answer flagships first,
    // then briefs, then packs, then ad-hoc ranker.
    expect(names[0]).toBe("ollama_research");
    expect(names[1]).toBe("ollama_corpus_search");
    expect(names[2]).toBe("ollama_corpus_answer");
    expect(names[3]).toBe("ollama_incident_brief");
    expect(names[4]).toBe("ollama_repo_brief");
    expect(names[5]).toBe("ollama_change_brief");
    expect(names[6]).toBe("ollama_incident_pack");
    expect(names[7]).toBe("ollama_repo_pack");
    expect(names[8]).toBe("ollama_embed_search");

    // Chat is last-resort and MUST advertise itself that way — so Claude doesn't default to it.
    const chat = tools!.find((t) => t.name === "ollama_chat");
    expect(chat?.description).toMatch(/last resort/i);
  }, 30_000);

  it("summarize_deep input schema advertises both text and source_paths modes", async () => {
    const resp = await roundTrip([
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    ]);
    const tools = (resp.get(1)?.result as { tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> })?.tools;
    const sd = tools!.find((t) => t.name === "ollama_summarize_deep");
    const props = sd?.inputSchema.properties;
    expect(props).toBeDefined();
    expect(props).toHaveProperty("text");
    expect(props).toHaveProperty("source_paths");
    expect(props).toHaveProperty("focus");
    expect(props).toHaveProperty("max_words");
  }, 30_000);
});
