# Security Policy

## Threat Model

Ollama Intern MCP is a **local-first delegation layer**. By default it runs on the user's machine and talks only to a local Ollama instance (`http://localhost:11434` by default) — **zero network egress, no telemetry**. An **opt-in** cloud mode (off unless explicitly enabled) can route the generative tiers to Ollama Cloud; see threat #11. Embeddings always stay local.

The primary risks are not network-facing. They are:

1. **Hallucinated output trusted as truth.** Small local models fabricate. Mitigated by server-enforced citation stripping, confidence thresholds, `source_preview` in summaries, and compile checks on code drafts.
2. **Writes to protected truth surfaces.** Drafts must never overwrite canon, memory, or doctrine files by accident. Mitigated by a versioned protected-path list in [`src/protectedPaths.ts`](src/protectedPaths.ts) — writes targeting those paths require explicit `confirm_write: true`, enforced server-side (never prompt-side).
3. **Silent model eviction** (Ollama issue #13227). Inference quietly degrades 5–10× when a model pages to disk. Mitigated by surfacing `residency` in every call envelope so Claude can detect degradation mechanically.
4. **Path traversal in `ollama_research`.** Mitigated by validating every cited path against the `source_paths` input and stripping any unknown path before returning.
5. **Embed model swap between index and query.** Changing embed models (or letting `:latest` drift out from under you) silently breaks retrieval — query vectors land in a different space than stored vectors. Mitigated by `EMBED_DIMENSION_MISMATCH` (cosine guard in `src/embedMath.ts`) and `embed_model_resolved_drift` detection on `ollama_corpus_refresh`. Re-index after an intentional model swap.
6. **Symlink hostility in the corpus indexer.** Symlinks can bypass the 50 MB file-size cap and open a TOCTOU race between stat and read. Mitigated by an lstat-first check plus a realpath re-check, rejected with `SYMLINK_NOT_ALLOWED` before any bytes are read.

### Mitigations added in v2.0.1 / v2.0.2

Most of the above is not original to v1.0.0. v2.0.1 added the corpus indexer hardening (TOCTOU, 50 MB cap, symlink rejection, atomic writes, per-corpus lock, schema-version guard) plus the tool path-traversal hole on Windows (`path.relative`-based containment) plus triage-logs prompt-injection sanitization. v2.0.2 carried these through the zod v4 / TypeScript 6 toolchain bump without behavior change.

### New surfaces in v2.1.0

v2.1.0 adds tools that extend the attack surface in ways the prior versions did not have. Each new surface is called out here with its mitigation.

7. **Filesystem delete in `artifact_prune`.** First tool that deletes. Mitigated by (a) dry-run as the default — `dry_run: false` must be explicit; (b) deletion restricted to `~/.ollama-intern/artifacts/<pack>/` subtrees, `..` refused; (c) pack filter required to be one of `incident | repo | change`; (d) age-based filter expressed in whole days so off-by-one can't delete today's artifact. Cannot reach outside the artifacts tree.

8. **Process execution in `batch_proof_check`.** Shells out to `tsc`, `eslint`, `pytest` under the caller's cwd. This is a **new execution surface** the earlier versions did not have. Mitigated by (a) cwd validation against `allowed_roots` — the proof run cannot launch from a path the caller didn't declare; (b) per-check timeouts — a runaway linter or hanging test cannot hold the server; (c) tool whitelist — only the three tools above are invocable, no arbitrary shell; (d) structured error shape on failure (no raw process stderr in the envelope). The caller still owns whatever the listed tools read from disk — if `tsc` is pointed at hostile source, `tsc` owns that risk, not us.

9. **Corpus-as-snapshot invariant broken by `corpus_amend`.** Earlier versions treated every corpus as a pure disk snapshot — identical input always produced identical output. `corpus_amend` allows additive in-place edits, which can drift a corpus from its manifest-hashed origin. Mitigated by surfacing `has_amended_content: true` on every `corpus_answer` result whose backing corpus was amended. Callers doing audit-grade work can detect amendment and re-run `ollama_corpus_index` from source to return to a clean snapshot.

10. **File-reading surface in `code_map` and `code_citation`.** Both tools read source files to produce structural maps and symbol citations. Mitigated by the same `allowed_roots` check used by `research` and the corpus tools — files outside the caller-declared roots are refused at the tool entry. `..` normalization still runs before path use.

### New surface in v2.7.0

11. **Cloud egress when opted in (`OLLAMA_CLOUD_PRIMARY` + `OLLAMA_API_KEY`).** The first network surface that leaves the machine. **Off by default** — the package is byte-identical to local-only behavior unless BOTH the flag and the key are set, so the "zero egress by default" guarantee is preserved for every non-opting user. When enabled:
    - **What leaves the box:** prompts + inputs for the *generative* tiers (instant/workhorse/deep) are POSTed to `OLLAMA_CLOUD_HOST` (default `https://ollama.com`) over HTTPS with an `Authorization: Bearer` header. **Embeddings never route to cloud** — the corpus/embed tools stay fully local. Mitigated by being opt-in, disclosed in the README and startup logs, and surfaced per-call on the envelope (`backend`, `degraded`, `degrade_reason`) so a cloud-served answer is never indistinguishable from a local one.
    - **Key handling:** the key is read from the `OLLAMA_API_KEY` runtime env var (the operator supplies it via their MCP client's `env` block). It is never written to disk, never logged (NDJSON events carry models/tiers/reasons, not the key), and is refused to a loopback host (a Bearer header sent to local Ollama 403s). A GitHub Actions secret is NOT a runtime credential — it is invisible to the running server.
    - **Third-party prompt handling:** routing to Ollama Cloud means prompts are processed by Ollama's infrastructure. Per [Ollama's privacy policy](https://ollama.com/privacy), cloud prompts/responses are processed transiently, not retained beyond the request, and not used for training — but this is a third-party assurance, not a local guarantee. Operators handling sensitive material should weigh this before enabling cloud, or keep cloud off (the default).
    - **Failure posture:** transient cloud failures fall back to the local profile (degraded, observable); a bad/expired key (401/403) trips a sticky breaker that surfaces loudly rather than silently degrading forever.

## Reporting

Please do **not** file public issues for security bugs.

Open a private [security advisory](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/security/advisories/new) via the **Security** tab on this repo. The advisory stays private until a fix is ready. We will acknowledge within 72 hours.

The repo is owned by **mcp-tool-shop-org**; advisories route to the org maintainers.

## Supported Versions

v2.x is the active line. Only the latest v2.x release receives security fixes. v1.x is end-of-life.
