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

## Envelope

Every tool returns the same envelope — see [Envelope & tiers](../envelope-and-tiers/).
