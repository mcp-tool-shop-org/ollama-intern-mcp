# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-04-18

Four additive layers shipped above the frozen 28-tool primitive core. 28 → 40 tools, 449 → 596 tests. The primitive surface is unchanged — every new capability lives in a layer above the spine.

### Added — Skill layer (Phase 1 / 2 / 2.5)

- **5 new tools:** `ollama_skill_list`, `ollama_skill_match`, `ollama_skill_run`, `ollama_skill_propose`, `ollama_skill_promote`.
- Durable named pipelines composing atoms + briefs + packs, with declared triggers, parameters, and a receipt written after every run.
- Global skills in `~/.ollama-intern/skills/*.json`; project skills in `<cwd>/skills/*.json` override global by name.
- Skill receipts land in `<cwd>/artifacts/skill-receipts/*.json`.
- Proposals surface in two flavors: lifecycle (promote / retire) and new-skill proposals reconstructed from ad-hoc chains in the NDJSON call log (Phase 2.5).

### Added — Memory layer (Phase 3A / 3B / 3C)

- **5 new tools:** `ollama_memory_refresh`, `ollama_memory_search`, `ollama_memory_read`, `ollama_memory_explain`, `ollama_memory_neighbors`.
- Embedding-backed retrieval across receipts, pack artifacts, skills, and candidate proposals.
- Nomic prefix contract enforced: records get `search_document:`, queries get `search_query:`. Never reversed, never dropped.
- Typed hits with score bands, optional metadata pre-filters.
- Deterministic field-level match explanations; `narrate=true` opts into an Instant-tier natural-language summary; `include_excerpt=true` attaches a structured source extract.
- Neighbors is pure math over the embedding space — no model call.
- Memory lives at `~/.ollama-intern/memory/index.json` + `memory/embeddings.json`. Override with `INTERN_MEMORY_DIR`.

### Added — Shadow routing runtime (Phase 3D-A / 3D-B)

- Every call to a shadowable tool (10 atoms + 5 flagships + 3 packs = **18 shadowable tools**) writes a `RoutingReceipt` to `<cwd>/artifacts/routing-receipts/<id>.json` capturing the pre-execution decision, the actual invocation, outcome linkage, and the calibration overlay `version` in effect.
- Actual tool behavior is unchanged. Shadow routing is **shadow-only** — no tool surface, no control transfer.
- Skill-layer, memory-layer, artifact-management, corpus-management, and embed-primitive tools are on the bypass list.

### Added — Routing audit + calibration (Phase 3D-C / 3D-D)

- **2 new tools:** `ollama_routing_audit`, `ollama_routing_calibrate`.
- `routing_audit` surfaces six finding categories: `promotion_gap`, `override_hotspot`, `abstain_cluster`, `missed_abstain`, `unused_candidate`, `overconfident_route`. Each finding carries a `recommended_next_action`.
- `routing_calibrate` runs an action-typed lifecycle: `propose` / `list` / `replay` / `approve` / `reject` / `rollback`. Replay shows the effect a proposal would have had on a historical receipt window.
- **Calibration is operator-gated.** Every approval requires a `reason` string. Every transition appends to history. Nothing auto-applies.
- Active overlay `version` is stamped onto every receipt. Audits can always answer "which calibration produced this decision?"
- When a finding points at a gap calibration can't close (e.g., `missed_abstain` on a primitive that isn't in the candidate space), replay returns a zero-effect result and the audit recommends skill authoring instead.
- Calibration store lives at `~/.ollama-intern/calibrations/store.json`. Override with `INTERN_CALIBRATIONS_DIR`.

### Changed — Model ladder

- **Default dev profile now runs the Qwen 3 ladder.** Instant + Workhorse = `qwen3:8b`; Deep = `qwen3:14b`. Workhorse stays on qwen3:8b until a quantized Qwen3-Coder MoE variant fits 16GB VRAM comfortably.
- **M5 Max profile now runs Qwen 3 + Llama 4 Scout.** Instant = `qwen3:14b`; Workhorse = `qwen3:32b`; Deep = `llama4:scout` (109B-total / 17B-active MoE). Formatter layer branches on model family because Llama 4 uses a different chat template (`<|header_start|>` / `<|eot|>`) than Llama 3.x.
- Qwen 3 requires `think: false` on short-output shapes — enforced automatically by `THINK_BY_SHAPE` in `src/tiers.ts`. Temperature defaults calibrated to Qwen 3 guidance (classify/extract/triage floor at 0.2, never zero).
- Nomic embeddings use documented `search_document:` / `search_query:` prefix contract.

### Removed

- `dev-rtx5080-llama` profile retired (2026-04-18). Llama 3.1 8B is obsolete; Llama 4 Scout doesn't fit 16GB VRAM. If a Llama parity lane is needed later, it'll target a Llama 4 variant sized for consumer cards.

### Tests

- +147 tests. Total now 596 passing (up from 449), covering skill runner + proposer + promoter, chain reconstruction + new-skill proposal, memory substrate + retrieval + read/explain/neighbors, router core + shadow runtime, audit surfaces, calibration lifecycle with propose/replay/approve/rollback.
- Live end-to-end proofs under `scripts/live-*-proof.mjs` (10 scripts, one per phase). Not shipped in the npm package (excluded from `files` whitelist).

### Design laws (all tested)

- **Frozen primitive core.** 28 atoms / briefs / packs / artifact tools do not grow. New capability is a NEW LAYER ABOVE.
- **Shadow routing is shadow-only.** `shadowRun` writes receipts; actual invocation unchanged.
- **Calibration is operator-gated.** Every approval requires a reason; every transition appends to history.
- **Receipt attribution.** Every decision under an overlay stamps the overlay `version` onto its receipt.
- **Qwen 3 `think: false`** on short-output shapes. Otherwise thinking consumes `num_predict` and the response is empty.
- **Nomic prefixes.** Records get `search_document:`; queries get `search_query:`. Never reversed.
- **Privacy-safe NDJSON.** Log records input SHAPE (presence, counts, buckets), never content.
- **Deterministic defaults.** Memory explanations deterministic; `narrate=true` and `include_excerpt=true` are explicit opt-ins.

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
