---
title: Getting Started
description: Install ollama-intern-mcp, wire it into Claude Code, pull the default models, and run your first tool call.
sidebar:
  order: 1
---

Ollama Intern MCP is a local-only MCP server. Claude Code calls it; it routes work onto a local Ollama model; the result lands in a durable artifact on disk.

This page takes you from zero to one real tool call in about five minutes.

## 1. Prerequisites

- **Node.js** 18 or newer (20 LTS recommended — matches CI).
- **[Ollama](https://ollama.com)** installed and running at `http://127.0.0.1:11434`.
- **Claude Code** (or any MCP-capable client).

## 2. Install

Most users do **not** install globally. The recommended path is the Claude Code MCP config block below, which runs the server on demand via `npx`.

If you want the binary on your `PATH` for ad-hoc use, you can still install it globally:

```bash
npm install -g ollama-intern-mcp
```

## 3. Wire into Claude Code

Add this block to your Claude Code MCP server config:

```json
{
  "mcpServers": {
    "ollama-intern": {
      "command": "npx",
      "args": ["-y", "ollama-intern-mcp"],
      "env": {
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}
```

The `INTERN_PROFILE` picks a hardware profile — see [Envelope & tiers](../envelope-and-tiers/) for the full table. `dev-rtx5080` is the default developer profile and runs the validated `hermes3:8b` ladder.

### Claude Desktop

Same block, written to:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

## 4. Pull the tier models

The default `dev-rtx5080` profile collapses all three work tiers (Instant / Workhorse / Deep) onto `hermes3:8b`, plus `nomic-embed-text` for the Embed tier. One pull covers everything:

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

Four tiers, top to bottom:

| Tier | Default model | Used by |
|---|---|---|
| **Instant** | `hermes3:8b` | `classify`, `extract`, `triage_logs` |
| **Workhorse** | `hermes3:8b` | `summarize_fast`, `draft`, briefs |
| **Deep** | `hermes3:8b` | `summarize_deep`, `research`, packs |
| **Embed** | `nomic-embed-text` | `embed`, `embed_search`, corpus tools |

Other profiles (`dev-rtx5080-qwen3`, `m5-max`) swap the ladder — see [Envelope & tiers](../envelope-and-tiers/).

## 5. Hello, intern

Restart Claude Code so it re-reads the MCP config, then ask it to run the smallest possible call:

```text
Use the ollama-intern ollama_classify tool to classify
"the build failed because the API returned 502" into one of
["infra", "code", "user-error"]. Show me the envelope.
```

You should get back a uniform envelope like this:

```jsonc
{
  "result": { "label": "infra", "confidence": 0.9 },
  "tier_used": "instant",
  "model": "hermes3:8b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 42,
  "tokens_out": 8,
  "elapsed_ms": 380,
  "residency": { "in_vram": true, "evicted": false }
}
```

That is the intern working. Every tool in the server returns this same envelope shape. Every call is appended as one NDJSON line to `~/.ollama-intern/log.ndjson`.

## Next steps

- [Tool reference](../tools/) — all 28 tools grouped by tier
- [Artifacts & continuity](../artifacts/) — how packs write durable markdown to `~/.ollama-intern/artifacts/`
- [Laws & guardrails](../laws/) — evidence-first, weak-is-weak, deterministic renderers
- [Use with Hermes](../with-hermes/) — drive the MCP from Hermes Agent on `hermes3:8b`
