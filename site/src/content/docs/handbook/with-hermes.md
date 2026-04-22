---
title: Use with Hermes
description: Full integration walkthrough — drive ollama-intern-mcp from Nous Research's Hermes Agent on hermes3:8b.
sidebar:
  order: 8
---

This MCP was validated end-to-end with [Hermes Agent](https://github.com/NousResearch/hermes-agent) against `hermes3:8b` on Ollama on 2026-04-19. Hermes is an external agent that *calls into* this MCP's 28-tool frozen primitive surface — it does the planning, the intern does the work.

Pairing works because v2.0.0 retired the `qwen2.5:*` family from the default model ladder and moved to `hermes3:8b`, and `source_paths` schema no longer requires `min: 1` on log-driven `incident_pack` / `change_pack` calls. v2.0.2 readers: this is still the current rail.

## Install

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text

# Hermes Agent — Linux / macOS / WSL2 / Termux
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc   # or ~/.zshrc
hermes --version
```

Native Windows is not supported by Hermes — use WSL2. The validated config below assumes Hermes is reachable on its install path; the npx-spawned `ollama-intern-mcp` runs from wherever Hermes can shell out.

## Config

Copy `hermes.config.example.yaml` from this repo into your Hermes install directory and adjust paths. Minimum shape:

```yaml
model:
  provider: custom
  base_url: http://localhost:11434/v1
  default: hermes3:8b
  context_length: 65536    # Hermes 64K floor — load-bearing

providers:
  local-ollama:
    name: local-ollama
    base_url: http://localhost:11434/v1
    api_mode: openai_chat
    api_key: ollama
    model: hermes3:8b

mcp_servers:
  ollama-intern:
    command: npx
    args: ["-y", "ollama-intern-mcp"]
    env:
      OLLAMA_HOST: http://localhost:11434
      INTERN_PROFILE: dev-rtx5080
```

### Shape constraints — each of these has a reason

- **Nested `model.*` is required.** Hermes's ready-check rejects the flat `model: <provider>/<name>` form. Use the nested shape above.
- **`context_length: 65536` under `model:`** enforces Hermes's 64K minimum. The `providers.local-ollama.models.*.context_length` values are advisory and do not replace this floor.
- **`api_mode: openai_chat`** routes through Ollama's OpenAI-compatible `/v1` endpoint — that's where `hermes3:8b` returns clean `tool_calls` objects without streaming-delta quirks.
- **Tier env overrides are optional in v2.0.0+.** The default ladder is `hermes3:8b` across Instant/Workhorse/Deep, so you don't need `INTERN_TIER_*` unless you're pinning a different model.

## Verify the wire

```bash
hermes mcp list       # should show ollama-intern enabled
hermes mcp test ollama-intern
```

Then run an imperative smoke — the integration test shape:

```bash
hermes chat -q "Call mcp_ollama_intern_ollama_incident_pack with:
- log_text: [2026-04-17T11:10:00Z] db: connection refused
- artifact_dir: /tmp/hermes-smoke

After the tool returns, respond only with: tool_called, artifact_paths, weak, incident_summary."
```

Expect:

1. Hermes dispatches `mcp_ollama_intern_ollama_incident_pack` via stdio.
2. The MCP runs triage → incident_brief → writes both artifact files.
3. Response carries `artifact.markdown_path`, `artifact.json_path`, and a compact summary. Full brief is on disk.

## Prompt shape is part of the contract

- **Imperative tool-invocation prompts** ("Call X with args …") are the **integration test**. They give an 8B local model enough scaffolding to emit clean `tool_calls` in one turn. Use these when you want to prove the wiring works.
- **List-form multi-task prompts** ("do A, then B, then C") are **capability benchmarks** for larger models. Do not interpret a list-form failure on 8B as "the wiring is broken" — run the imperative form first.

This is not a bug or a limitation of this MCP; it is a property of how 8B-class local models handle tool-call planning. The imperative form routes around the planning step.

## Known caveats

- **Ollama `/v1` streaming + OpenAI SDK.** Ollama's 2026 streaming shape interacts awkwardly with some older OpenAI-SDK versions — if you see empty `tool_calls` in streamed chunks but a clean one when `stream=False`, patch your agent's openai client to send `stream=false` for `:11434` base URLs. The validated Hermes install uses a ~130 LOC shim to do exactly that. Not required for other agents.
- **Default model cascade.** v2.0.0 dropped `qwen2.5:*-instruct-q4_K_M` from every profile and v2.x keeps it that way. If you had `INTERN_TIER_*` pinning those tags, you'll get `OLLAMA_MODEL_MISSING` — switch to `hermes3:8b` or a `qwen3:*` variant.
- **Hermes's own config.yaml.** Hermes may ship its own defaults that conflict with the snippet above. The `model.*` nested block is what passes its ready-check; leave the top-level `providers:` and `mcp_servers:` blocks as shown.

## What NOT to do

- Don't swap Hermes's stock `SOUL.md` persona — it works.
- Don't use the flat `model: <provider>/<name>` form.
- Don't drop the `context_length: 65536` under `model:` — Hermes rejects below the 64K floor.
- Don't try to re-add a skill layer or memory layer inside this MCP. Hermes already does the cross-turn planning; that's the division of labor.

## See also

- [Envelope and tiers](/handbook/envelope-and-tiers/) — the uniform shape every tool returns, including `hardware_profile`.
- [Artifacts](/handbook/artifacts/) — how `incident_pack` / `change_pack` / `repo_pack` write durable files Hermes can pick up later.
- [Laws](/handbook/laws/) — evidence-first contracts that don't care which agent is calling.
