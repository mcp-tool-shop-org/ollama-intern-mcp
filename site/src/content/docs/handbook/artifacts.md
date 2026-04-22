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

## Snippet workflows

The three snippet helpers are the bridge from "there is a pack on disk" to "here is a handful of lines I can paste." Each is deterministic — same artifact in, same snippet out. No model call, no re-render.

### `artifact_incident_note_snippet`

You ran `incident_pack` on a 5 AM paging regression. Later, you need a compact markdown block to paste into a Slack thread or a ticket.

```jsonc
{
  "tool": "ollama_artifact_incident_note_snippet",
  "arguments": {
    "slug": "2026-04-16-sprite-pipeline-5-am-paging-regression"
  }
}
```

Returns:

```jsonc
{
  "result": {
    "markdown": "### Incident: sprite pipeline 5 AM paging regression\n- symptom: worker-3 OOM killed, ollama reports evicted=true\n- suspected cause: OLLAMA_MAX_LOADED_MODELS too high vs loaded size\n- next checks:\n  - residency.evicted across last 24h\n  - OLLAMA_MAX_LOADED_MODELS vs loaded size\n- slug: 2026-04-16-sprite-pipeline-5-am-paging-regression"
  }
}
```

Paste the `markdown` field into a ticket. The shape is fixed — reviewers who see one of these know the shape and can skim.

### `artifact_onboarding_section_snippet`

You ran `repo_pack` against `F:/AI/sprite-foundry/`. Now you're writing the onboarding doc for a new contributor and want a handbook-shaped section lifted from the pack.

```jsonc
{
  "tool": "ollama_artifact_onboarding_section_snippet",
  "arguments": { "slug": "2026-04-16-sprite-foundry" }
}
```

Returns a markdown fragment: `## <repo name>`, a one-paragraph orientation, and a "start reading here" list with file paths. Paste into your handbook.

### `artifact_release_note_snippet`

You ran `change_pack` on PR #412. Now you're drafting the release note.

```jsonc
{
  "tool": "ollama_artifact_release_note_snippet",
  "arguments": { "slug": "2026-04-16-pr-412" }
}
```

Returns a **DRAFT** release-note fragment — kind, scope, summary, a bullet list of user-visible changes. Marked DRAFT because `change_pack` is investigative; a human should edit before shipping.

## `artifact_prune`

New in v2.1.0. Age-based deletion of pack artifacts. Dry-run is the default — deletion requires explicit `dry_run: false`.

### Safety example (always start with dry-run)

```jsonc
{
  "tool": "ollama_artifact_prune",
  "arguments": {
    "older_than_days": 90,
    "pack": "incident"
    // dry_run defaults to true
  }
}
```

Returns:

```jsonc
{
  "result": {
    "dry_run": true,
    "would_delete": [
      { "pack": "incident", "slug": "2026-01-04-vram-probe-flake",
        "age_days": 107 },
      { "pack": "incident", "slug": "2026-01-11-corpus-index-stall",
        "age_days": 100 }
    ],
    "total": 2
  }
}
```

Review the list. If it's correct, re-run with `dry_run: false`:

```jsonc
{
  "tool": "ollama_artifact_prune",
  "arguments": {
    "older_than_days": 90,
    "pack": "incident",
    "dry_run": false
  }
}
```

Returns `{ deleted: [...], total: N }`. The deletion is unrecoverable — rerun dry-run if you're uncertain.

The tool honors the same path-safety rules as the rest of the artifact tier: it only operates under `~/.ollama-intern/artifacts/`, `..` is refused, pack-filter is required to be one of `incident | repo | change`. It cannot delete anything outside that tree.
