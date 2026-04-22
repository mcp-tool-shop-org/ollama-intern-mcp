#!/usr/bin/env node
/**
 * Minimal MCP client for ollama-intern-mcp — Node.js / stdio.
 *
 * Spawns the server via `npx -y ollama-intern-mcp`, sends JSON-RPC 2.0 over
 * stdin/stdout, lists tools, then calls `ollama_log_tail` (a deterministic
 * artifact-tier tool that needs no Ollama round-trip).
 *
 * Run: `node examples/simple-client-node.js`
 *
 * This is a teaching example. Real MCP clients should use the official
 * `@modelcontextprotocol/sdk` — this hand-rolled stdio harness is the
 * minimum that demonstrates the wire protocol.
 */

import { spawn } from "node:child_process";

const server = spawn("npx", ["-y", "ollama-intern-mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
  shell: process.platform === "win32",
});

let nextId = 1;
const pending = new Map();
let buffer = "";

// JSON-RPC 2.0 framing over stdio: one JSON object per line.
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  server.stdin.write(body + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function main() {
  // 1. MCP handshake — initialize.
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "simple-client-node", version: "0.1.0" },
  });

  // 2. List the tool surface. Returns { tools: [{name, description, inputSchema}] }.
  const { tools } = await rpc("tools/list", {});
  console.log(`Server exposes ${tools.length} tools. First five:`);
  for (const t of tools.slice(0, 5)) console.log(`  - ${t.name}`);

  // 3. Call a deterministic tool — no Ollama needed.
  const res = await rpc("tools/call", {
    name: "ollama_log_tail",
    arguments: { lines: 5 },
  });
  console.log("\nollama_log_tail →");
  console.log(JSON.stringify(res, null, 2));

  server.kill();
}

main().catch((err) => {
  console.error(err);
  server.kill();
  process.exit(1);
});
