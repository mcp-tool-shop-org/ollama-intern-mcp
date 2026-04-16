# Ollama Intern MCP

> **A control plane for local cognitive labor.** Job-shaped tools with tiered Ollama models, server-enforced guardrails, and measured economics — so Claude can delegate bulk work without losing control.

**Status:** v0.1.0 — Phase 1 Delegation Spine. Real benchmark numbers pending M5 Max arrival.

## What this is

An MCP server that gives Claude Code a **local "intern"**. Claude chooses work type by choosing a tool, and the tool implies the right local tier (Instant / Workhorse / Deep / Embed). That mental model is the product advantage — delegation becomes legible and habitual instead of ad hoc.

## What this is not

- Not a Claude replacement — local models are weaker; outputs are drafts for Claude to review
- Not a cross-provider router — local Ollama only
- Not a generic chat wrapper — `ollama_chat` is a **last-resort** escape hatch, not the front door
- Not a tok/s vanity project — every benchmark pairs with a quality eval

## The 8-tool labor surface

Tool names encode when to reach for them. Pick the job, the tier follows.

### Flagship

| Tool | Tier | What it does |
|---|---|---|
| [`ollama_research`](src/tools/research.ts) | Deep | Takes **file paths**, not raw text. Chunks locally, answers with validated citations. *Context preservation as a product feature.* |
| [`ollama_embed`](src/tools/embed.ts) | Embed | Batch-aware vectors. Powers concept-search over `memory/`, canon, doctrine — the bridge from filename search to idea search. |

### Core

| Tool | Tier | What it does |
|---|---|---|
| [`ollama_classify`](src/tools/classify.ts) | Instant | Single-label classification with confidence. Commit types, log severity, bug-report yes/no. |
| [`ollama_triage_logs`](src/tools/triageLogs.ts) | Instant | Stable-shape log digest: errors, warnings, suspected root cause. |
| [`ollama_summarize_fast`](src/tools/summarizeFast.ts) | Instant | Gist of short input (~4k tokens). |
| [`ollama_summarize_deep`](src/tools/summarizeDeep.ts) | Deep | Digest of long input (~32k tokens) with optional focus. |
| [`ollama_draft`](src/tools/draft.ts) | Workhorse | DRAFT code/prose stubs. Runs compile check when `language` is known. Never autonomous. |
| [`ollama_extract`](src/tools/extract.ts) | Workhorse | Schema-constrained JSON extraction (`format: "json"`). |

### Last resort

| Tool | Tier | What it does |
|---|---|---|
| `ollama_chat` | Workhorse | Ad-hoc chat. **Use sparingly** — if you reach for this often, a specialty tool is missing. |

## Hardware profiles

The same code runs against very different hardware. Pick a profile with `INTERN_PROFILE`:

| Profile | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (default) | qwen2.5 7B | qwen2.5-coder 7B | qwen2.5 14B | nomic-embed-text |
| `dev-rtx5080-llama` | qwen2.5 7B | qwen2.5-coder 7B | **llama3.1 8B** | nomic-embed-text |
| `m5-max` | qwen2.5 14B | qwen2.5-coder 32B | llama3.3 70B | nomic-embed-text |

**Why the Qwen ladder on default dev:** same family top-to-bottom means bad outputs are tool/design problems, not cross-family mismatches. Coherent dogfooding beats simulating the eventual 70B personality.

**Parity rail:** `dev-rtx5080-llama` is for running the same gold evals through Llama 8B Deep before committing to Llama on the M5 Max. Lets you measure whether family drift buys anything real.

Per-tier env vars override the profile's picks when you need a one-off:

| Override | Example |
|---|---|
| `INTERN_TIER_INSTANT` | `qwen2.5:7b-instruct-q4_K_M` |
| `INTERN_TIER_WORKHORSE` | `qwen2.5-coder:7b-instruct-q4_K_M` |
| `INTERN_TIER_DEEP` | `qwen2.5:14b-instruct-q4_K_M` |
| `INTERN_EMBED_MODEL` | `nomic-embed-text` |

Every envelope and NDJSON log line carries `hardware_profile` so dev numbers can be filtered out of publishable benchmark tables.

## Envelope (every tool returns this)

```ts
{
  result: <tool-specific>,
  tier_used: "instant" | "workhorse" | "deep" | "embed",
  model: string,
  hardware_profile: string,   // "dev-rtx5080" | "dev-rtx5080-llama" | "m5-max"
  tokens_in: number,
  tokens_out: number,
  elapsed_ms: number,
  residency: {
    in_vram: boolean,
    size_bytes: number,
    size_vram_bytes: number,
    evicted: boolean
  } | null
}
```

`residency` is populated from Ollama's `/api/ps`. When `evicted: true` or `size_vram < size`, the model paged to disk and inference dropped 5–10× — surface this to the user so they know to restart Ollama or reduce loaded-model count.

## Guardrails (server-enforced, never prompt-side)

- **Citation stripping** ([`src/guardrails/citations.ts`](src/guardrails/citations.ts)) — `ollama_research` citations validated against `source_paths`; unknown paths dropped
- **Protected-path write control** ([`src/guardrails/writeConfirm.ts`](src/guardrails/writeConfirm.ts)) — drafts targeting `memory/`, `.claude/`, `docs/canon/`, etc. require `confirm_write: true`
- **Compile check** ([`src/guardrails/compileCheck.ts`](src/guardrails/compileCheck.ts)) — `ollama_draft` with known `language` returns `{compiles, checker, stderr_tail}`
- **Confidence threshold** ([`src/guardrails/confidence.ts`](src/guardrails/confidence.ts)) — `classify` below `0.7` triggers `allow_none` fallback
- **Timeouts with logged fallback** ([`src/guardrails/timeouts.ts`](src/guardrails/timeouts.ts)) — Instant 5s / Workhorse 20s / Deep 90s. Both the timeout event and the fallback decision land in the NDJSON log.

## Observability

Every call logged as one line of NDJSON to `~/.ollama-intern/log.ndjson`. The envelope (including `hardware_profile`) rides along, so bench/eval scripts can filter `dev-rtx5080` numbers out of publishable tables:

```json
{"kind":"call","ts":"2026-04-16T12:00:00Z","tool":"ollama_classify","envelope":{"tier_used":"instant","model":"qwen2.5:7b-instruct-q4_K_M","hardware_profile":"dev-rtx5080","tokens_in":87,"tokens_out":12,"elapsed_ms":340,"residency":{"in_vram":true,"evicted":false}}}
```

This is what lets you tune delegation instead of guessing — "this call used 5k tokens on Deep when fast would have sufficed."

## Roadmap (hardening phases)

- **Phase 1 — Delegation Spine** (shipped in v0.1.0): full 8-tool surface, uniform envelope, tier map, NDJSON observability, all 5 guardrails
- **Phase 2 — Truth Spine**: Python benchmark harness + gold eval pack per tool (factuality, citation validity, triage usefulness, classify accuracy, draft usefulness, extract conformance)
- **Phase 3 — Safety Spine**: guardrails hardened to product law (already scaffolded — Phase 3 is adding the tests and edge cases)
- **Phase 4 — Adoption Spine**: delegation triggers wired into real Claude Code use

Phase by hardening layer, never by amputating the surface.

## Install

```bash
npm install -g @mcptoolshop/ollama-intern-mcp
```

Requires [Ollama](https://ollama.com) running locally and the tier models pulled.

**Default dev profile (RTX 5080 16GB and similar):**

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
```

**M5 Max profile (once you're on a 128GB-unified box):**

```bash
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
ollama pull llama3.3:70b-instruct-q4_K_M
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

## Claude Code config

```json
{
  "mcpServers": {
    "ollama-intern": {
      "command": "npx",
      "args": ["-y", "@mcptoolshop/ollama-intern-mcp"],
      "env": {
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}
```

Switch profiles by changing `INTERN_PROFILE` to `dev-rtx5080-llama` or `m5-max`. Per-tier env vars (`INTERN_TIER_INSTANT`, etc.) still override profile picks when you need a one-off swap.

## License

MIT © mcp-tool-shop
