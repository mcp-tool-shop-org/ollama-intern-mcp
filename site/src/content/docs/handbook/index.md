---
title: Ollama Intern MCP — Handbook
description: The local intern for Claude Code. 40 tools across a frozen primitive core and four additive layers — skills, memory, shadow routing, operator-gated calibration.
sidebar:
  order: 0
  label: Overview
---

**Ollama Intern MCP** gives Claude Code a local intern with rules, tiers, a desk, a filing cabinet, a memory, and a shadow supervisor. Claude picks the _tool_; the tool picks the _tier_ (Instant / Workhorse / Deep / Embed); the tier writes a file you can open next week. Above that spine, four additive layers — skills, memory, shadow routing, operator-gated calibration — learn from every run without ever taking control.

No cloud. No telemetry. No "autonomous" anything. Shadow routing is shadow-only — no calibration can auto-apply.

## The shape

Frozen primitive core + four additive layers. 40 tools total.

### Core (28, frozen)

| Tier | Count | Purpose |
|---|---|---|
| **Atoms** | 15 | Job-shaped primitives (`classify`, `extract`, `triage_logs`, `summarize_*`, `draft`, `research`, `corpus_*`, `embed*`, `chat`). Batch-capable atoms accept `items: [{id, text}]`. |
| **Briefs** | 3 | Evidence-backed structured operator briefs — `incident_brief`, `repo_brief`, `change_brief`. |
| **Packs** | 3 | Fixed-pipeline compound jobs that write durable markdown + JSON. `incident_pack`, `repo_pack`, `change_pack`. |
| **Artifacts** | 7 | Continuity surface — `list`, `read`, `diff`, `export_to_path`, plus three deterministic snippet helpers. |

Freeze lines: atoms+briefs at 18, packs at 3, artifact tier at 7. The primitive surface does not grow.

### Layers above the core (12)

| Layer | Count | Purpose |
|---|---|---|
| **Skills** | 5 | Durable named pipelines over atoms with triggers and receipts. `skill_list` / `match` / `run` / `propose` / `promote`. Project skills override global by name. |
| **Memory** | 5 | Embedding-backed retrieval across receipts, artifacts, skills, proposals. `memory_refresh` / `search` / `read` / `explain` / `neighbors`. Nomic prefixes, typed hits, deterministic explanations with opt-in narration. |
| **Shadow routing** | — | Transparent instrumentation. 18 shadowable tools write a pre-execution `RoutingReceipt` per call. No tool surface; no control transfer. |
| **Routing** | 2 | Read-only audit + operator-gated calibration over shadow receipts. `routing_audit` surfaces findings; `routing_calibrate` runs propose / replay / approve / reject / rollback. Every approval requires a reason. |

New functionality is always a new layer above the spine — never a new primitive.

## Why this project exists

Every local-LLM MCP server leads with token-savings. Ours leads with _what the intern produces_:

- a durable markdown file you can open tomorrow
- an evidence block where every cited id was verified server-side
- a `weak: true` flag when the evidence doesn't support the claim — never a smoothed narrative
- investigative `next_checks`, never "apply this fix"

## Where to go next

- [Getting started](./getting-started/) — install, Claude Code config, model pulls
- [Tool reference](./tools/) — every tool grouped by tier and layer (40 total)
- [Envelope & tiers](./envelope-and-tiers/) — uniform envelope, hardware profiles, residency
- [Artifacts & continuity](./artifacts/) — how packs write to disk and how to use what they wrote
- [Laws & guardrails](./laws/) — evidence-first, no remediation drift, deterministic renderers, shadow-only routing
- [Security & threat model](./security/) — what's touched, what's not, what's in the log
