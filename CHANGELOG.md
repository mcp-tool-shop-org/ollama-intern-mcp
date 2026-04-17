# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Upstream-stringification diagnostic** for strict array inputs. New `strictStringArray` helper on `source_paths` (research, summarize_deep, change_pack, incident_pack), `labels` (classify), and `patterns` (triage_logs). When a caller sends a JSON-stringified array instead of a native array, the tool rejects with a specific message naming the upstream-stringification case and pointing the caller at their own serialization path. The contract stays strict — no silent coercion. Stderr events tagged `[ollama-intern:stringified-array-guard]`.
- **`source_path` mode** on `classify` and `extract`. Accepts a single file path; the server reads + uses its contents as the classification/extraction input so Claude never pre-reads the file. Optional `per_file_max_chars` (default 40 000). Mutual exclusion: exactly one of `text`, `source_path`, or `items` — explicit `SCHEMA_INVALID` error if ambiguous. (`summarize_deep` already supported `source_paths` as its plural form.)
- **Banned-phrase rejection** on `draft(style="doc")`. After generation, the output is scanned against a curated sludge list (`seamless`, `effortless`, `leverage`, `blazing fast`, `empower`, `robust`, `cutting-edge`, etc. — case-insensitive, whole-word, multi-word flex). If any phrase hits, the draft is discarded and a regeneration fires, up to 3 attempts total. On success the envelope carries `regenerations_triggered` + `detected_phrases`. After 3 failed attempts the call throws a new `DRAFT_BANNED_PHRASE` error (message lists every detected phrase; hint tells the caller to demand concrete, falsifiable claims).
- Error code `DRAFT_BANNED_PHRASE` added to the `ErrorCode` union. `retryable: true`.

### Tests

- +54 tests across `tests/guardrails/stringifiedArrayGuard.test.ts` (20), `tests/guardrails/bannedPhrases.test.ts` (14), `tests/tools/extract.test.ts` (7), `tests/tools/draft.test.ts` (8), `tests/tools/classify.test.ts` (+5). Total 449 passing.

## [1.0.1] - 2026-04-17

### Added

- Translated READMEs via polyglot-mcp (TranslateGemma 12B): Chinese, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese. README header carries a language switcher.

## [1.0.0] - 2026-04-17

First stable release. 28 tools across 4 tiers, 395 tests, pre-publish hardening complete.

### Added

- **Retrieval Truth spine** — schema v2 (heading-aware chunks + titles map), lexical BM25 with per-field scores, query modes with RRF fusion, retrieval eval pack, `corpus_answer` for chunk-grounded synthesis over a living corpus.
- **Workflow spine** — batch surfaces for `classify` / `extract` / `triage_logs` (one envelope per batch, duplicate ids refused), living corpora (manifest + incremental refresh), operator briefs for incident / repo / change.
- **Pack spine** — fixed-pipeline compound jobs (`incident_pack`, `repo_pack`, `change_pack`) that produce deterministic markdown + JSON artifacts. Default roots under `~/.ollama-intern/artifacts/`.
- **Artifact spine** — continuity surface over pack outputs: `artifact_list`, `artifact_read`, `artifact_diff`, `artifact_export_to_path` (requires caller-declared `allowed_roots`), plus three pack-shaped snippet helpers (incident note, onboarding section, release note).
- Structured error shape `{ code, message, hint, retryable }` enforced across all tool results (no raw stack traces).
- Envelope on every call: `result`, `tier_used`, `model`, `hardware_profile`, `tokens_in/out`, `elapsed_ms`, `residency` (from Ollama `/api/ps`).
- Hardware profiles: `dev-rtx5080`, `dev-rtx5080-llama`, `m5-max`.
- Server-enforced guardrails: citation stripping, protected-path write control, compile check, confidence threshold, timeouts with logged fallback.
- NDJSON call log at `~/.ollama-intern/log.ndjson`.

### Security

- Threat model documented in README and [SECURITY.md](SECURITY.md).
- No telemetry. No network egress beyond the local Ollama endpoint.
- Path traversal hardened — `..` rejected before normalize; cross-pack diffs refused loudly; export refuses existing files unless `overwrite: true`.

### Locked laws (all tested)

- Evidence first-class — every brief claim cites evidence ids; unknown refs stripped server-side with warning.
- Weak briefs degrade honestly — thin evidence flags `weak: true` with coverage notes; never smooths fake narrative.
- No remediation drift — `next_checks` / `read_next` / `likely_breakpoints` are investigative only; prompts forbid "apply this fix".
- Deterministic renderers — pack artifacts use fixed markdown layouts; `draft` is reserved for prose where model wording matters.
- Identity precedence — `{pack, slug}` is primary for artifact addressing; paths are secondary; collisions fail loud.
- No model calls in the artifact tier — export, list, read, diff, snippets all render from stored content.
