---
title: ollama_doctor
description: First-run prerequisites + status snapshot — no model calls. Returns healthy&#58; boolean for session-start gating.
sidebar:
  order: 5
---

`ollama_doctor` is the no-LLM diagnostic. It probes Ollama, checks pulled
vs loaded vs required models, surfaces the active profile, lists allowed
roots and recent errors, and returns a single `healthy: boolean` your
session-start logic can gate on.

**This is the first call to run on every new session.** It costs essentially
nothing and tells you exactly what's wrong if anything is.

## Tier — Instant (no model calls)

Pure introspection. `tier_used: "instant"` for log consistency, but no
inference happens. `elapsed_ms` is typically &lt;50 ms.

## When to use it

- On every fresh MCP session start (gate follow-up work on `healthy: true`)
- After installing or upgrading the server (verify wiring)
- When a tool returns `MODEL_UNAVAILABLE` or similar (see what's actually loaded)
- In CI to assert a target environment is set up correctly

## When NOT to use it

- You already know prereqs are fine → skip; nothing else surfaces useful info
- You want call-by-call observability → use `ollama_log_tail`

## Schema

```ts
{}   // no inputs
```

Full source: `src/tools/doctor.ts`.

## Example call

```jsonc
{
  "tool": "ollama_doctor",
  "arguments": {}
}
```

## Result shape

```jsonc
{
  "ollama": {
    "reachable": true,
    "host":      "http://127.0.0.1:11434"
  },
  "models": {
    "required":         ["hermes3:8b", "nomic-embed-text"],
    "pulled":           ["hermes3:8b", "nomic-embed-text", "qwen3:8b"],
    "loaded":           ["hermes3:8b"],
    "missing":          [],
    "suggested_pulls":  []
  },
  "profile": {
    "name":  "dev-rtx5080",
    "tiers": {
      "instant":   "hermes3:8b",
      "workhorse": "hermes3:8b",
      "deep":      "hermes3:8b",
      "embed":     "nomic-embed-text"
    }
  },
  "paths": {
    "allowed_roots": ["/repo", "/Users/me/work"],
    "artifact_root": "/Users/me/.ollama-intern/artifacts",
    "log_path":      "/Users/me/.ollama-intern/log.ndjson"
  },
  "recent_errors": [
    { "ts": "2026-05-15T10:23:11Z", "code": "PATH_NOT_ALLOWED", "tool": "ollama_corpus_index" }
  ],
  "healthy": true
}
```

## What `healthy: true` actually checks

- `ollama.reachable === true` (the daemon answered)
- `models.missing` is empty (every required model is pulled)
- `paths.allowed_roots` is non-empty when any path-bearing tool exists
- `recent_errors` count is below a sanity threshold

If any check fails, `healthy: false` and the failing field tells you what.

## Common pitfalls

**`ollama.reachable: false` with `error: "ECONNREFUSED"`.** The Ollama
daemon isn't running, or it's bound to a different host than
`OLLAMA_HOST`. Check `curl http://127.0.0.1:11434/api/tags` from your
shell.

**`models.missing` populated.** Run `ollama pull <model>` for each. The
default `dev-rtx5080` profile needs `hermes3:8b` + `nomic-embed-text`.

**`paths.allowed_roots: []` with a `corpus_index` failure.** You haven't
set `INTERN_ALLOWED_ROOTS`. Add it to your MCP server's `env` block.

**`recent_errors` shows the same code 10x in a row.** That code is the
real problem; doctor surfaces it but doesn't fix it. Look up the code in
[Error codes](../error-codes/) for the resolution.

**`healthy: true` but a specific tool still fails.** Doctor only checks
preconditions, not per-tool runtime. Look at the failing tool's envelope
`error` field for the specific failure.

## Related tools

- [`ollama_log_tail`](./) — once doctor says healthy, this is your live observability
- See [Error codes](../error-codes/) for every structured code doctor might surface
- See [Troubleshooting](../troubleshooting/) for resolutions to the common doctor failures
