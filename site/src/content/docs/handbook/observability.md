---
title: Observability
description: Read the NDJSON call log — field semantics, event kinds, jq recipes, and degradation signatures.
sidebar:
  order: 9
---

Every tool call leaves a structured trace in `~/.ollama-intern/log.ndjson`. One JSON object per line, append-only, never truncated by the server. This page is the operator's guide to reading it.

If observability is disabled (filesystem permission error, read-only home, etc.), the server emits one stderr warning at first failure and keeps serving. Tool calls never break on log writes.

## Why the log exists

The envelope is the audit trail — every tool returns `tier_used`, `model`, `tokens_*`, `elapsed_ms`, and `residency`. The log is the persisted form of that envelope, plus the events that don't return to the caller: timeouts that were recovered by fallback, semaphore waits, pack-pipeline progress, guardrail decisions.

Three things it's actually useful for:

- **Tuning delegation** — "was that call really worth Deep tier, or would Instant have sufficed?" The log has `tokens_*` and `elapsed_ms` for every call, grouped by `tool` and `tier_used`.
- **Debugging slow calls** — a slow tool call correlates with a `residency.evicted: true`, a `semaphore:wait`, or a cold prewarm. The log shows which.
- **Proving the system degraded correctly** — when something timed out, was there a fallback? Did the fallback succeed? The `timeout` and `fallback` events answer that.

## Anatomy of a log entry

A successful call entry:

```jsonc
{
  "kind": "call",                               // one of: call | timeout | fallback |
                                                 //        semaphore:wait | pack_step |
                                                 //        corpus_amend | guardrail |
                                                 //        prewarm | prewarm:in_progress_request
  "ts": "2026-04-21T18:04:12.118Z",             // ISO-8601 UTC timestamp
  "tool": "ollama_incident_pack",               // the tool name that ran
  "envelope": {
    "result": { /* tool-specific payload */ },
    "tier_used": "deep",                        // "instant" | "workhorse" | "deep" | "embed"
    "model": "hermes3:8b",                      // concrete Ollama model that served
    "hardware_profile": "dev-rtx5080",
    "tokens_in": 4180,
    "tokens_out": 612,
    "elapsed_ms": 8410,                         // wall-clock from tool dispatch to return
    "residency": {
      "in_vram": true,                          // from Ollama /api/ps
      "size_bytes": 8100000000,                 // on-disk model size
      "size_vram_bytes": 8100000000,            // resident in VRAM; equality = no paging
      "evicted": false                          // true = model paged to disk → 5-10× slowdown
    }
  }
}
```

An error entry still uses `kind: "call"` — the envelope carries `error: true`, `code`, `message`, `hint`, `retryable` instead of `result`. Grep `.envelope.error` to split successes from failures.

## Event kinds

### `call`

One line per completed tool invocation (success or structured error). Carries the full envelope. This is the meat — everything else is a supporting event.

### `timeout`

Primary tier hit the per-call budget. Carries `tool`, `tier`, `timeout_ms`, `model`, `profile_name`. If a fallback was configured, a `fallback` event follows. If both tiers timed out, the envelope comes back as `TIER_TIMEOUT`.

```jsonc
{ "kind": "timeout", "ts": "...", "tool": "ollama_summarize_deep",
  "tier": "deep", "timeout_ms": 60000, "model": "hermes3:8b",
  "profile_name": "dev-rtx5080" }
```

### `fallback`

The tier router gave up on `from` and re-routed to `to`. `reason` is a short human string; the following `call` event will carry the actual response from the fallback tier.

```jsonc
{ "kind": "fallback", "ts": "...", "tool": "ollama_summarize_deep",
  "from": "deep", "to": "workhorse", "reason": "TIER_TIMEOUT" }
```

### `semaphore:wait`

A tool call blocked because tier permits were exhausted. Carries `queue_depth`, `in_flight`, and `expected_wait_ms` estimated from the longest in-flight request. One event per acquire that actually queues — release events are suppressed to keep log volume bounded on hot paths.

On RTX 5080 (`dev-rtx5080`) the semaphore is sized for 2 concurrent calls. A third caller queues and this event fires.

### `pack_step`

Emitted before each step of a pack's fixed pipeline. Gives an operator watching a long pack a coarse "what stage are we in" signal without promising mid-step streaming.

```jsonc
{ "kind": "pack_step", "ts": "...", "pack": "incident",
  "step": "build_evidence", "step_index": 2, "total_steps": 5 }
```

### `corpus_amend`

New in v2.1.0. Emitted when a caller amends a corpus in place (additive edits that break the "corpus is a pure disk snapshot" invariant). The event records which corpus was amended so subsequent `corpus_answer` calls can surface `has_amended_content: true` in their envelope. If you see frequent `corpus_amend` against a corpus that's also queried for audit-grade answers, re-run `ollama_corpus_index` to return to a clean snapshot.

### `guardrail`

Server-side guardrail decisions: citation stripping (unknown ref removed before return), banned-phrase regeneration on `draft(style="doc")`, confidence-threshold failures, path-safety refusals. `rule` names the guardrail, `action` is what it did (`stripped`, `regenerated`, `rejected`), `detail` carries the specifics.

### `residency` (inside `call.envelope`)

Not a separate `kind` — `residency` lives inside the envelope of every `call` event. It's called out here because it's load-bearing for degradation analysis (see below).

## jq recipes

The log is append-only NDJSON, so plain-old `jq -c` + line counts work. These assume the default path `~/.ollama-intern/log.ndjson`.

### All calls for one tool

```bash
jq -c 'select(.kind=="call" and .tool=="ollama_incident_pack")' \
  < ~/.ollama-intern/log.ndjson
```

### Tier distribution across the last 100 calls

```bash
tail -n 200 ~/.ollama-intern/log.ndjson \
  | jq -r 'select(.kind=="call") | .envelope.tier_used' \
  | sort | uniq -c
```

### Slowest 10 calls

```bash
jq -c 'select(.kind=="call") | {tool, ms: .envelope.elapsed_ms, tier: .envelope.tier_used}' \
  < ~/.ollama-intern/log.ndjson \
  | jq -s 'sort_by(-.ms) | .[0:10]'
```

### Every error, grouped by code

```bash
jq -r 'select(.kind=="call" and .envelope.error==true) | .envelope.code' \
  < ~/.ollama-intern/log.ndjson \
  | sort | uniq -c | sort -rn
```

### Calls within a date range

```bash
jq -c 'select(.ts >= "2026-04-20" and .ts < "2026-04-22")' \
  < ~/.ollama-intern/log.ndjson
```

### Cold-start correlation

Every `prewarm:in_progress_request` plus the next `call` that fired:

```bash
jq -c 'select(.kind=="prewarm:in_progress_request" or .kind=="call")' \
  < ~/.ollama-intern/log.ndjson | head -50
```

### Residency evictions in the last 24h

```bash
jq -c 'select(.kind=="call" and .envelope.residency.evicted==true)' \
  < ~/.ollama-intern/log.ndjson
```

### Fallbacks taken (degradation proof)

```bash
jq -c 'select(.kind=="fallback")' < ~/.ollama-intern/log.ndjson
```

## Degradation signatures

Two shapes that mean "the system is slow because the environment changed under it." Neither is a bug in the tool — both are recoverable.

### `residency.evicted: true`

Ollama unloaded your tier model to make room for another, or VRAM pressure forced a disk page-out. Inference dropped ~5–10× because the model now reads from disk on every token. Ollama silently hides this; the envelope doesn't.

**Fix path:**

1. `ollama ps` — confirm the model isn't resident.
2. Lower `OLLAMA_MAX_LOADED_MODELS` so the tier model stays pinned.
3. Set `OLLAMA_KEEP_ALIVE=-1` so it doesn't idle out.
4. Restart Ollama if the residency probe keeps reporting stale state.

### `size_vram_bytes < size_bytes`

The model loaded but didn't fit entirely in VRAM — the remainder is paged to system RAM. Slower than a clean VRAM load, faster than eviction to disk. Happens when another process (a browser tab, a game, another Ollama tier) held VRAM at load time.

**Fix path:**

1. Close the other VRAM consumer.
2. Switch to a lighter profile (`INTERN_PROFILE=dev-rtx5080-qwen3` uses `qwen3:8b` at Deep instead of mixing model sizes).
3. Restart Ollama to re-load the tier model when VRAM is clean.

## The `ollama_log_tail` tool

New in v2.1.0. Tail the log without shelling out to `tail` or `cat`. Claude and Hermes both call this the same way:

```jsonc
{
  "tool": "ollama_log_tail",
  "arguments": {
    "lines": 100,              // last N lines (default 50, max 1000)
    "kind": "call",            // optional — filter by event kind
    "tool": "ollama_incident_pack", // optional — filter by tool name
    "since": "2026-04-21T00:00:00Z" // optional — ISO-8601 lower bound
  }
}
```

Returns `{ events: [...], truncated: boolean, log_path: "..." }`. The envelope is the usual shape (no tier / tokens — this is an artifact-tier read). `truncated: true` means the window you asked for is larger than what the server returned — the default cap is 1000 events.

When it's the right reach:

- You're driving the intern from Hermes Agent and want to correlate a slow call without context-switching out of the agent loop.
- You're writing a handbook example and want a deterministic log fragment to quote.
- You're verifying a guardrail fired as expected after a call.

When it's not:

- For ad-hoc analysis across many days, use `jq` on the file. The tool caps at 1000 lines; the file doesn't.
- For hot-path monitoring, tail the file directly. The tool is a read-once window, not a stream.

## See also

- [Error codes](../error-codes/) — every structured error that can appear in `envelope.error`.
- [Troubleshooting](../troubleshooting/) — residency, prewarm, model pulls, MCP wiring.
- [Envelope & tiers](../envelope-and-tiers/) — the field-by-field envelope spec.
