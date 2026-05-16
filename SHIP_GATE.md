# Ship Gate

> No repo is "done" until every applicable line is checked.
> Copy this into your repo root. Check items off per-release.

**Tags:** `[all]` every repo · `[npm]` `[pypi]` `[vsix]` `[desktop]` `[container]` published artifacts · `[mcp]` MCP servers · `[cli]` CLI tools

**Repo type:** `[all]` `[npm]` `[mcp]`
**Release:** v<!-- VERSION:start -->2.5.2<!-- VERSION:end --> (2026-05-12)
**Last full re-audit:** 2026-05-15

---

## A. Security Baseline

- [x] `[all]` SECURITY.md exists (report email, supported versions, response timeline) (2026-05-12)
- [x] `[all]` README includes threat model paragraph (data touched, data NOT touched, permissions required) (2026-05-12)
- [x] `[all]` No secrets, tokens, or credentials in source or diagnostics output (2026-05-12)
- [x] `[all]` No telemetry by default — state it explicitly even if obvious (2026-05-12)

### Default safety posture

- [x] `[cli|mcp|desktop]` Dangerous actions (kill, delete, restart) require explicit `--allow-*` flag (2026-05-12) — protected-path writes require `confirm_write: true`; `artifact_export_to_path` requires caller-declared `allowed_roots`; `overwrite` is opt-in; `artifact_prune` is dry-run by default (v2.1.0+)
- [x] `[cli|mcp|desktop]` File operations constrained to known directories (2026-05-12) — `..` rejected before normalize; export gated on `allowed_roots`; artifact roots under `~/.ollama-intern/artifacts/`; `code_map` / `code_citation` (v2.1.0+) inherit the same `allowed_roots` check
- [x] `[mcp]` Network egress off by default (2026-05-12) — only local Ollama (`http://127.0.0.1:11434`); no cloud calls
- [x] `[mcp]` Stack traces never exposed — structured error results only (2026-05-12) — `toErrorShape` in [src/errors.ts](src/errors.ts)

## B. Error Handling

- [x] `[all]` Errors follow the Structured Error Shape: `code`, `message`, `hint`, `cause?`, `retryable?` (2026-05-12) — [src/errors.ts](src/errors.ts)
- [ ] `[cli]` SKIP: MCP server, not a CLI — exit codes do not apply
- [ ] `[cli]` SKIP: MCP server, not a CLI — stack trace/debug flag does not apply
- [x] `[mcp]` Tool errors return structured results — server never crashes on bad input (2026-05-12)
- [x] `[mcp]` State/config corruption degrades gracefully (stale data over crash) (2026-05-12) — corpus manifest tolerates missing sidecars; weak briefs flag `weak: true` rather than failing; v2.2.0+ `abstained: true` shape for sources-don't-address-frame
- [ ] `[desktop]` SKIP: not a desktop app
- [ ] `[vscode]` SKIP: not a VS Code extension

## C. Operator Docs

- [x] `[all]` README is current: what it does, install, usage, supported platforms + runtime versions (2026-05-12)
- [x] `[all]` CHANGELOG.md (Keep a Changelog format) (2026-05-12)
- [x] `[all]` LICENSE file present and repo states support status (2026-05-12) — MIT; v2.x active line note in SECURITY.md
- [ ] `[cli]` SKIP: MCP server, no `--help` surface — tool descriptions served via MCP `tools/list`
- [x] `[cli|mcp|desktop]` Logging levels defined: silent / normal / verbose / debug — secrets redacted at all levels (2026-05-12) — single NDJSON debug channel at `~/.ollama-intern/log.ndjson`; no prompts or secrets logged (inputs elided from envelopes); `ollama_log_tail` (v2.1.0+) tails it from inside the MCP session
- [x] `[mcp]` All tools documented with description + parameters (2026-05-12) — zod schemas with `.describe()` on every tool; v2.3.0 added per-call `model` override surface; v2.4.0 added per-tier `num_ctx` surface
- [ ] `[complex]` SKIP: no background daemon, no state files beyond corpus and artifacts, no warn/critical modes — HANDBOOK not required

## D. Shipping Hygiene

- [x] `[all]` `verify` script exists (test + build + smoke in one command) (2026-05-12) — `npm run verify` = typecheck + build + test; <!-- TEST_COUNT:start -->958<!-- TEST_COUNT:end --> tests pass
- [x] `[all]` Version in manifest matches git tag (2026-05-12) — v<!-- VERSION:start -->2.5.2<!-- VERSION:end --> in package.json, tagged on publish; `src/version.ts` drift fixed in v2.3.0 (now reads from `package.json`)
- [x] `[all]` Dependency scanning runs in CI (ecosystem-appropriate) (2026-05-12) — `npm audit --omit=dev --audit-level=high` in [.github/workflows/ci.yml](.github/workflows/ci.yml)
- [x] `[all]` Automated dependency update mechanism exists (2026-05-12) — [.github/dependabot.yml](.github/dependabot.yml), monthly, grouped
- [x] `[npm]` `npm pack --dry-run` includes: dist/, README.md, SECURITY.md, LICENSE (2026-05-12) — verified at v2.4.0 release (~331 files, ~399.7 kB tarball, ~1.6 MB unpacked; size baseline locked at `BASELINE_PACKED_BYTES = 385_000` in `tests/pack.test.ts`)
- [x] `[npm]` `engines.node` set · `[pypi]` `python_requires` set (2026-05-12) — `engines.node: ">=20.0.0"`
- [x] `[npm]` Lockfile committed · `[pypi]` Clean wheel + sdist build (2026-05-12)
- [ ] `[vsix]` SKIP: not a VS Code extension
- [ ] `[desktop]` SKIP: not a desktop app

## E. Identity (soft gate — does not block ship)

- [x] `[all]` Logo in README header (2026-05-12) — brand repo `mcp-tool-shop-org/brand/logos/ollama-intern-mcp/readme.png`, 1536×1024
- [x] `[all]` Translations (polyglot-mcp, 8 languages) (2026-05-12) — zh, es, fr, hi, it, ja, pt-BR via TranslateGemma 12B; language switcher in README header; regenerated as part of release prep, before `npm publish`
- [ ] `[org]` Landing page (@mcptoolshop/site-theme) — Phase 2 of The Treatment
- [x] `[all]` GitHub repo metadata: description, homepage, topics (2026-05-12) — description + homepage + 10 topics set on `mcp-tool-shop-org/ollama-intern-mcp`

---

## Gate Rules

**Hard gate (A–D):** Must pass before any version is tagged or published.
If a section doesn't apply, mark `SKIP:` with justification — don't leave it unchecked.

**Soft gate (E):** Should be done. Product ships without it, but isn't "whole."

**Checking off:**
```
- [x] `[all]` SECURITY.md exists (2026-02-27)
```

**Skipping:**
```
- [ ] `[pypi]` SKIP: not a Python project
```
