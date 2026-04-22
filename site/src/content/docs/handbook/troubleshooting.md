---
title: Troubleshooting
description: First-time install snags, model pulls, residency issues, and MCP wiring checks.
sidebar:
  order: 7
---

Things that go wrong the first time you install, in the order they tend to bite. Work top to bottom — most of these are one command away from fixed.

## Ollama isn't running

Symptom — every tool call returns a connection error, or the server fails to start with `ECONNREFUSED 127.0.0.1:11434`.

Check:

```bash
curl http://127.0.0.1:11434/api/tags
```

If that doesn't return JSON, Ollama isn't up.

Fix — start it:

- **macOS / Linux** — launch the Ollama app, or run `ollama serve` in a terminal.
- **Windows** — launch the Ollama desktop app; it lives in the system tray.

Then retry the tool call.

## Model pull failed

Symptom — `ollama pull hermes3:8b` stops with a network error, a disk-space error, or hangs at a fixed percentage.

- **Network flake** — re-run the pull. Ollama resumes from the last completed layer.
- **Disk full** — check free space; `hermes3:8b` is ~4.7 GB pulled, more when unpacked.
- **Stuck forever** — `Ctrl-C`, then `ollama rm hermes3:8b` and pull again. Rare, but sometimes a layer corrupts.

Confirm what's installed:

```bash
ollama list
```

You should see `hermes3:8b` and `nomic-embed-text` for the default `dev-rtx5080` profile.

## Hardware insufficient for `hermes3:8b`

Symptom — the model loads but inference is very slow (tens of seconds for short prompts), or `residency.evicted: true` appears in envelopes, or Ollama reports the model paged to disk.

`hermes3:8b` wants roughly **6 GB VRAM** or **16 GB RAM** for CPU inference (see [Getting Started → Hardware minimums](../getting-started/#hardware-minimums)).

Fallbacks, cheapest to most-work:

1. **Lower concurrent models** — `export OLLAMA_MAX_LOADED_MODELS=1` so the embed model isn't pinned alongside the workhorse.
2. **Switch profile** — if you're on an RTX 5080 and want the Qwen rail, `export INTERN_PROFILE=dev-rtx5080-qwen3` and pull the Qwen models listed in the README. If you're on Apple Silicon with enough memory, try `m5-max`.
3. **Pin a smaller model per tier** — override individual tiers with env vars:

   ```bash
   export INTERN_TIER_INSTANT=llama3.2:3b
   export INTERN_TIER_WORKHORSE=llama3.2:3b
   ```

   Smaller model, lower quality, but it will run.

The `Deep` tier is the hungriest — if only deep calls stall, try a lighter model there first.

## `OLLAMA_MODEL_MISSING` error

Symptom — a tool call returns an envelope with an error pointing at a missing model, e.g. `OLLAMA_MODEL_MISSING: hermes3:8b`.

The tier picked a model that isn't pulled on this machine. Either:

- **Pull it** — `ollama pull hermes3:8b` (or whichever model the error names).
- **Or override the tier** — export the matching `INTERN_TIER_*` env var to a model you do have.

Confirm with `ollama list` that the model name matches exactly, including the tag (`hermes3:8b`, not `hermes3`).

## MCP server not appearing in Claude Code

Symptom — you added the config block, restarted Claude Code, and `ollama-intern` tools don't show up.

Sanity checks, in order:

1. **Config file path** — Claude Code reads `~/.config/claude-code/mcp.json` on macOS/Linux or `%APPDATA%\Claude\claude_code_mcp.json` on Windows. Make sure you edited the right one.
2. **JSON is valid** — run the file through a JSON linter. A trailing comma will silently drop the whole `mcpServers` block.
3. **`npx` resolves** — open a terminal and run `npx -y ollama-intern-mcp --version`. If that fails, `npm` isn't on your PATH (or Node isn't installed).
4. **Full restart** — quit Claude Code completely and reopen. Some versions don't pick up MCP config changes on a reload.
5. **Check logs** — Claude Code's MCP log shows startup errors. On macOS: `~/Library/Logs/Claude/mcp*.log`. Search for `ollama-intern`.

If the server starts but tools still don't appear, run it manually to see its stderr:

```bash
npx -y ollama-intern-mcp
```

It should print a startup banner and block waiting for stdin. If it exits with an error, that error is your real problem.

## Still stuck

- **Error code reference** — every structured error the server returns is documented on the [Error codes](../error-codes/) page with cause and next action.
- Every call is logged to `~/.ollama-intern/log.ndjson` — `tail` it while retrying to see what the server actually saw.
- Open a [GitHub discussion](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/discussions) with the envelope (minus any sensitive content), the profile you're running, and `ollama list` output.
