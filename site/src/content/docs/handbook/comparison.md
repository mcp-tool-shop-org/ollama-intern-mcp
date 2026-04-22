---
title: Comparison
description: Honest feature matrix vs houtini-lm, mcp-local-llm, raw Ollama, and driving Claude directly.
sidebar:
  order: 10
---

Every local-LLM MCP server leads with token savings. We lead with **what the intern produces**. This page lays out where that framing pays off, where it doesn't, and where other tools are straight-up better.

No hyperbole, no "competitive landscape" slide. If a row is a blank for us, it's a blank.

## Matrix

| Feature | ollama-intern-mcp | houtini-lm | mcp-local-llm | raw Ollama HTTP | Claude-direct |
|---|---|---|---|---|---|
| Tier routing (Instant / Workhorse / Deep / Embed) | ✓ | — | — | — | — |
| Evidence-backed briefs with server-side citation stripping | ✓ | — | — | — | partial (prompt-level) |
| Durable markdown + JSON artifacts on disk | ✓ | — | — | — | — |
| Living corpora (manifest v2, incremental refresh, `:latest` drift detection) | ✓ | — | — | — | — |
| Uniform envelope across every tool | ✓ | — | — | — | — |
| Structured errors (`code` / `message` / `hint` / `retryable`) | ✓ | — | — | — | — |
| Batch atoms (`items: [{id, text}]`, one envelope per batch) | ✓ | — | — | — | — |
| Residency visibility (`evicted`, `size_vram_bytes`) | ✓ | — | — | partial (via `/api/ps`) | — |
| NDJSON call log at a known path | ✓ | — | — | — | — |
| `source_path` mode — server reads the file, caller never pre-reads | ✓ | — | — | — | — |
| Path-safety (`allowed_roots`, `..`-rejection, protected-path writes) | ✓ | — | — | — | — |
| Streaming tool responses | — | partial | partial | ✓ | ✓ |
| Pure vector database (HNSW / pgvector) | — | — | — | — | — |
| Full code-execution sandbox | — | — | — | — | — |
| Cloud model access | — | — | — | — | ✓ |

## Rows, plainly

### Tier routing

Claude calls `ollama_classify`; the server picks Instant. Claude calls `ollama_summarize_deep`; the server picks Deep. The caller never writes "use model X." This is job-shaped on purpose — a caller who reaches for `ollama_chat` has skipped the job-shaped surface and is saying "I don't know what I want."

Other local-LLM MCPs ask the caller to pick the model. Fine for experimentation, brittle for delegation.

### Evidence-backed briefs

`incident_brief`, `repo_brief`, `change_brief` each require evidence the server can validate. Claims that cite unknown evidence ids are stripped before return. Thin evidence flags `weak: true` with coverage notes instead of smoothing into fake narrative.

Claude-direct can approximate this in prompt — the gap is that ours is server-enforced, not prompt-enforced. A model that ignores the instruction still can't sneak an unvalidated citation through.

### Durable artifacts

`incident_pack` / `repo_pack` / `change_pack` each write `<slug>.md` + `<slug>.json` under `~/.ollama-intern/artifacts/`. You open them tomorrow, diff them next week, export them into a handbook with `artifact_export_to_path`. The markdown is rendered by code, not prompt — shape is deterministic.

No other tool in this category writes a file and hands you the path. Every competitor returns a blob of model output and trusts you to save it.

### Living corpora

`corpus_index` builds a searchable chunk store under `~/.ollama-intern/corpora/<name>/`. `corpus_refresh` rebuilds only what's changed (file content hash). `corpus_search` does BM25 + RRF fusion. `corpus_answer` cites chunk ids server-side-validated against what's actually stored. Manifest v2 tracks the resolved embed model — if Ollama silently promotes `nomic-embed-text:latest` under you, `ollama_corpus_refresh` surfaces `embed_model_resolved_drift`.

A pure vector DB is better for 100M-vector workloads. Ours is better for "I have 300 files I want cited answers against, and I don't want to run pgvector."

### Uniform envelope

Every tool returns `{ result, tier_used, model, hardware_profile, tokens_in, tokens_out, elapsed_ms, residency }`. No tool invents a new shape. The envelope is the audit trail.

Other servers return "whatever the model said." Parsing that at scale means hand-written glue per tool.

### Structured errors

On failure every tool returns `{ error: true, code, message, hint, retryable }`. `code` names are stable across releases — treat them like an API. Never a raw stack trace.

Raw Ollama returns HTTP errors. Prompt-based tools return prose failures you have to parse.

### Batch atoms

`classify`, `extract`, `triage_logs` accept `items: [{ id, text }]` and return one envelope per batch. Duplicate ids refused. This is where bulk work happens — 10-item classify in one round-trip instead of 10 round-trips with 10 prewarms and 10 envelopes.

### Residency visibility

Every envelope carries `residency` from Ollama's `/api/ps`. When `evicted: true` or `size_vram_bytes < size_bytes`, the caller knows inference dropped 5–10× and why. Raw Ollama exposes the same data but you have to correlate it by hand.

### `source_path` mode

`classify` and `extract` accept `source_path` — a file the server reads itself. Claude never pre-reads the file, which means Claude's context budget isn't spent on bytes the intern is about to read anyway.

No other delegation tool in the MCP ecosystem does this. It's small, and it's the right optimization.

## Rows where we're blank

### Streaming tool responses

We don't stream. Packs emit `pack_step` events to the NDJSON log so a tailing operator can see pipeline progress, but the MCP response is single-shot. If you need mid-call token streams, use raw Ollama or Claude-direct.

### Pure vector database

`corpus_*` is not pgvector. It's BM25 + RRF fusion over chunks with metadata, sized for repo-scale corpora (thousands to tens of thousands of chunks). Use pgvector / Qdrant / Weaviate for hundred-millions of vectors.

### Full code-execution sandbox

`ollama_draft` runs a compile check on code drafts when `language` is known (tsc, eslint, pytest on the Tools-ops agent's `batch_proof_check`). It's a surface, not a sandbox — it will not execute arbitrary code against arbitrary inputs. Use a dedicated sandbox (`e2b`, Docker) if you need that.

### Cloud model access

Local-only. Every call goes to `http://127.0.0.1:11434` or nowhere. If you need GPT-4 / Claude / Gemini, drive them directly or use a cloud-MCP — this server is not that shape.

## When to use what

- **Bulk classification / extraction / triage over many items** — ollama-intern-mcp. Batch atoms.
- **"What just happened" incident writeup with evidence** — ollama-intern-mcp. `incident_pack`.
- **Repo onboarding brief** — ollama-intern-mcp. `repo_pack` or `repo_brief`.
- **Mid-call token streaming** — raw Ollama, or drive Claude directly.
- **Tens of millions of vectors** — pgvector / Qdrant / Weaviate. Not us.
- **One-off question to a local model** — raw Ollama HTTP. Don't reach for ollama-intern-mcp for a single ad-hoc chat.
- **Cloud model access** — Claude-direct or a cloud-MCP.

## See also

- [Tool reference](../tools/) — the full tool surface.
- [Envelope & tiers](../envelope-and-tiers/) — what makes the envelope load-bearing.
- [Laws & guardrails](../laws/) — why we strip unknown citations server-side.
