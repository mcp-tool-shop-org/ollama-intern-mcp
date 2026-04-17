# Coverage Contract

Multi-source research calls must not silently omit sources. Every
response carries `covered_sources`, `omitted_sources`, and
`coverage_notes` so the caller can see at a glance which inputs were
actually consulted in the answer.

## Why this exists

The adoption pass exposed a case where a two-file summary silently
covered only one file. The coverage contract makes that failure mode
impossible — detection is deterministic (token overlap), not an extra
LLM call.

## Shape

- `covered_sources`: paths whose content appears in the output
- `omitted_sources`: paths that were passed in but not represented
- `coverage_notes`: human-readable explanation when anything is omitted
