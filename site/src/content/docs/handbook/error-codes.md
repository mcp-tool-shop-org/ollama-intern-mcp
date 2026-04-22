---
title: Error codes
description: Every structured error the server can return — what it means, when you'll see it, what to do next.
sidebar:
  order: 8
---

Every tool result is wrapped in the same envelope. When something fails, the tool returns a structured error instead:

```ts
{ error: true, code: string, message: string, hint: string, retryable: boolean }
```

`code` names are stable across releases — treat them like an API. `hint` is the server's best guidance; `retryable: true` means a retry is safe.

The authoritative list lives in [`src/errors.ts`](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/src/errors.ts). This page is the operator view.

## Transport — Ollama reachability & model availability

| Code | When you see it | What to do |
|---|---|---|
| `OLLAMA_UNREACHABLE` | Ollama isn't responding at `OLLAMA_HOST`. Retried 3× with exponential backoff before this fires. | Check `ollama serve` is running. `curl http://127.0.0.1:11434/api/tags` should return JSON. See [Troubleshooting → Ollama isn't running](../troubleshooting/#ollama-isnt-running). Retryable. |
| `OLLAMA_MODEL_MISSING` | Tool called a model name that isn't pulled on this machine (Ollama returned 404). | `ollama pull <model>` for the tier model your `INTERN_PROFILE` picked. `ollama list` shows what you have. Not retryable. |
| `OLLAMA_TIMEOUT` | Ollama accepted the request but didn't answer before the per-call fetch timeout. | Cold-load on first call is the usual cause. Retry once; if it repeats, bump `INTERN_TIER_*_TIMEOUT_MS` or check `residency` for eviction. Retryable. |

## Tier routing

| Code | When you see it | What to do |
|---|---|---|
| `TIER_TIMEOUT` | The tier's end-to-end budget blew (primary + optional fallback both timed out). Message carries tool, tier, model, elapsed, budget, and whether a fallback was attempted. | If `residency.evicted: true`, restart Ollama or drop `OLLAMA_MAX_LOADED_MODELS`. If the input is genuinely huge, switch to a lighter tier or chunk the call. Retryable. |

## Inputs — paths, schemas, config

| Code | When you see it | What to do |
|---|---|---|
| `SOURCE_PATH_NOT_FOUND` | A caller-declared `source_paths` entry doesn't exist, can't be read, or resolves outside the allowed root. | Check the path spelling, existence, and whether it's under `INTERN_CORPUS_ALLOWED_ROOTS` (for corpus tools) or `source_paths` (for `research`). Not retryable. |
| `SCHEMA_INVALID` | Tool arguments failed zod validation, or a corpus file / manifest on disk is an unknown schema version. | Read the message — it names the failing field or file. For on-disk schema mismatches, rebuild the corpus (`ollama_corpus_index`). Not retryable. |
| `CONFIG_INVALID` | Startup config is malformed — usually a bad `OLLAMA_HOST` URL or out-of-range port. | Fix the env var. Example: `OLLAMA_HOST=http://127.0.0.1:11434`. Not retryable. |

## Path safety

| Code | When you see it | What to do |
|---|---|---|
| `PROTECTED_PATH_WRITE` | A `draft` call targets a protected path (`memory/`, `.claude/`, `docs/canon/`, etc.) without `confirm_write: true`. | If the write is intentional, re-call with `confirm_write: true` and review the diff. If not, retarget the draft. Not retryable. |
| `SYMLINK_NOT_ALLOWED` | Corpus indexer hit a symlink (discovered by `lstat`) and refused to follow it. Defends against size-cap bypass + TOCTOU. | Remove the symlink from the corpus root or resolve it to a real path the user owns. Not retryable. |

## Draft & evidence guardrails

| Code | When you see it | What to do |
|---|---|---|
| `DRAFT_BANNED_PHRASE` | `draft(style="doc")` produced marketing sludge (`seamless`, `effortless`, `leverage`, `blazing fast`, …) on all 3 regeneration attempts. | Rewrite the prompt to demand concrete, falsifiable claims (specific capability + measurable outcome). Consider `style="concise"` if tone matters less than brevity. Retryable. |
| `CITATION_INVALID` | Reserved for briefs / research where a model-cited evidence id fails server-side validation in a way stripping can't recover. Unknown ids are normally stripped silently — this code fires when the citation shape itself is malformed. | Re-run the call. If it recurs, the evidence bundle is the suspect — inspect the inputs for truncation. Retryable. |
| `COMPILE_FAILED` | `draft` with a known `language` produced output that failed the compile / parse check. | The draft is returned with the compile error attached — fix-or-reject is the caller's call. Not retryable by itself; rewrite the prompt if it keeps failing. |
| `EXTRACT_UNPARSEABLE` | `extract` couldn't coerce the model output into the requested JSON schema after retries. | Simplify the schema (fewer required fields, looser types) or narrow the input. Retryable with different prompting. |

## Embeddings

| Code | When you see it | What to do |
|---|---|---|
| `EMBED_COUNT_MISMATCH` | Ollama returned fewer vectors than inputs sent — usually a mid-request model swap or transient embed-server glitch. | Retry. If it persists, check `OLLAMA_HOST` reachability and that the embed model isn't being swapped under you. Retryable. |
| `EMBED_DIMENSION_MISMATCH` | Query vector and corpus vector have different dimensions — the corpus was indexed under a different embed model than the one live now. | Re-index the corpus (`ollama_corpus_index`) under the active embed model. Also check `ollama_corpus_refresh` for silent `:latest` drift. Not retryable without a reindex. |

## Fallthrough

| Code | When you see it | What to do |
|---|---|---|
| `INTERNAL` | An unexpected error escaped structured handling. The server caught it at the outer boundary so no raw stack leaks. | Check `~/.ollama-intern/log.ndjson` for the correlation id — that line has the full detail. File an issue with the envelope + log excerpt. Not retryable. |

## Related

- [Troubleshooting](../troubleshooting/) — first-install failure modes mapped to these codes
- [Security & threat model](../security/) — how `PROTECTED_PATH_WRITE` and `SYMLINK_NOT_ALLOWED` fit the threat model
- [Corpora](../corpora/) — embed-model lifecycle and the `EMBED_*` codes in context
