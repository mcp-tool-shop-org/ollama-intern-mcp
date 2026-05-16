---
title: Security & Threat Model
description: Pointer to the canonical SECURITY.md — threat model, data touched, network egress, telemetry, vulnerability reporting.
sidebar:
  order: 6
---

The threat model, data-handling policy, network egress posture, telemetry stance, and vulnerability reporting process are all maintained in one place: **[SECURITY.md](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md)** in the repo. This handbook page used to duplicate that content and drifted across releases. It is now a thin pointer so the canonical text stays canonical.

## Quick orientation

For operators landing here from search, the short version:

- **Local-only.** Network egress is off by default. The only outbound traffic is to the local Ollama HTTP endpoint (`http://127.0.0.1:11434`). No cloud calls, no update pings, no crash reporting.
- **No telemetry.** Every call logs one NDJSON line to `~/.ollama-intern/log.ndjson` on your machine. Inputs (prompts, inline text) are not logged — only the envelope (tier, model, tokens, elapsed, residency).
- **Path-safety enforced server-side.** Tools that read or write files validate against caller-declared `source_paths` / `allowed_roots`; `..` is rejected before normalize; protected-path writes require `confirm_write: true`.
- **Structured errors only.** Stack traces are never exposed through tool results. Errors return `{ error, code, message, hint, retryable }`. The full index lives at [Error codes](../error-codes/).
- **Active line is v2.x.** Only the latest v2.x release receives security fixes (v2.4.0 as of 2026-05-12). v1.x is end-of-life.

## What lives in the canonical SECURITY.md

If you're auditing the surface, [SECURITY.md](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md) covers (in order):

- The six original threat-model risks (hallucinated output, protected-path writes, silent model eviction, path traversal in `research`, embed-model swap, symlink hostility in the corpus indexer).
- Mitigations added in v2.0.1 / v2.0.2 (corpus indexer hardening, Windows path-traversal fix, triage-logs prompt-injection sanitization).
- **New attack surfaces in v2.1.0** — these are the ones that actually changed the surface, not just hardened it:
  - **Filesystem delete in `artifact_prune`** (first tool that deletes; dry-run default, scoped to `~/.ollama-intern/artifacts/<pack>/`).
  - **Process execution in `batch_proof_check`** (new execution surface; cwd validation + per-check timeouts + tool whitelist).
  - **Corpus-as-snapshot invariant break in `corpus_amend`** (additive in-place edits surfaced via `has_amended_content: true`).
  - **File-reading in `code_map` / `code_citation`** (same `allowed_roots` mitigation as `research` and the corpus tools).
- The vulnerability reporting process (private GitHub security advisory, 72-hour acknowledgement).
- The supported-versions policy.

## Reporting a vulnerability

Please do **not** file public issues for security bugs.

Open a private [security advisory](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/security/advisories/new) via the **Security** tab on the repo. The advisory stays private until a fix is ready. Acknowledgement within 72 hours.

The repo is owned by **mcp-tool-shop-org**; advisories route to the org maintainers.

[SECURITY.md](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md) is the authoritative source — this page is a pointer, not a parallel record.
