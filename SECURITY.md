# Security Policy

## Threat Model

Ollama Intern MCP is a **local delegation layer**. It runs on the user's machine and talks only to a local Ollama instance (`http://localhost:11434` by default). No cloud calls, no telemetry.

The primary risks are not network-facing. They are:

1. **Hallucinated output trusted as truth.** Small local models fabricate. Mitigated by server-enforced citation stripping, confidence thresholds, `source_preview` in summaries, and compile checks on code drafts.
2. **Writes to protected truth surfaces.** Drafts must never overwrite canon, memory, or doctrine files by accident. Mitigated by a versioned protected-path list in [`src/protectedPaths.ts`](src/protectedPaths.ts) — writes targeting those paths require explicit `confirm_write: true`, enforced server-side (never prompt-side).
3. **Silent model eviction** (Ollama issue #13227). Inference quietly degrades 5–10× when a model pages to disk. Mitigated by surfacing `residency` in every call envelope so Claude can detect degradation mechanically.
4. **Path traversal in `ollama_research`.** Mitigated by validating every cited path against the `source_paths` input and stripping any unknown path before returning.

## Reporting

Email: 64996768+mcp-tool-shop@users.noreply.github.com

Please do not file public issues for security bugs. We will acknowledge within 72 hours.

## Supported Versions

Pre-1.0. Only the latest release receives security fixes.
