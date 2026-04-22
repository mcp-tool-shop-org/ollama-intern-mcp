# Security Policy

## Threat Model

Ollama Intern MCP is a **local delegation layer**. It runs on the user's machine and talks only to a local Ollama instance (`http://localhost:11434` by default). No cloud calls, no telemetry.

The primary risks are not network-facing. They are:

1. **Hallucinated output trusted as truth.** Small local models fabricate. Mitigated by server-enforced citation stripping, confidence thresholds, `source_preview` in summaries, and compile checks on code drafts.
2. **Writes to protected truth surfaces.** Drafts must never overwrite canon, memory, or doctrine files by accident. Mitigated by a versioned protected-path list in [`src/protectedPaths.ts`](src/protectedPaths.ts) — writes targeting those paths require explicit `confirm_write: true`, enforced server-side (never prompt-side).
3. **Silent model eviction** (Ollama issue #13227). Inference quietly degrades 5–10× when a model pages to disk. Mitigated by surfacing `residency` in every call envelope so Claude can detect degradation mechanically.
4. **Path traversal in `ollama_research`.** Mitigated by validating every cited path against the `source_paths` input and stripping any unknown path before returning.
5. **Embed model swap between index and query.** Changing embed models (or letting `:latest` drift out from under you) silently breaks retrieval — query vectors land in a different space than stored vectors. Mitigated by `EMBED_DIMENSION_MISMATCH` (cosine guard in `src/embedMath.ts`) and `embed_model_resolved_drift` detection on `ollama_corpus_refresh`. Re-index after an intentional model swap.
6. **Symlink hostility in the corpus indexer.** Symlinks can bypass the 50 MB file-size cap and open a TOCTOU race between stat and read. Mitigated by an lstat-first check plus a realpath re-check, rejected with `SYMLINK_NOT_ALLOWED` before any bytes are read.

### Mitigations added in v2.0.1 / v2.0.2

Most of the above is not original to v1.0.0. v2.0.1 added the corpus indexer hardening (TOCTOU, 50 MB cap, symlink rejection, atomic writes, per-corpus lock, schema-version guard) plus the tool path-traversal hole on Windows (`path.relative`-based containment) plus triage-logs prompt-injection sanitization. v2.0.2 carried these through the zod v4 / TypeScript 6 toolchain bump without behavior change. This threat model reflects the current v2.0.2 surface.

## Reporting

Please do **not** file public issues for security bugs.

Open a private [security advisory](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/security/advisories/new) via the **Security** tab on this repo. The advisory stays private until a fix is ready. We will acknowledge within 72 hours.

The repo is owned by **mcp-tool-shop-org**; advisories route to the org maintainers.

## Supported Versions

v2.x is the active line (v2.0.2 current). Only the latest v2.x release receives security fixes. v1.x is end-of-life.
