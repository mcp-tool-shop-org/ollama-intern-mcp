---
name: Bug report
about: Report a tool failure, wrong envelope, or unexpected behavior
title: ""
labels: bug
assignees: ""
---

<!--
For security bugs, do NOT open a public issue. See SECURITY.md and open a
private GitHub security advisory instead.
-->

## What happened

A short description of the bug. Which tool, what input shape, what came back.

## Reproduction

```jsonc
// The call (tool name + arguments). Trim secrets / large payloads.
{
  "tool": "ollama_…",
  "arguments": { /* … */ }
}
```

```jsonc
// The envelope you got back (keep the full structure — code, hint, tier_used,
// model, hardware_profile, tokens_in/out, elapsed_ms, residency).
{ /* … */ }
```

## Environment

- **Ollama Intern MCP version:** `vX.Y.Z` (from package.json or the MCP `tools/list` ping)
- **Hardware profile:** `dev-rtx5080` / `m5-max` / other
- **Ollama version:** `curl -s http://127.0.0.1:11434/api/version`
- **Node version:** `node --version`
- **OS:** macOS / Windows / Linux + version
- **Client:** Claude Code / Claude Desktop / Hermes Agent / custom MCP client

## Expected

What you expected to see (e.g. tier behaviour, envelope shape, evidence-citation result).

## Logs

Last ~20 lines from `~/.ollama-intern/log.ndjson` around the failed call. Run
`ollama_log_tail` (or `tail -n 20 ~/.ollama-intern/log.ndjson`). Redact paths,
secrets, or anything sensitive.

```json
{ /* … log lines … */ }
```

## Notes

Anything else that might be relevant — recent profile changes, model swaps,
corpus state, etc.
