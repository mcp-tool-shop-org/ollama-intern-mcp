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

## Now (2026-07 — dogfood swarm on v2.7.2)

The active cycle is a multi-phase **dogfood swarm on v2.7.2**: proactive/defensive health hardening → a cloud feature pass → the full-treatment release. The health passes (routing/cloud robustness, corpus durability, security hardening, and test-honesty) are landing on the `dogfood-health-a` branch — see [CHANGELOG.md](./CHANGELOG.md) for shipped detail. The M5-Max bench-and-tune cycle that used to head this section is superseded and demoted to **Deferred** below (it needs measured M5 Max hardware access, not projections).

### Cloud feature pass — 🟢 unblocked (next)

Builds on the v2.7.0 opt-in cloud routing. Candidate atoms + enhancements:

- **`ollama_verify_claims`** — a job-shaped cross-family verification atom: take claims/findings + sources, return per-claim CONFIRMED/REFUTED verdicts from a big cloud model. This is the verify muscle a role-os `EXTERNAL_VERIFIER` / verify-citations step can call; today that loop has to be lashed up through `ollama_chat` (no verdict enum, no citations).
- **Per-call cloud escalation** — a `backend` override + a cloud-on-demand mode (key set, `PRIMARY` unset) so a local-first operator escalates ONE high-stakes call to a flagship without flipping every call to cloud-primary.
- **`ollama_log_stats`** — aggregate the per-call NDJSON receipts (tokens, cloud/local split, fallback rate, p50/p95 latency) into the "measured economics" the tagline promises.
- **Doctor for the CI persona** — `--json` + a `--fail-unhealthy` exit gate + a cloud-aware `healthy` flag.
- **MCP tool annotations** — `readOnlyHint` / `destructiveHint` / `title` across the tool surface so clients get correct permission UX + a machine-readable taxonomy.

**Acceptance:** each atom ships with tests, a handbook page, and a CHANGELOG entry — the freeze-lift discipline the v2.1.0 pass established.

### Cloud onboarding docs fix — 🟢 unblocked

The cloud-curious persona following the current docs pins a broken model: the README, CLI help, and `handbook/ollama-cloud.md` still document `minimax-m3:cloud` as the default cloud model, but the code default is `qwen3-coder-next:cloud` (changed because `minimax-m3:cloud` is a thinking model that returned empty replies on capped-`num_predict` tools). Reconcile the docs and add an `init --claude` scaffold + a documented smoke path.

### Doc cross-platform refresh — 🟡 exploring

User-facing docs (READMEs, handbook pages) reference `F:/AI/` paths from the original Windows dev box. Mac-/Linux-friendly examples needed:

- 8 README files (en + 7 translations) reference `F:/AI/`
- 2 handbook pages: `site/src/content/docs/handbook/{artifacts,corpora}.md`
- HANDOFF.md is dev-facing, can be updated independently

**Coordination caveat:** updating the English README forces a polyglot regen for the 7 translation siblings. Bundle this with a translation cycle — don't touch English in isolation.

### Carried-forward audit MEDIUMs — 🟢 unblocked

- `ollama_artifact_prune` — surface a `preview_limit` parameter
- `ollama_batch_proof_check` — evaluate a controlled tool-whitelist expansion (the exec surface is now bounded by the operator `INTERN_BATCH_PROOF_ALLOWED_ROOTS` cap, so this can be reconsidered)

Both flagged in prior audits, neither built yet.

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

### M5 Max profile bench + tuning — ⚪ deferred (needs M5 Max hardware access)

The `m5-max` profile values in [`src/profiles.ts`](./src/profiles.ts) are best-guess, not measured. The Day-1 bench plan in [`bench/README.md`](./bench/README.md) (36-cell matrix + embed throughput + concurrency) is ready to run once M5 Max hardware is available for a measured pass; the bench model list also predates the qwen3 decision and needs a refresh. Until then the `m5-max` profile ships with documented best-guess timeouts/models — the default `dev-rtx5080` profile is the measured one.

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
