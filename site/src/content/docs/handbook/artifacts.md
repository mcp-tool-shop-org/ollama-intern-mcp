---
title: Artifacts & Continuity
description: How packs write to disk — and how to read, diff, export, and stitch their output.
sidebar:
  order: 4
---

The packs are the cathedral. They take a small amount of caller input, run a deterministic pipeline, and write a file you can open next week.

## Where packs write

```
~/.ollama-intern/artifacts/
├── incident/
│   ├── 2026-04-16-5-am-paging-regression.md
│   └── 2026-04-16-5-am-paging-regression.json
├── repo/
│   ├── 2026-04-16-sprite-foundry.md
│   └── 2026-04-16-sprite-foundry.json
└── change/
    ├── 2026-04-16-pr-412.md
    └── 2026-04-16-pr-412.json
```

Identity is `{pack, slug}`. The JSON sidecar carries structured fields; the markdown carries the reader-facing layout. Renderers are code, not prompts — shape is deterministic.

## Reading the artifact shape

Every pack markdown has the same anatomy:

```markdown
# <Pack type> — <title>
slug: <date>-<slug>
weak: <bool> · evidence_count: <n>

## Evidence
- e1: <path>:<lines> (<hint>)
- e2: ...

## <Pack-specific body>
(e.g. Incident: symptoms, timeline, suspected cause)

## Next checks
- investigative only — never "apply this fix"

## Read next
- source paths worth opening next
```

If `weak: true`, the intern flags that evidence is thin and notes coverage gaps. This is a feature — weak evidence surfacing beats smooth confabulation.

## The continuity tier

Seven tools that render without calling a model:

- **`artifact_list`** — metadata-only index. Filter by `pack`, `date`, `slug_glob`. Use when you want to know what's on the desk.
- **`artifact_read`** — typed read by `{pack, slug}` or `{json_path}`. Returns both markdown text and parsed JSON.
- **`artifact_diff`** — structured same-pack comparison. Cross-pack diff is refused loudly — the payloads are shaped differently and should not be collapsed. A `weak` flip (was `false`, now `true` or vice versa) is surfaced prominently.
- **`artifact_export_to_path`** — handoff. Writes an existing markdown artifact, plus a provenance header (source pack, slug, timestamp), to a caller-declared `allowed_roots`. Refuses existing files unless `overwrite: true`.
- **`artifact_incident_note_snippet`** — operator-note fragment for pasting into a Slack thread or a ticket.
- **`artifact_onboarding_section_snippet`** — handbook fragment for pasting into a docs repo.
- **`artifact_release_note_snippet`** — DRAFT release-note fragment derived from `change_pack`.

## Path safety rules

- `..` is rejected before normalize — `join()` collapse does not save you from traversal, and we don't rely on it.
- Export gates on `allowed_roots` — the caller must explicitly name the directories writes are allowed into.
- Overwrite is opt-in: `overwrite: true` must be set, or the call fails loud.
- Protected-path writes (`memory/`, `.claude/`, `docs/canon/`, etc.) require `confirm_write: true` on `draft`.

## Identity precedence

`{pack, slug}` is primary. Paths are secondary. Collisions fail loud — the intern never silently overwrites a filing cabinet.

## No model calls here

The artifact tier reads, diffs, exports, and renders snippets — all from stored content. No Ollama calls happen in this tier. This is the line between "intern producing output" and "intern filing output." They are separate systems.
