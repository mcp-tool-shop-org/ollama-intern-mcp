# Roadmap

Forward-looking work for `ollama-intern-mcp`. This file is the index of planned, exploring, and deferred work that doesn't yet have a CHANGELOG entry. Entries get promoted to CHANGELOG `[Unreleased]` once they start.

For shipped work, see [CHANGELOG.md](./CHANGELOG.md).
For protocol / framing, see [`memory/ollama-intern-state-2026-04-22.md`](https://github.com/mcp-tool-shop-org/ollama-intern-mcp) (canonical state, post-v2.1.0).

## Status legend

- 🟢 **unblocked** — ready to start
- 🟡 **exploring** — investigating shape before commit
- 🔴 **blocked** — waiting on hardware, dependency, or external party
- ⚪ **deferred** — intentionally past current cycle

---

## Now (M5 Max validation cycle, 2026-04 → 2026-05)

### M5 Max benchmark run — 🟢 unblocked

Hardware arrived 2026-04-24. The Day-1 deliverable in [`bench/README.md`](./bench/README.md) was queued for this moment.

- Run `bench/run.py` against the `m5-max` profile (Qwen 3 14b/32b ladder + nomic-embed-text)
- Capture the 36-cell matrix (4 models × 3 context lengths × 3 prompt shapes × 3 trials), embed throughput batches, concurrency test
- Output: `results/<ISO-timestamp>.{json,md}` with cloud-vs-local callout
- Budget: ~2 hours

**Acceptance:** measured `tok_per_sec_gen`, `prompt_eval_rate`, peak RSS, KV growth, cold-load wall time per (model × shape × ctx) cell. Not projections.

### M5 Max profile tuning — 🔴 blocked on bench run

Current values in [`src/profiles.ts:99-110`](./src/profiles.ts) are best-guess. Replace with measured numbers from the bench run:

- Verify `qwen3:14b` is right for instant + workhorse on M5 Max 128GB unified, or whether `qwen3:8b` is sharper for instant
- Confirm `qwen3:32b` for deep tier, or evaluate `qwen3:72b` if memory headroom allows
- Tune `M5_MAX_TIMEOUTS` (currently 5/20/90/10s) — instant cold-load on M5 Max may be < 5s
- Decide `prewarm: []` (empty, assumes cold-load is instant) — confirm with bench numbers

**Acceptance:** profile values in `src/profiles.ts` cite the bench run that produced them.

### bench/README.md model list refresh — 🟢 unblocked

Day-1 model list in [`bench/README.md`](./bench/README.md) was written before the qwen3 decision (lists `llama3.3:70b`, `qwen2.5-coder:32b`, `qwen2.5:14b`). The `m5-max` profile now uses `qwen3:14b` + `qwen3:32b`. Bench plan should match.

### Doc cross-platform refresh — 🟡 exploring

User-facing docs (READMEs, handbook pages) reference `F:/AI/` paths from the original Windows dev box. Mac-friendly examples needed for M5 era:

- 8 README files (en + 7 translations) reference `F:/AI/`
- 2 handbook pages: `site/src/content/docs/handbook/{artifacts,corpora}.md`
- HANDOFF.md is dev-facing, can be updated independently

**Coordination caveat:** updating English README forces a polyglot-mcp regen for the 7 translation siblings. Bundle this with a translation cycle — don't touch English in isolation.

### Phase 8 audit MEDIUMs — 🟢 unblocked

Carried forward from canonical memory ([`memory/ollama-intern-state-2026-04-22.md`](https://github.com/mcp-tool-shop-org/ollama-intern-mcp), §"Next session can pick up at" item 3):

- `ollama_artifact_prune` — surface a `preview_limit` parameter
- `ollama_batch_proof_check` — note about tool whitelist expansion

Both are MEDIUM severity, both flagged but not built in v2.1.0 feature pass.

---

## Next (post-bench, before next feature cycle)

### Translation regen for v2.1.0 content — 🔴 blocked on user

The 7 translation README files (`README.{es,fr,hi,it,ja,pt-BR,zh}.md`) lag the v2.1.0 English README. Workflow lives in `memory/translation-workflow.md`. Mike runs polyglot-mcp locally; never automated from Claude.

Bundle with the F:/AI → Mac-friendly path refresh above so translations update once.

### Adoption-pass SEAM round 2 — 🟡 exploring

Pull deferred candidates from `memory/ollama-intern-adoption-pass-2026-04-16.md`. Filter for items not addressed in v2.1.0 feature pass (PR #22 `99e7801`). Score for SEAM #fit before committing to build.

---

## Exploring

### swarm-readout pattern as ollama-intern feature — 🟡 exploring

5 parallel concern lenses (deps / tests / CI / API surface / docs+security) → synthesized markdown report. Code-driven orchestration produces one `<target>/docs/swarm-report/<sha>.md` per run.

**Design reference:** [`docs/design/swarm-readout-pattern.md`](./docs/design/swarm-readout-pattern.md) — full architectural sketch including the 5 concern prompts (verbatim), orchestrator code shape (Claude SDK reference + Ollama port sketch), CLI surface, and the open questions blocking implementation.

**Background:** scaffolded 2026-04-29 as `dogfood-lab/swarm-readout` using `@anthropic-ai/claude-agent-sdk`, then pivoted because the SDK route requires Anthropic API spend (conflicts with local-first ecosystem). Standalone repo deleted same day; design preserved in this repo.

**Open questions blocking promotion to "Now"** (full list in the design doc):
1. Does this fit `ollama_repo_pack`'s shape, or warrant its own MCP tool?
2. File-scan-and-inject vs local tool-call surface (Hermes `/v1`)?
3. Parallel-dispatch memory headroom on M5 Max 128GB — answered by the bench run.
4. Concern axis generality (npm-shape today; Godot/Rust/UE5 need different lenses).
5. v0 synthesis = deterministic stitching, or LLM-driven prioritization pass?

**Acceptance for promotion to "Now":** the design doc grows from "exploring" to "decided" — Q1-Q5 answered with reasoning, named v0 owner.

---

## Deferred

### Landing page Phase 2 — ⚪ deferred

Site-theme integration for the handbook landing page. Cross-cutting with `mcp-tool-shop` site repo. Not M5-related, doesn't block any v2.x release.

### repo-knowledge DB ingest fix — 🔴 blocked on `@mcptoolshop/repo-knowledge`

`@mcptoolshop/repo-knowledge` is missing `dist/schema.sql` in the packaged module (npm-cache path error). Ingest fails for ollama-intern as a downstream consumer. Fix lives in that repo, not here. Track via a `@mcptoolshop/repo-knowledge` issue.

### SCORECARD.md decision — 🟡 exploring

[`SCORECARD.md`](./SCORECARD.md) is marked "Historical — superseded by shipcheck audit." Decide: refresh from current `shipcheck audit` output, or remove. Option to rename to `SCORECARD-2026-04-17.md` and treat as a frozen pre-remediation artifact.

---

## Maintenance signals (when these change, audit the roadmap)

- New canonical memory entry for ollama-intern → re-read this file's references
- Major version bump in `package.json` → promote any `Now` items to `[Unreleased]` in CHANGELOG
- Hardware change (new dev box, M5 → next gen) → trigger a profile-tuning cycle
- New ollama feature in upstream Ollama → check whether tool primitives need to expand
