---
title: Tool Reference
description: All 28 tools grouped by tier.
sidebar:
  order: 2
---

Tools are grouped into four tiers. The count freezes here — no new atoms, no new pack types, no new artifact tools.

## Atoms (15)

Job-shaped primitives. Pick the tool that names the job; the tier follows.

| Tool | Tier | Purpose |
|---|---|---|
| `ollama_research` | Deep | Takes **file paths**, not raw text. Chunks locally, answers with citations validated against `source_paths`. |
| `ollama_corpus_search` | Embed | Persistent corpus concept search (BM25 + RRF fusion). |
| `ollama_corpus_answer` | Deep | Chunk-grounded synthesis over a corpus. Every claim cites a chunk id. |
| `ollama_corpus_index` | Embed | Build or update a corpus from a root directory. |
| `ollama_corpus_refresh` | Embed | Incremental refresh using the corpus manifest. |
| `ollama_corpus_list` | — | List known corpora. |
| `ollama_embed_search` | Embed | Ad-hoc vector search. |
| `ollama_embed` | Embed | Batch-aware embeddings. |
| `ollama_classify` | Instant | Single-label classification with confidence. Batch-capable. |
| `ollama_triage_logs` | Instant | Stable-shape log digest: errors, warnings, suspected root cause. Batch-capable. |
| `ollama_summarize_fast` | Instant | Gist of short input (~4k tokens). |
| `ollama_summarize_deep` | Deep | Digest of long input (~32k tokens) with optional focus. |
| `ollama_draft` | Workhorse | DRAFT code/prose stubs. Runs compile check when `language` is known. Never autonomous. |
| `ollama_extract` | Workhorse | Schema-constrained JSON extraction. Batch-capable. |
| `ollama_chat` | Workhorse | Ad-hoc chat. **Last resort.** If you reach for this often, a specialty tool is missing. |

Batch-capable atoms (`classify`, `extract`, `triage_logs`) accept `items: [{ id, text }]` and return one envelope per batch. Duplicate ids refused.

## Briefs (3 flagship primitives)

Evidence-backed structured operator briefs. Every claim cites an evidence id. Unknowns are stripped server-side before the result returns. Weak evidence flags `weak: true` with coverage notes instead of smoothing fake narrative.

| Tool | Purpose |
|---|---|
| `ollama_incident_brief` | "What just happened" — symptoms, timeline, suspected cause, investigative next checks. |
| `ollama_repo_brief` | Operator map of a repo — what it is, how it's laid out, where to start reading. |
| `ollama_change_brief` | Change impact brief with DRAFT release note. |

## Packs (3, frozen)

Fixed pipelines end-to-end. Each runs deterministic steps and writes markdown + JSON to disk.

| Tool | Default root | Writes |
|---|---|---|
| `ollama_incident_pack` | `~/.ollama-intern/artifacts/incident/` | `<slug>.md` + `<slug>.json` |
| `ollama_repo_pack` | `~/.ollama-intern/artifacts/repo/` | `<slug>.md` + `<slug>.json` |
| `ollama_change_pack` | `~/.ollama-intern/artifacts/change/` | `<slug>.md` + `<slug>.json` |

Pack artifacts are rendered by code, not by a prompt — the markdown shape is deterministic.

## Artifact tier (7)

Continuity surface over what packs wrote. No model calls in this tier.

| Tool | Purpose |
|---|---|
| `ollama_artifact_list` | Metadata-only index, filterable by pack / date / slug glob. |
| `ollama_artifact_read` | Typed read by `{pack, slug}` or `{json_path}`. |
| `ollama_artifact_diff` | Structured same-pack comparison; weak-flip surfaced. Cross-pack diff is refused loudly. |
| `ollama_artifact_export_to_path` | Write an existing artifact (with provenance header) to a caller-declared `allowed_roots`. Refuses existing files unless `overwrite: true`. |
| `ollama_artifact_incident_note_snippet` | Deterministic operator-note fragment. |
| `ollama_artifact_onboarding_section_snippet` | Deterministic handbook fragment. |
| `ollama_artifact_release_note_snippet` | Deterministic DRAFT release-note fragment. |

## Batch workflow examples

Batch-capable atoms (`classify`, `extract`, `triage_logs`) accept `items: [{ id, text }]` in a single call and return one envelope for the whole batch. Duplicate ids are refused before the model runs — id collisions fail loud with `SCHEMA_INVALID`.

Why batch: one prewarm, one residency probe, one envelope to parse. Ten single-item calls cost ten prewarms and ten round-trips.

### Batch `classify` — 10 support tickets

```jsonc
// → Claude → ollama-intern-mcp
{
  "tool": "ollama_classify",
  "arguments": {
    "labels": ["bug", "feature-request", "question", "spam"],
    "items": [
      { "id": "t-001", "text": "login button does nothing on mobile Safari" },
      { "id": "t-002", "text": "can you add dark mode?" },
      { "id": "t-003", "text": "how do I reset my password?" },
      { "id": "t-004", "text": "BUY NOW AMAZING CRYPTO DEAL" },
      { "id": "t-005", "text": "cursor jumps to end of input on save" },
      { "id": "t-006", "text": "keyboard shortcut for save would be nice" },
      { "id": "t-007", "text": "where is the export menu?" },
      { "id": "t-008", "text": "click here for free iphone!!!" },
      { "id": "t-009", "text": "crash on empty project open" },
      { "id": "t-010", "text": "allow toggling sidebar" }
    ]
  }
}
```

```jsonc
// → envelope.result
{
  "items": [
    { "id": "t-001", "label": "bug",             "confidence": 0.94 },
    { "id": "t-002", "label": "feature-request", "confidence": 0.91 },
    { "id": "t-003", "label": "question",        "confidence": 0.88 },
    { "id": "t-004", "label": "spam",            "confidence": 0.97 },
    { "id": "t-005", "label": "bug",             "confidence": 0.86 },
    { "id": "t-006", "label": "feature-request", "confidence": 0.83 },
    { "id": "t-007", "label": "question",        "confidence": 0.79 },
    { "id": "t-008", "label": "spam",            "confidence": 0.98 },
    { "id": "t-009", "label": "bug",             "confidence": 0.92 },
    { "id": "t-010", "label": "feature-request", "confidence": 0.81 }
  ]
}
```

Same tier, same model, same envelope — `tier_used: "instant"`, `model: "hermes3:8b"`, `tokens_*` summed across the batch.

### Batch `extract` — 5 commits into structured release-note fragments

```jsonc
{
  "tool": "ollama_extract",
  "arguments": {
    "schema": {
      "type": "object",
      "properties": {
        "kind":  { "enum": ["feat", "fix", "chore", "docs", "refactor"] },
        "scope": { "type": "string" },
        "summary": { "type": "string" }
      },
      "required": ["kind", "summary"]
    },
    "items": [
      { "id": "c1", "text": "feat(corpus): surface :latest drift on refresh" },
      { "id": "c2", "text": "fix(index): TOCTOU between stat and read" },
      { "id": "c3", "text": "chore(deps): bump zod to 4.3.6" },
      { "id": "c4", "text": "docs(handbook): new troubleshooting page" },
      { "id": "c5", "text": "refactor(envelope): hoist residency into shared builder" }
    ]
  }
}
```

Returns `{ items: [{ id, extracted: { kind, scope, summary } }, ...] }`.

### Batch `triage_logs` — 3 incident windows

```jsonc
{
  "tool": "ollama_triage_logs",
  "arguments": {
    "items": [
      { "id": "window-a", "text": "[05:07] worker-3 OOM killed\n[05:07] evicted=true" },
      { "id": "window-b", "text": "[05:14] connection reset by peer x5\n[05:14] retry-after=60" },
      { "id": "window-c", "text": "[05:21] typescript compilation succeeded\n[05:22] nothing interesting" }
    ]
  }
}
```

Returns a stable-shape per-item digest: `errors`, `warnings`, `suspected_root_cause`, `next_checks`. Window C will likely come back with `suspected_root_cause: null` and an empty `errors` — weak signal is weak signal, not manufactured narrative.

### Concurrency contention

On the default `dev-rtx5080` profile the tier semaphore is sized for 2 concurrent calls. A third caller blocks; a fourth caller blocks harder. Every block emits a `semaphore:wait` event to the NDJSON log with `queue_depth`, `in_flight`, and `expected_wait_ms`. See [Observability](../observability/#semaphore-wait) for how to read those events.

If you're dispatching 3+ parallel batches and seeing retries, that's the semaphore — not a bug. Drop parallelism or move to a profile with more VRAM headroom.

### id collision behavior

Duplicate ids inside one batch refuse at schema validation (`SCHEMA_INVALID`), before any model work. Pick stable, unique ids per call — there is no implicit de-duplication.

## New in v2.1.0

Tier freeze stays at 4 — everything here extends existing tiers, no new tier class.

### Ops tools

| Tool | Purpose |
|---|---|
| `ollama_log_tail` | Tail the NDJSON call log from inside an MCP session, with filters. See [Observability → ollama_log_tail](../observability/#the-ollama_log_tail-tool). |
| `ollama_batch_proof_check` | Run `tsc` / `eslint` / `pytest` over a set of paths; single envelope with per-check pass/fail. Executes under cwd validation + per-check timeouts — new security surface, see [SECURITY.md](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md). |

### Refactor tools

| Tool | Purpose |
|---|---|
| `ollama_code_map` | Structural map of a code tree (exports, call graph sketches, TODOs). Reads files under `allowed_roots`. |
| `ollama_code_citation` | Given a symbol name, return the file + line + surrounding context that defines it. Reads files under `allowed_roots`. |

### Corpus tools

| Tool | Purpose |
|---|---|
| `ollama_corpus_amend` | Additive in-place edit to an existing corpus. Breaks the "corpus is a pure disk snapshot" invariant; subsequent answers over the corpus surface `has_amended_content: true`. See [Observability → corpus_amend](../observability/#corpus_amend). |
| `ollama_summarize_deep` with `source_path` | Existing tool gained a single-file `source_path` shape so callers stop having to prepack text. |

### Artifact tools

| Tool | Purpose |
|---|---|
| `ollama_artifact_prune` | Age-based artifact deletion (`older_than_days`, optional `pack` filter). Dry-run default — `dry_run: false` must be explicit. See [Artifacts → artifact_prune](../artifacts/#artifact_prune). |

## Envelope

Every tool returns the same envelope — see [Envelope & tiers](../envelope-and-tiers/).

## Deeper dives

- [Corpora](../corpora/) — full lifecycle for `corpus_index` / `refresh` / `search` / `answer`
- [Error codes](../error-codes/) — every structured error a tool can return and what to do
- [Observability](../observability/) — NDJSON log, event kinds, jq recipes, `ollama_log_tail`
- [Comparison](../comparison/) — honest matrix vs other local-LLM MCPs
