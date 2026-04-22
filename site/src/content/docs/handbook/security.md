---
title: Security & Threat Model
description: What's touched, what's not, what's in the log, what's never on the wire.
sidebar:
  order: 6
---

## Threat model

Ollama Intern MCP runs on your machine and talks only to a local Ollama instance (`http://127.0.0.1:11434` by default). The network-facing risks are small; the interesting risks are inside the box.

### Primary risks

1. **Hallucinated output trusted as truth.** Small local models fabricate. Mitigated by server-enforced citation stripping, confidence thresholds, `weak: true` flagging, and compile checks on code drafts.
2. **Writes to protected truth surfaces.** Drafts must never overwrite canon, memory, or doctrine files by accident. Mitigated by a versioned protected-path list — writes targeting those paths require explicit `confirm_write: true`, enforced server-side.
3. **Silent model eviction** (Ollama #13227). Inference quietly degrades 5–10× when a model pages to disk. Mitigated by surfacing `residency` in every call envelope — Claude can detect degradation mechanically and tell you.
4. **Path traversal in `research` / corpus / export.** Mitigated by validating every cited path against the `source_paths` input (stripping unknowns), rejecting `..` before normalize, and gating `artifact_export_to_path` on a caller-declared `allowed_roots`.

## Data touched

- File paths the caller explicitly hands in (`ollama_research`, corpus tools)
- Inline text passed to atom/brief/pack tools
- Artifacts the caller asks to be written under `~/.ollama-intern/artifacts/` or a caller-declared `allowed_roots`

## Data NOT touched

- Anything outside `source_paths` / `allowed_roots`
- Files the caller did not hand in
- Protected paths without `confirm_write: true`
- Existing files during export without `overwrite: true`

## Network egress

**Off by default.** The only outbound traffic is to the local Ollama HTTP endpoint. No cloud calls. No update pings. No crash reporting. No telemetry.

## Telemetry

**None.** Every call is logged as one NDJSON line to `~/.ollama-intern/log.ndjson` on your machine. Prompts and inline text are not logged — only the envelope (tier, model, tokens, elapsed, residency). Nothing leaves the box.

## Errors

Errors follow a structured shape:

```ts
{ error: true, code: string, message: string, hint: string, retryable: boolean }
```

Stack traces are never exposed through tool results. `code` names are stable once released — treat them like an API. The full index lives at [Error codes](../error-codes/).

### Mitigations added in v2.0.1 / v2.0.2

- **Embed model swap.** Changing embed models between index and query silently breaks retrieval (different vector space). Mitigated by `EMBED_DIMENSION_MISMATCH` (the cosine guard in `embedMath.ts`) plus `embed_model_resolved_drift` detection on refresh. Re-index after an intentional model swap. See [Corpora → `:latest` drift](../corpora/#schema-v2-and-latest-drift-detection).
- **Symlink hostility.** Symlinks can bypass the indexer's 50 MB size cap and open TOCTOU races between stat and read. Mitigated by lstat-first on every discovered path plus a realpath re-check, rejected with `SYMLINK_NOT_ALLOWED` before any bytes are read.

## Reporting a vulnerability

Please do **not** file public issues for security bugs.

Open a private [security advisory](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/security/advisories/new) via the **Security** tab on the repo. The advisory stays private until a fix is ready. Acknowledgement within 72 hours.

The repo is owned by **mcp-tool-shop-org**; advisories route to the org maintainers.

[SECURITY.md](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md) in the repo is the authoritative policy — this page tracks it.

## Supported versions

v2.x is the active line (v2.0.2 current). Only the latest v2.x release receives security fixes. v1.x is end-of-life.
