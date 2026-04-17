---
title: Laws & Guardrails
description: The rules live in the server, not the prompt.
sidebar:
  order: 5
---

Every law on this page is enforced server-side and has test coverage. None of them are prompt conventions — prompts drift; code does not.

## Evidence-first

Every claim in a brief cites an evidence id. The id must exist in the evidence bundle handed to the model. If the model cites an unknown id, the server strips it with a warning before the result returns. You never see the fabricated reference.

## Weak is weak

If evidence coverage is thin, the brief flags `weak: true` and notes the gaps. The server will not smooth thin evidence into a narrative. A honest `weak: true` is a feature. A confident narrative without evidence is a bug we refuse to ship.

## Investigative, not prescriptive

Briefs and packs produce `next_checks`, `read_next`, `likely_breakpoints`. They do **not** produce remediation. Prompts explicitly forbid "apply this fix" / "you should do X." The intern is a research assistant; the operator decides what to do.

## Deterministic renderers

Pack markdown is rendered by code, not a prompt. The shape is stable. You can diff two `incident_pack` artifacts and the diff is meaningful. `ollama_draft` stays reserved for situations where model wording actually matters — not for operator artifacts where shape matters.

## Path safety strict

- `..` is rejected before normalize. `join()` collapse is not the defense.
- `artifact_export_to_path` requires caller-declared `allowed_roots` — no implicit "any path" export.
- Existing files are refused unless `overwrite: true` is explicitly set.
- Drafts targeting protected paths (`memory/`, `.claude/`, `docs/canon/`, etc.) require `confirm_write: true`.

## Same-pack diffs only

`artifact_diff` refuses cross-pack comparisons loudly. An incident pack and a repo pack have different shapes; collapsing them into a diff produces nonsense. Loud refusal beats silent nonsense.

## Identity precedence

`{pack, slug}` is the primary identifier. Paths are secondary. If two artifacts collide on `{pack, slug}`, the operation fails loud.

## Server-enforced guardrails (atom tier)

- **Citation stripping** — `ollama_research` citations validated against `source_paths`; unknown paths dropped.
- **Protected-path write control** — drafts targeting `memory/`, `.claude/`, `docs/canon/`, etc. require `confirm_write: true`, enforced server-side.
- **Compile check** — `ollama_draft` with a known `language` returns `{compiles, checker, stderr_tail}`. Non-compiling drafts are still returned, but flagged.
- **Confidence threshold** — `classify` below `0.7` triggers `allow_none` fallback. You never see a brittle "best guess."
- **Timeouts with logged fallback** — Instant 5s / Workhorse 20s / Deep 90s. Both the timeout event and the fallback decision land in the NDJSON log.

## Errors are structured

Tool errors return `{ code, message, hint, retryable }`. Stack traces are never exposed through tool results. The server never crashes on bad input.

## No model calls in the artifact tier

`artifact_list`, `artifact_read`, `artifact_diff`, `artifact_export_to_path`, and the three snippet helpers are all code paths. No Ollama. This keeps the filing cabinet independent from the worker.

## Why server-side

Prompt rules drift silently when a prompt evolves. Server-side rules only change when someone explicitly changes the server — and that change gets code review. "The rules are in the prompt" is how you end up with a system that used to be safe.
