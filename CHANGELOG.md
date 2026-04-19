# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.0.0] - 2026-04-19

Hermes-ready release. The blocker that stopped `incident_pack` working end-to-end with Hermes Agent on `hermes3:8b` is fixed, the default model ladder moves to the validated integration path, and Qwen 3 gets first-class runtime support for callers who want it.

### Breaking

- **Default model ladder is now `hermes3:8b`.** The `dev-rtx5080` profile previously shipped `qwen2.5:7b-instruct-q4_K_M` / `qwen2.5-coder:7b-instruct-q4_K_M` / `qwen2.5:14b-instruct-q4_K_M` across Instant/Workhorse/Deep. All three tiers now use `hermes3:8b` — the model Nous Research's Hermes Agent emits clean `tool_calls` for over Ollama's `/v1` chat endpoint, validated end-to-end 2026-04-19. `INTERN_TIER_*` env overrides still work for callers pinning specific models.
- **Retired profile `dev-rtx5080-llama` removed.** Llama 3.1 8B is obsolete; the parity-rail experiment ran its course. `INTERN_PROFILE=dev-rtx5080-llama` now falls back to `dev-rtx5080` (default) instead of erroring.
- **New profile `dev-rtx5080-qwen3` added.** Qwen 3 ladder (`qwen3:8b` / `qwen3:8b` / `qwen3:14b`) for callers who prefer same-family Qwen tooling or want the `THINK_BY_SHAPE` plumbing described below.
- **`m5-max` profile moved to Qwen 3.** `qwen3:14b` / `qwen3:14b` / `qwen3:32b` sized for 128GB unified memory. Qwen 2.5 defaults are retired on modern Ollama installs.
- **Corpus manifest schema v1 → v2.** New `embed_model_resolved` field on every `<name>.manifest.json`. v1 manifests auto-migrate on load — `embed_model_resolved` defaults to `null` until the next embed call supplies a value. No action required for existing corpora.

### Added

- **`source_paths: []` is now accepted on log-driven / diff-driven calls.** `incident_pack`, `incident_brief`, `change_pack`, `change_brief` no longer reject an empty `source_paths` array when `log_text` / `diff_text` is present. This was the last wire-blocker in the Hermes integration — `hermes3:8b` emits `source_paths: []` as the sensible default on log-only incident writeups, and the old `min: 1` schema rejected those calls at validation before the tool body ran. Runtime still requires at least one of `log_text` / `diff_text` / `source_paths`, so the "no evidence at all" guard is unchanged.
- **Qwen 3 runtime plumbing** (`GenerateRequest.think` + `GenerateResponse.thinking` fields in `src/ollama.ts`, `TEMPERATURE_BY_SHAPE` / `TOP_P_BY_MODE` / `THINK_BY_SHAPE` in `src/tiers.ts`). Every `runTool` / `runBatch` caller now declares `think` explicitly per shape: `false` on classify / extract / triage / draft / summarize (load-bearing — Qwen 3 returns an empty `response` if thinking consumes the num_predict budget on short-output tasks); `true` on research / briefs / corpus_answer. The prompt-level `/no_think` soft-switch is ignored by Ollama; only the API field works. Non-thinking models (including the default `hermes3:8b`) silently ignore the field, so declaring it costs nothing.
- **Qwen 3 temperature floors.** Classify / extract / triage bump from 0.1 to 0.2 because Qwen 3 degrades on greedy decoding per the official model card; research / draft bump to 0.6 to match the card's non-thinking recommendation. `hermes3:8b` tolerates the new floors without loss.
- **Silent `:latest` drift detection.** When Ollama silently updates `nomic-embed-text:latest` (or any resolved embed tag) between corpus index and refresh, `ollama_corpus_refresh` now surfaces `embed_model_resolved_drift: { prior, current }` in the report. Report-only in v2.0.0 — no forced re-embed; callers who want uniform vector space re-run `ollama_corpus_index`.
- **Hermes integration docs.** New README section `## Use with Hermes` with a validated config snippet, [`hermes.config.example.yaml`](hermes.config.example.yaml) in the repo root, and a full handbook page at [`handbook/with-hermes`](site/src/content/docs/handbook/with-hermes.md) covering transport caveats, the imperative-vs-list prompt-shape rule, and known blockers.

### Changed

- **Default `OLLAMA_MAX_LOADED_MODELS` guidance drops from 4 to 2** in the README pull instructions. The default ladder is now one model (`hermes3:8b`), so the old headroom is overkill.
- **README / landing page / handbook envelope-and-tiers doc** all updated to reflect the new ladder and profile names. Inline code samples show `"model": "hermes3:8b"` with `"hardware_profile": "dev-rtx5080"`.
- **Envelope type signature** updated: `hardware_profile: "dev-rtx5080" | "dev-rtx5080-qwen3" | "m5-max"` (was `dev-rtx5080-llama`).

### Fixed

- **`strictStringArray({ min: 1 })` default no longer bites log-driven incident / change calls.** Root cause: the helper hard-coded `min: 1` as the default and the four affected tools passed that explicitly. Now each tool passes `min: 0` when the array is secondary evidence. Regression test coverage added across all four tools.

### Tests

- +4 regression tests for `source_paths: []` acceptance (`incidentPack`, `incidentBrief`, `changePack`, `repoAndChangeBrief`).
- +5 assertions on `TEMPERATURE_BY_SHAPE` / `TOP_P_BY_MODE` / `THINK_BY_SHAPE` in `tiers.test.ts`.
- +5 tests for the drift-detection path: resolved-tag capture on index, v1 → v2 manifest migration, drift field surfaces on tag change, drift field absent on no-op and stable runs.
- Profile tests rewritten for the new ladder (hermes3:8b default, dev-rtx5080-qwen3 alternate, retired-profile fallback).

Total: **464 tests passing**, up from 449 in v1.0.2.

### Migration notes

Callers who were pinning `INTERN_TIER_*=qwen2.5:*-instruct-q4_K_M` will hit `OLLAMA_MODEL_MISSING` on v2.0.0 unless they either (a) pull the qwen2.5 tags locally, (b) switch to `hermes3:8b` (no config change needed — it's the default), or (c) switch to `qwen3:*` with `INTERN_PROFILE=dev-rtx5080-qwen3`.

Callers who were using `INTERN_PROFILE=dev-rtx5080-llama` now get the default `dev-rtx5080` profile instead of an error. Pin a specific Llama model via `INTERN_TIER_DEEP=llama3.x:…` if you still need the parity rail.

Translated READMEs (`README.{ja,zh,es,fr,hi,it,pt-BR}.md`) carry the v1.0.2 shape until the next polyglot-mcp run. The English README is canonical.

## [1.0.2] - 2026-04-17

Phase A of the Output Quality Report — contract hardening and doc-draft output-quality gates.

### Added

- **Upstream-stringification diagnostic** for strict array inputs. New `strictStringArray` helper on `source_paths` (research, summarize_deep, change_pack, incident_pack), `labels` (classify), and `patterns` (triage_logs). When a caller sends a JSON-stringified array instead of a native array, the tool rejects with a specific message naming the upstream-stringification case and pointing the caller at their own serialization path. The contract stays strict — no silent coercion. Stderr events tagged `[ollama-intern:stringified-array-guard]`.
- **`source_path` mode** on `classify` and `extract`. Accepts a single file path; the server reads + uses its contents as the classification/extraction input so Claude never pre-reads the file. Optional `per_file_max_chars` (default 40 000). Mutual exclusion: exactly one of `text`, `source_path`, or `items` — explicit `SCHEMA_INVALID` error if ambiguous. (`summarize_deep` already supported `source_paths` as its plural form.)
- **Banned-phrase rejection** on `draft(style="doc")`. After generation, the output is scanned against a curated sludge list (`seamless`, `effortless`, `leverage`, `blazing fast`, `empower`, `robust`, `cutting-edge`, etc. — case-insensitive, whole-word, multi-word flex). If any phrase hits, the draft is discarded and a regeneration fires, up to 3 attempts total. On success the envelope carries `regenerations_triggered` + `detected_phrases`. After 3 failed attempts the call throws a new `DRAFT_BANNED_PHRASE` error (message lists every detected phrase; hint tells the caller to demand concrete, falsifiable claims).
- Error code `DRAFT_BANNED_PHRASE` added to the `ErrorCode` union. `retryable: true`.

### Fixed

- `src/version.ts` was pinned at `0.1.0`, drifted from `package.json`. Re-aligned to the current published version.

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
