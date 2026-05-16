---
name: Feature request
about: Propose a new tool, new hardware profile, or behavior change
title: ""
labels: enhancement
assignees: ""
---

<!--
Read this before filing:

- Pack tier (3) and artifact tier (7) are FROZEN. Issues that propose new pack
  types or new artifact tools will be closed.
- The atom freeze was lifted at v2.1.0. New atoms are allowed when there is an
  audit-justified gap; each new atom needs tests + a handbook page + a
  CHANGELOG entry. Please describe the gap below — what job today can't be
  done with the current 41 tools, and why composing existing ones doesn't fit.
- Hardware profiles, bug fixes, docs, and internals work are always welcome
  without this checklist.

For the full tool-surface policy see CONTRIBUTING.md and HANDOFF.md "Hard rules."
-->

## The gap

What can't be done today with the current tool surface? Be specific — name the
tool(s) you tried, what envelope they returned, and why the result didn't fit
the job.

## Proposed shape

If a new tool: name, tier, input schema sketch, output envelope sketch. If a
behavior change: which tool, what changes, what stays compatible.

```jsonc
// Sketch the call.
{
  "tool": "ollama_…",
  "arguments": { /* … */ }
}
```

```jsonc
// Sketch the envelope.
{
  "result": { /* … */ },
  "tier_used": "…",
  /* envelope fields you'd add or change */
}
```

## Why composing existing tools doesn't fit

Be honest here. Often the answer is "you can chain `extract` + `corpus_search`
+ `corpus_answer`" — if that's the case, the issue may not need a new tool at
all and a docs improvement might be the real fix.

## Migration / compat

If this changes existing behavior: does it stay non-breaking? If not, which
version line absorbs the break? (We hold the v2.x line; breaking changes go
into a v3 plan.)

## Notes

Operator briefs, links to related issues, prior art elsewhere in the MCP
ecosystem.
