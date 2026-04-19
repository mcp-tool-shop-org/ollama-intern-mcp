---
title: Tool Reference
description: All 40 tools — frozen primitive core plus four additive layers.
sidebar:
  order: 2
---

Tools are grouped into the **frozen primitive core** (28 tools across four tiers — atoms, briefs, packs, artifacts) and the **four additive layers above it** (skills, memory, shadow routing, routing audit + calibration). The primitive count freezes — no new atoms, no new pack types, no new artifact tools. New capability is always a new layer.

## Frozen primitive core (28)

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

## Skill layer (5)

Durable, named workflows that compose atoms + briefs + packs into a pipeline with declared triggers and a receipt written after every run. Global skills live in `~/.ollama-intern/skills/*.json`; project skills in `<cwd>/skills/*.json` override global by name.

| Tool | Purpose |
|---|---|
| `ollama_skill_list` | Enumerate skills (global + project, with project overrides applied). |
| `ollama_skill_match` | Score candidate skills against a free-text task. Returns ranked matches with trigger provenance. |
| `ollama_skill_run` | Execute a skill pipeline end-to-end. Writes a receipt to `<cwd>/artifacts/skill-receipts/<slug>.json`. |
| `ollama_skill_propose` | Surface lifecycle proposals (promote / retire) and new-skill proposals reconstructed from ad-hoc chains in the NDJSON call log. |
| `ollama_skill_promote` | Move a skill between statuses with an operator-supplied reason. Appends to skill lifecycle history. |

Skills compose the primitives — they never grow the primitive surface.

## Memory layer (5)

Embedding-backed retrieval across receipts, pack artifacts, skills, and candidate proposals. Records get the `search_document:` nomic prefix; queries get `search_query:` — never reversed, never dropped.

| Tool | Purpose |
|---|---|
| `ollama_memory_refresh` | Normalize receipts / artifacts / skills / proposals into `~/.ollama-intern/memory/index.json` + embeddings sidecar. Idempotent. |
| `ollama_memory_search` | Embedding-backed retrieval with optional metadata pre-filter. Returns typed hits with score bands. |
| `ollama_memory_read` | Typed + provenance-backed view of one record. `include_excerpt=true` adds a structured source extract. |
| `ollama_memory_explain` | Deterministic field-level match explanation for a (query, record) pair. `narrate=true` opts into an Instant-tier natural-language summary. |
| `ollama_memory_neighbors` | Records near a given record in embedding space. Pure math — no model call. |

Defaults are deterministic. Model calls are opt-in behind `narrate=true` / `include_excerpt=true`.

## Shadow routing (no tool surface)

Every call to a shadowable tool (10 atoms + 5 flagships + 3 packs = **18 shadowable tools**) writes a `RoutingReceipt` to `<cwd>/artifacts/routing-receipts/<id>.json` capturing:

- the pre-execution decision the router would have made
- the actual invocation that ran
- outcome linkage (did it succeed, abstain, error)
- the calibration overlay `version` in effect at decision time

Actual tool behavior is unchanged. Shadow is shadow-only — **no calibration can take control**. Skill-layer, memory-layer, artifact-management, corpus-management, and embed-primitive tools are on the bypass list.

## Routing audit + calibration (2)

Operator surfaces over the shadow receipts.

| Tool | Purpose |
|---|---|
| `ollama_routing_audit` | Read-only findings across six categories: `promotion_gap`, `override_hotspot`, `abstain_cluster`, `missed_abstain`, `unused_candidate`, `overconfident_route`. Each finding carries a `recommended_next_action` — sometimes "calibrate," sometimes "author a skill trigger," sometimes "leave alone." |
| `ollama_routing_calibrate` | Action-typed lifecycle: `propose` / `list` / `replay` / `approve` / `reject` / `rollback`. Replay shows the effect a proposal would have had on a historical receipt window. Approvals require a `reason` string. Every transition appends to history; nothing auto-applies. |

Calibration is **operator-gated**. Every routing decision under an active overlay stamps that overlay's `version` onto its receipt — audits can always answer "which calibration produced this decision?" When a finding points at a gap calibration can't close (e.g., `missed_abstain` on a primitive that isn't in the candidate space), replay says so honestly and the audit recommends skill authoring instead.

## Envelope

Every tool returns the same envelope — see [Envelope & tiers](../envelope-and-tiers/).
