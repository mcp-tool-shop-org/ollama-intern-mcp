# examples/

Minimal MCP clients that spawn `ollama-intern-mcp` over stdio and make one real call. Teaching code — real clients should use the official MCP SDK for their language.

## Files

| File | What it does |
|---|---|
| [`simple-client-node.js`](./simple-client-node.js) | Node.js / ESM. Spawns the server via `npx`, handshakes, `tools/list`, calls `ollama_log_tail`. |
| [`simple-client-python.py`](./simple-client-python.py) | Python 3.11+ / asyncio. Same flow, stdio subprocess. |
| [`curl-example.md`](./curl-example.md) | Why you can't use `curl` directly (MCP is stdio, not HTTP) and where to go instead. |

## Prerequisites

- **Node.js** 20+ on your `PATH` (so `npx` can fetch the published package).
- **Ollama** running locally at `http://127.0.0.1:11434` (the server starts without it, but most tools fail without it — `ollama_log_tail` works either way, which is why the examples use it).
- **Python 3.11+** for the Python example (for `asyncio.subprocess` + type hint syntax).

No `npm install` inside `examples/` — the clients reach the server via `npx -y ollama-intern-mcp`, which pulls the latest published build on first run.

## Not shipped to npm

This directory is deliberately outside `package.json` → `files`. Users who `npm install ollama-intern-mcp` don't pay for it; the examples live in the repo for readers browsing GitHub.
