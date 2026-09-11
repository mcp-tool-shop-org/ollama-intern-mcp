# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.10.0] - 2026-09-11

The cloud-honesty release. v2.9.0 shipped per-call cloud escalation and the README advertised it as "escalate one high-stakes review to a 600B model" — but the `backend` input existed on exactly **one** of 44 tools, and it was `ollama_chat`, whose own description calls it a last resort. Every review-shaped job was pinned to a local 8B with no escape hatch short of flipping every call to cloud. Most people cannot host a frontier model on their own GPU; that hardware ceiling, not interest, is the real limit on local AI, and this release makes the thing that lifts it actually reachable.

Local-first is unchanged and still the default: no key means zero egress and no startup probe, embeddings never leave the box, and every new knob defaults to today's behavior.

### Added

- **Per-call cloud escalation on 15 tools (was 1).** `backend: "cloud" | "local"` is now an optional input on `research`, `summarize_deep`, `code_review`, `code_citation`, `corpus_answer`, `hypothesis_drill`, `multi_file_refactor_propose`, `refactor_plan`, all three briefs, all three packs, and `chat`. Omitting it is byte-identical to v2.9.x. **Packs escalate their SYNTHESIS step only** — evidence assembly, triage, extract and artifact writes stay local — and each pack refuses an unservable escalation *before* doing any local work, rather than after.
- **`INTERN_CLOUD_STANDBY_TIERS` — a declared standby escalation policy.** A comma list of `instant|workhorse|deep` (or `none`) naming which tiers escalate under standby without a per-call directive. Empty by default, so a key alone is still zero egress. A per-call `backend` directive outranks the policy in **both** directions. `embed` is rejected by name at config load *and* filtered at the routing layer — embeddings always stay local, and since Ollama Cloud serves no embedding models, an escalated embed would ship chunk text off the machine and then fail.
- **`doctor --cloud-check` — the first in-product proof that a cloud key works.** The existing probe hits `/api/tags`, which returns 200 for an invalid key, so `auth` could only ever report "unverified". This runs one 8-token generate against the instant cloud model and returns a four-state verdict: `ok` (a call round-tripped — the only state that proves the key), `failed` (a definitive 401/403), `unverified` (the host answered but rejected for a reason that is not about the key — today a 404 on the model id), and `unreachable` (timeout / network / 5xx). The states stay distinct on purpose: collapsing `unverified` into `failed` sends an operator hunting a key when the fix is `INTERN_CLOUD_MODEL`. Discloses egress before the first byte and writes a `cloud_egress` receipt on every path including failures — sizes and identities only, never content.
- **Cloud catalog reporting.** The doctor probe already fetched the live cloud model list and discarded it. It now keeps it and reports each configured cloud id as present / NOT IN CATALOG, with a nearest-live-id suggestion (base-name first, since the commonest error is a dropped `:cloud` tag). Advisory by design — a catalog miss warns loudly but never gates CI.
- **Model-class signalling.** A `weak: true` brief used to diagnose thin *evidence* only, telling the user to add source paths when the real remedy may be a bigger model.
- **CI installs and runs the published tarball.** A smoke step in the existing lockfile job packs, installs into a scratch prefix, and drives the binary through its `node_modules/.bin` shim — `--version`, `--help`, `doctor --json`, and a real `init`. It asserts `OLLAMA_API_KEY` is empty, so a secret mapped into that job later turns the gate red instead of quietly becoming a cloud test.

### Fixed

- **`init` was broken on every npm install.** `hermes.config.example.yaml` was missing from the published tarball (`package.json`'s `files` allowlist omitted it) while the binary read it from the package root — so `ollama-intern-mcp init` failed with its own "This is a packaging bug" message for anyone who installed from npm. The file now ships, and the new tarball smoke is the gate that would have caught it.
- **Stale cloud-model guidance.** Two error paths sent the operator to a browser to re-check live cloud ids; both now point at `doctor --cloud-check`, which answers it in-product.
- **Stage D presentation pass (43 fixes).** `runCliDoctor` dropped every remediation sentence `handleDoctor` composed — both output modes now render them. `corpus_health` claimed to be a `corpus_list` superset while renaming four keys; the superset promise is now compiler-enforced via `extends CorpusSummary`. Pack markdown clipped evidence to a flat 400 chars, below its own per-kind caps and with no truncation marker, so the human half of a pack pair showed up to 43% less evidence than the machine half while presenting it as a verbatim quote. `corpus_list` dropped unloadable corpora with no trace in the returned payload. The hint-quality gate parsed 138 of 155 `InternError` sites behind a `toBeGreaterThan(5)` guard that could not fail.

### Changed

- **`CorpusHit.score` is now a comparable 0–1 number in the fused modes.** It carried four incomparable scales under one undocumented field: cosine for `semantic`, unbounded BM25 for `lexical`, and an RRF value whose ceiling is `2/61 = 0.0328` for `hybrid` — the DEFAULT mode. Meanwhile `corpus_min_evidence_score` was documented as "0–1" with a `.max(1)` bound, so an operator setting a natural floor of `0.1` silently dropped every corpus chunk and the brief then reported itself as thin. Fused scores are rescaled onto 0–1 using ceilings derived from the fuser's own constants, and every hit now carries `score_scale` and `mode`. Ranking and ties are unchanged — it is one positive constant per run.
- **`artifact_prune`'s filter is `pack`**, matching `artifact_list` / `artifact_read` / `artifact_diff` so an identity round-trips between them. The pre-2.10 `pack_type` (`incident` | `change` | `repo`) is still accepted as a deprecated alias: this is the only `destructiveHint: true` tool, and silently dropping an unrecognized filter would have widened a one-pack delete to all three.
- **`log_stats` moved per-tool percentiles under a nested `elapsed_ms: {p50, p95}`** so the summary row and each tool row read at the same key path.


### Changed

- **Prewarm no longer pins the model in VRAM forever.** The startup prewarm sent `keep_alive: -1`, so every MCP session that connected on a dev profile parked the Instant model (default `hermes3:8b`, ~6 GB with KV cache) in VRAM permanently — even sessions that never called a single tool — starving co-resident GPU work (training, rendering). Prewarm now uses a bounded `keep_alive: "10m"` (`PREWARM_KEEP_ALIVE`): the first-call warm window the feature was built for, after which Ollama's normal idle eviction (default 5m after the last real call) governs residency. Runtime tool calls never set `keep_alive`, so post-first-call behavior is unchanged.
- **Docs stop recommending `export OLLAMA_KEEP_ALIVE=-1` as default setup.** README + handbook now give bounded guidance with an explicit caveat: `-1` pins every touched model until the Ollama server restarts, and belongs only on a box dedicated to Ollama.

- **`zod` is pinned to an exact version (`4.5.4`, was `^4.3.6`).** The generated handbook tool pages are a build artifact of zod's `z.toJSONSchema` serializer, and the byte-identical drift gate runs in *both* the pinned-lockfile job (`npm ci`) and the `verify` matrix (which deliberately does `rm -f package-lock.json && npm install` for runner-platform lockfiles). Under a caret range those two resolve different zod versions, so no committed version of the generated pages can satisfy both: zod 4.5.x renders a nullable field as `"type": ["string","null"]` where 4.4.x emitted an `anyOf` pair — semantically identical, byte-different. That drifted `corpus-rerank.md` and failed all six `verify` jobs on any PR, regardless of its contents. Pinning the serializer exactly makes the artifact reproducible in every job, keeps the drift gate at full strength everywhere (rather than muting it in the floating job), and routes future zod bumps through a reviewed Dependabot PR that must regenerate the pages. Regenerated `corpus-rerank.md` accordingly.

### Added

- **`INTERN_PREWARM` off-switch.** `INTERN_PREWARM=off` (also `0|false|no|none`, case-insensitive) skips the startup prewarm entirely — pure load-on-demand for GPUs shared with training/rendering. Unset or truthy (`on|1|true|yes`) keeps the profile default; truthy cannot force prewarm onto a profile that declares none (m5-max). Unknown values fail fast at startup with `CONFIG_INVALID` (FT-002 rationale: a silently ignored knob is worse than a loud one).

## [2.9.1] — 2026-07-06

Patch — the v2.9.0 fast-follows: verify-lane observability, handbook coverage, and repo hygiene. No public tool contract changed; local-first behavior is byte-identical.

### Added

- **Juror `raw_sample` on `no_valid_verdicts` exclusions.** When a served juror's reply coerces to zero valid verdicts, the excluded `result.panel` seat now carries a bounded head-sample (≤200 chars, trimmed) of the raw reply — "returned prose / wrong schema / empty verdicts array" is diagnosable from the envelope alone (the v2.9.0 dogfood diagnosed exactly this panel-thinning only via a 4-call side probe). Never on included seats, never on other exclusion reasons, never the full reply (a juror reply echoes the caller's claims/evidence and must not bloat the envelope or the NDJSON log).
- **Handbook: all 44 tools now have reference pages (F7).** `scripts/gen-tool-docs.mjs` renders a Starlight page per registered tool from the two sources the server actually enforces — the `src/index.ts` registration (name/description/annotation title, parsed with an andon count-guard) and the exported zod schema via `z.toJSONSchema` (`.describe()` strings, defaults, enums, bounds — the same JSON schema `tools/list` advertises). The 6 hand-curated deep-dives are never touched; the Tool Reference's `TOOL_PAGES` marker block links all 44; an orphaned generated page (renamed/removed tool) fails the check. CI gates byte-identical regeneration in the lockfile-sync job — deliberately the one job installing against the committed lockfile, so the zod that renders the schemas is pinned — meaning a schema change without a docs regen fails before merge.

### Fixed

- **Dependabot alert count reconciled to reality.** All 12 open alerts sat on `site/package-lock.json`; the root package was already clean (0 alerts, `npm audit` 0 in both modes). `npm audit fix` in `site/` resolved the within-range set (vite `server.fs.deny` bypasses, launch-editor NTLMv2, devalue, js-yaml — auto-resolving on merge); the astro-7-major residuals target SSR/dev-server surfaces a statically prerendered GitHub Pages docs site does not run and are dismissed `tolerable_risk` with SECURITY.md item 14 as the documented reason. The astro-7 migration is tracked as its own follow-up.
- **The failing "CodeQL" umbrella check is off the PR checklist.** GitHub's default-setup CodeQL ran alongside the repo's advanced `codeql.yml` and failed on the config conflict on every PR — the noise that made both v2.8.0 and v2.9.0 read UNSTABLE while the required `Analyze (javascript)` passed. Default setup now reads `not-configured` (verified via the code-scanning API); the advanced workflow remains the real scanner.

## [2.9.0] — 2026-07-06

Minor — the **cloud feature pass** (dogfood swarm Phase 3, built + independently cross-family-verified across two courier-loop cycles). The strategic payload is a **cross-family verification lane** — `ollama_verify_claims` runs a disjoint-family Ollama Cloud flagship panel to adjudicate claims — powered by **per-call cloud escalation** (a new local-first *standby* mode: local-primary with zero egress until a single call opts in with `backend:'cloud'`). Rounded out with the "measured economics" rollup (`ollama_log_stats`), a CI-persona doctor, machine-readable tool annotations across the surface, and finished cloud onboarding. **Local-first defaults are unchanged — with no key set, behavior is byte-identical to v2.8.0** (zero egress, no startup cloud probe). No public tool contract was removed.

### Added

- **`ollama_log_stats` (F4)** — tool #44, the no-LLM rollup the "measured economics" tagline promises. Aggregates the NDJSON receipts (no model call, no egress): totals + per-tool/per-tier token sums, **cloud/local/degraded/unrouted split**, the cloud→local **`fallback_rate`** (degraded ÷ cloud-intended — the early-warning that cloud is degrading), tier timeout/fallback counts, and nearest-rank **p50/p95 `elapsed_ms`** overall and per tool, bounded by `since`. Tolerates a torn tail line; a call event with a malformed envelope still counts as a call but contributes 0 tokens (sums can never go NaN); empty/absent log returns zeros.
- **Cloud onboarding finished (F3).** `init --claude` prints a paste-ready Claude Code `.mcp.json` fragment (printed, never written — pasting beats clobbering an existing file) with the optional cloud env lines as commented guidance and the standby semantics spelled out; unknown `init`/`doctor` flags exit 1. CLI help documents standby and the doctor flags. The stale `minimax-m3:cloud` default claims are reconciled to the real `qwen3-coder-next:cloud` everywhere current-tensed (README env table + v2.7.0 note annotated, CLI help, handbook, landing copy); translations regenerate at release per the standing rule.
- **MCP tool annotations across all 44 registrations (F6).** Every `server.tool` now carries `{title, readOnlyHint, destructiveHint}` so MCP clients get machine-readable permission UX instead of prose prefixes. Classification is against actual behavior: 14 read-only tools (doctor, log_tail/log_stats, the corpus/artifact readers + snippet renderers, the deterministic code_map), exactly one destructive (`artifact_prune`), and everything model-calling or state-writing explicitly neither (both hints set explicitly — the MCP spec defaults `destructiveHint` to TRUE when omitted). `code_citation` is deliberately NOT read-only: it runs a Deep-tier model call. The golden test asserts the exact classification per tool, so a future tool registered without annotations fails by name.
- **Doctor grows its CI persona (F5).** `ollama-intern-mcp doctor --json` emits the structured `DoctorResult` (stdout is only the JSON — the old comment suggested piping the *prose* to jq, which never worked); `--fail-unhealthy` exits 1 when unhealthy, including when the cloud config itself fails to load. And `healthy` is now **cloud-aware**: a definitive cloud misconfiguration (401/403 probe, or the sticky `misconfigured` breaker) flips `healthy:false` — a bad key is broken operator config — while a cloud *outage* does not (local fallback serves; an outage isn't your config's fault). The no-flag prose report is byte-unchanged and still always exits 0.
- **Cloud STANDBY mode (F2a).** `OLLAMA_API_KEY` alone (without `OLLAMA_CLOUD_PRIMARY`) now arms standby: routing stays **local-primary with zero egress** — no startup cloud probe, no call leaves the machine — while the cloud client stands by for per-call escalation. Previously this env combination loaded nothing, making "local-first but escalate THIS call" inexpressible. `doctor` reports the mode (`Cloud (standby)` vs `Cloud (primary)`).
- **Per-call `backend` directive (F2b).** `ollama_chat` accepts `backend: "cloud" | "local"`; the runner threads the same directive for internal callers. `"cloud"` escalates a single call (the only cloud path in standby; a no-op under cloud-primary), `"local"` pins a single call local under cloud-primary. With no cloud configured, `backend: "cloud"` fails with the new **`CLOUD_NOT_CONFIGURED`** error code — never silently served local while claiming escalation. The **first** standby escalation prints a loud stderr disclosure and emits a `cloud_egress` NDJSON event: egress is disclosed at the point it happens.
- **`ollama_verify_claims` (F1)** — tool #43, the counterpart to `ollama_code_review`: review GENERATES findings, this ADJUDICATES claims. Runs a **cross-family Ollama Cloud flagship panel** (default `deepseek-v4-pro:cloud` / `kimi-k2.7-code:cloud` / `glm-5.2:cloud` — disjoint families, override via `panel`) over caller claims with optional `source_paths` evidence and a `reference` ground-truth block. Aggregation is **lone-dissent-never-decides**: REFUTED needs ≥`min_refute_votes` (default 2), CONFIRMED needs ≥2 confirms, else NEEDS_REVIEW. Every juror passes a **served-model check** (normalized `/[-:]cloud$/` both tag forms); a juror served by local fallback or a substituted model is excluded and flagged in `result.panel`, never counted. Claim inputs are `strict()` — there is structurally no field for the claim author's reasoning to ride into a juror prompt (reasoning-stripped verification). Cloud-required: refuses with `CLOUD_NOT_CONFIGURED` rather than substituting a too-weak local panel.

### Fixed

- **Fence-tolerant model-output parsing, surface-wide.** The live F1 jury exposed glm-5.2/kimi-k2.7 wrapping JSON in markdown fences under `format:"json"` (Ollama Cloud doesn't grammar-enforce every model); since F2 makes every runTool-driven parser cloud-reachable, the shared `parseModelJson`/`parseModelJsonObject` (briefs/common.ts) now backs all 14 model-output parse sites — the 8 `parseJsonObject` callers, verifyClaims (deduped), and the 6 bespoke parsers (`classify`, `extract`, `triage_logs`, `summarize_fast`/`deep`, `corpus_answer`), each keeping its own failure semantics byte-equivalent (direct parse first, first fenced block second, original error rethrown).
- **Per-call `model` override is honored on the cloud path.** Since v2.7.0, cloud-primary routing clobbered the v2.3.0 per-call override with the tier→cloud-model map — the caller's named model was silently substituted. The override now rides the cloud attempt verbatim (`model_requested` vs `model` on the envelope proves it), which per-juror panel selection depends on.
- **A per-call override's cloud 404 no longer arms the process-wide deterministic cooldown.** One caller's typo'd/retired model id used to suppress cloud for *every* call for 60s; now it releases the breaker probe only (the tier-default 404 cooldown is unchanged).
- **Standby never inflates local budgets.** The cloud+local budget summing in runner/chat/batch/corpus-search explain applies only when cloud may actually serve the call (`cloudMayServe`), so a standby key doesn't triple local tier ceilings.
- **`ollama_log_stats` no longer crashes if the log is rotated mid-read.** The read-only stats call checked `existsSync` then `readFile`; a log deleted in that non-atomic window raised `LOG_READ_FAILED` instead of the soft-empty zeros the tool otherwise returns for an absent log. An `ENOENT` on the read path is now treated as "no log yet" (the same discipline the corpus refresh and doctor's error-tail reader already use); only a genuine read failure (permissions/I-O) is raised.

### Changed

- Routing provenance (`envelope.model` on cloud-served calls) now carries the backend's **served-model echo** rather than the requested id — live cloud strips the tag suffix, and any further divergence is exactly the substitution signal verify-claims and receipt-backed callers need.

## [2.8.0] — 2026-07-06

Minor — a **reliability, durability, and security hardening pass** (dogfood swarm: 25 findings, every fix landed test-first with a regression test proving the invariant, then independently cross-family-verified). Local-first behavior is unchanged and **no public tool contract was removed** — existing callers keep working. The headline fixes close two silent-data-loss / correctness classes and a security-doc overclaim; the rest harden concurrency, cloud resilience, and observability honesty.

### Security

- **`ollama_batch_proof_check` now really contains the process-execution surface it claimed to.** A custom `cwd` must be contained in a caller-declared `allowed_roots` (validated before any child spawns), `allowed_roots` are schema-enforced absolute, and the exact absolute path validated is the one passed to spawn. A new **operator env cap `INTERN_BATCH_PROOF_ALLOWED_ROOTS`** bounds the exec surface that a caller cannot widen — and it gates the default `process.cwd()` too, not just a caller-supplied cwd. SECURITY.md #8/#10 were reconciled to describe what the code actually does (the previous text over-claimed a containment that did not exist).
- **Prompt-injection sanitizer coverage + honest ceiling.** The `triage_logs` pattern sanitizer gained the regression tests it lacked; `classify` and `research` now strip the same structural-injection vectors (code fences, CR/LF, over-length) from user-supplied prompt fields before any model call; `classify` additionally output-shape-gates its reply against the label menu (an off-list label now abstains instead of being echoed). SECURITY.md documents the ceiling honestly: the guard stops *structural* injection, not *plaintext* social-engineering of the local model.
- **Protected-path write guard is case-insensitive on macOS too** (was Windows-only), so a cased path like `Memory/notes.md` can no longer bypass the `memory/` / `canon/` / `.claude/` confirm-write gate on a case-insensitive volume. Linux stays case-sensitive.
- **Dependency audit surface is fully clear (0 vulnerabilities).** The transitive alerts (via `@modelcontextprotocol/sdk`) were pinned to patched in-range versions with npm `overrides` — no major bumps. The vulnerable paths were HTTP-middleware unreachable from a stdio server, but the surface is cleared regardless.

### Fixed

- **Corpus refresh no longer deletes indexed content on a transient read error.** Previously *any* failure to read a manifest path during `ollama_corpus_refresh` (a Windows file lock, an antivirus hold, an editor's atomic-save window) was classified "missing" and the path — and its chunks — were **permanently deleted** from the corpus and manifest. Now only a genuinely-absent file (ENOENT) is deleted; a transient read error keeps the path, records it for `retry_failed`, and carries its existing chunks forward. **This closes a silent, durable data-loss class.**
- **Tier timeouts can now cancel a call still queued for a concurrency permit.** A tier-budget timeout that fired while a call was waiting on the internal semaphore couldn't dequeue it — the call hung far past its advertised budget (up to a full deep-tier drain) while receipts reported the timeout fired on schedule. The semaphore wait is now abort-aware, and a timed-out waiter no longer consumes a permit.
- **`ollama_chat` routes through the timeout/tier seam.** It previously bypassed routing entirely: never reached cloud in cloud-primary mode, carried no backend provenance, and had no application timeout despite its schema claiming one — a single wedged local generation could stall every tool. It now passes a tier-bounded abort signal + tier (the same fix applied to the `corpus_search` explain sub-calls and the embedding rail).
- **Cloud resilience:** a cloud-model `404` (a retired/typo'd model id) now falls back to local with a distinct `cloud_model_missing` degrade reason and a cloud-specific hint (never "run `ollama pull`") instead of a total outage; the circuit breaker can no longer wedge permanently in half-open on a deterministic probe failure; a persistently-retired model enters a short auto-expiring cooldown instead of paying a cloud round-trip on every call; and a per-call `tier_budget_ms_override` in cloud mode no longer starves the local fallback or trips the breaker from operator config.
- **Pack artifacts are written atomically and never silently clobber.** Same-minute same-title runs (a retry after a timed-out response) reserve a unique slug atomically instead of check-then-act, the `.md`/`.json` pair is written atomically with the `.json` as the commit marker, and the reservation is reserve-or-throw (never returns an unclaimed slug even in the pathological corner).
- **Corpus integrity:** the interrupted-write detector now catches a torn write on *any* mutation (not just the first index) via a two-phase `completed_at` marker, with a v1-migration sentinel that stops a false-positive warning on legacy manifests; chunk IDs fold in a path digest so two different files with identical content no longer collide and shadow each other in search; a re-index with changed chunk parameters actually re-chunks unchanged files instead of stamping new geometry over old chunking; and `ollama_artifact_prune` only deletes files that parse as real pack artifacts (a hand-parked JSON/MD pair in the artifact dir now survives).
- **`loadSources` caps file size before reading** (mirroring the indexer's 50 MB cap) with a distinct `SOURCE_FILE_TOO_LARGE` error, instead of buffering a multi-hundred-MB log into memory and surfacing a misleading "path not found."
- **Model-name validation no longer rejects legitimate bare version ids** like `glm-5` at startup.

### Changed

- **Degraded batch envelopes report the tier actually used.** A batch that fell back (e.g. workhorse→instant) previously reported `tier_used` equal to `fallback_from` while `model` named the fallback tier — a self-contradictory receipt that mislabeled quality attribution. `tier_used` now names a tier actually used to serve the items.
- **`corpus_index` / `corpus_amend` re-enforce their cross-field validation** (`chunk_overlap < chunk_chars`) in the handler — the top-level `.refine()` was silently dropped by the transport-layer registration, so an invalid geometry was accepted and recorded into the persistent manifest.

### Docs & CI

- The GHCR docker image is no longer pushed unless the npm verify + tag-vs-`package.json` guard passed for the same commit (the docker job was previously ungated); a CI job now exercises the committed lockfile with `npm ci` (it was regenerated on every prior CI leg, so a lockfile desync went green in CI and red only at tag time); and the release workflow's `needs`-gate is now itself lint-tested.
- Test-suite honesty: the malformed-args golden test proves input-schema validation actually ran (not just that the handler errored later), the fsync-before-rename durability contract is a runtime observation rather than a source grep, and the degraded-batch model assertion is non-vacuous.
- The tool count (42) was corrected everywhere it drifted to 41, `ollama_code_review` gained its handbook page, and the ROADMAP's stale "Now" section was refreshed.

## [2.7.2] — 2026-06-09

Patch — CodeQL alert cleanup. No API or behavior changes. Hardens the lone remaining HIGH alert (a polynomial-ReDoS regex) and sweeps the 14 outstanding `js/unused-local-variable` quality alerts, leaving the code-scanning surface fully clear (0 open alerts of any severity).

### Security

- **CodeQL `js/polynomial-redos` (1 HIGH) — hardened.** `normalizeOllamaHost` (`src/ollama.ts`) trimmed trailing slashes with `withScheme.replace(/\/+$/, "")` — the unbounded `+` anchored to the end is the canonical super-linear-backtracking shape CodeQL flags. Replaced with a linear-time `while (trimmed.endsWith("/")) trimmed = trimmed.slice(0, -1)` loop; behavior is identical (all trailing slashes stripped, `"http://h///"` → `"http://h"`). `OLLAMA_HOST` is operator-set, not attacker- or HTTP-derived, so the ReDoS was never reachable by an adversary — but hardening removes the alert outright rather than carrying a dismissed false-positive. Adds a 100k-trailing-slash regression test that would have hung the old regex.

### Changed

- **14 `js/unused-local-variable` CodeQL alerts swept** — dead imports and unused local bindings removed across `src/` (`chunker` `closeStart`, `ollama` `op`, `corpusAnswer` `resolveNumCtx`) and 11 across the test suite. Pure dead-code removal with no behavior change; the two unused *result* bindings (`r1` in `indexerSearcher.test.ts`, `env` in `repoPack.test.ts`) kept their side-effecting `await` calls. Combined with the ReDoS fix above, the repository's code-scanning surface is fully clear.

## [2.7.1] — 2026-06-09

Patch — security hardening from CodeQL triage. No API or behavior changes: the `overwrote` contract and all error codes are preserved, and callers see identical behavior. Closes 4 HIGH `js/file-system-race` alerts, wires a previously-dead manifest downgrade guard (2 unused-symbol alerts), and dismisses 1 MEDIUM `js/http-to-file-access` false positive.

### Security

- **CodeQL `js/file-system-race` (TOCTOU) — 4 HIGH alerts hardened.** Removed check-then-use filesystem patterns flagged by CodeQL on `main`:
  - `src/sources.ts` and `src/corpus/indexer.ts` now open a single file handle and run the is-file / size-cap check, the read, and the mutation re-check against that one inode. A path swapped between a `stat()` and a path-based `readFile()` can no longer slip a different (or oversized) file through — in the indexer this also closes the OOM-via-swap window where the 50 MB cap could be bypassed.
  - `src/tools/artifacts/export.ts` writes atomically with the exclusive-create flag (`wx`) instead of `existsSync`-then-`writeFile`. The flag *is* the existence check, so the "never clobber by default" guarantee holds against a racing writer; directory diagnosis runs only after a failed write (never before).
  - `scripts/sync-doc-versions.mjs` reads directly with `ENOENT` handling instead of `existsSync`-then-read.
  - Error codes/messages and the `overwrote` contract are unchanged; full suite (1005 tests) green, typecheck clean.
- **CodeQL `js/http-to-file-access` (1 MEDIUM) — dismissed as a false positive.** The NDJSON logger's write path is operator config (`DEFAULT_LOG_PATH` / `INTERN_LOG_PATH`), never HTTP-derived, so there is no path-injection sink. HTTP-derived data reaches only the log *content*, which is `JSON.stringify`-escaped into one NDJSON line (no log-line injection). The log is data, never executed.

### Fixed

- **corpus/manifest: writer-version downgrade guard was declared but never wired.** The v2.0.1 changelog claimed the manifest loader refused a newer-than-build manifest, and `manifest.ts` carried `MANIFEST_WRITER_VERSION` + a `compareVersions` helper + a doc comment promising the behavior — but nothing referenced them, so the guard never ran (and CodeQL flagged both symbols as unused). `loadManifest` now rejects a manifest whose `schema_version_written_by` is newer than the running build, and `saveManifest` stamps that field on every write — reaching parity with the corpus-side guard in `storage.ts` (`loadCorpus` / `saveCorpus`). Legacy manifests with no writer field, and manifests written by an older build, still load.

## [2.7.0] — 2026-06-09

Minor — non-breaking, opt-in **Ollama Cloud routing** (cloud-primary, local-fallback). The package stays local-first with **zero network egress by default**; cloud is off unless BOTH `OLLAMA_CLOUD_PRIMARY` and `OLLAMA_API_KEY` are set. Anyone not opting in sees byte-identical behavior.

### Added

- **`RoutingOllamaClient`** (`src/routing.ts`) wraps a cloud `HttpOllamaClient` (Bearer auth, `https://ollama.com`) and the existing local client behind the same `OllamaClient` interface, so all tools inherit cloud routing through the single `ctx.client` seam. Cloud serves the generative tiers (instant/workhorse/deep); **embeddings always stay local** (Ollama Cloud serves no embedding models).
- **Hand-rolled circuit breaker** (no new dependency): CLOSED → OPEN after 3 consecutive trip-worthy failures (timeout / 5xx / 429 / network) → 20s cooldown → single HALF-OPEN probe → CLOSED. A bad key (401/403) trips a **separate sticky `misconfigured` state** that does not auto-recover — surfaced loudly rather than degrading silently. A retired/typo'd cloud model id (404) rethrows instead of silently serving a different local model.
- **Cloud config** via `loadCloudConfig(env)` (`src/profiles.ts`) — fail-fast `CONFIG_INVALID` at startup if `OLLAMA_CLOUD_PRIMARY` is enabled without `OLLAMA_API_KEY`. New env: `OLLAMA_CLOUD_PRIMARY`, `OLLAMA_API_KEY`, `OLLAMA_CLOUD_HOST` (default `https://ollama.com`), `INTERN_CLOUD_MODEL` (default `minimax-m3:cloud`), `INTERN_CLOUD_DEEP_MODEL`, `INTERN_CLOUD_TIMEOUT_{INSTANT,WORKHORSE,DEEP}_MS`, `INTERN_CLOUD_NUM_CTX` (default 32768).
- **Envelope provenance** — new optional fields `backend` (`"cloud"`|`"local"`), `degraded`, `degrade_reason`. Absent in the default local-only path (additive, "absent when unset" — same pattern as `num_ctx_used`). `residency` is `null` for cloud-served calls.
- **`backend_fallback` NDJSON event** on every cloud→local fallback, filterable via `ollama_log_tail --filter_kind backend_fallback` (surfaces fallback *rate*, the early-warning that cloud is degrading).
- **`ollama_doctor` cloud block** — `{enabled, host, reachable, auth_ok, models, circuit_state}`; `ollama-intern-mcp doctor` renders a `Cloud (primary)` section. Cloud auth/reachability probed via `/api/tags` with the Bearer key.

### Changed

- The runner now threads `tier` into `ctx.client.generate(req, signal, tier)` (required for cloud-vs-local model resolution; also fixes pre-existing `semaphore:wait` events that logged `tier: 'unknown'`).
- When cloud is enabled, the per-tier outer timeout budget is the sum of the cloud-attempt and local-fallback budgets so a cloud→local fallback completes within one tier attempt (no premature tier-degradation, no 6-timeout stacking).
- Cloud requests use `INTERN_CLOUD_NUM_CTX` (default 32768), not the local VRAM-driven `num_ctx`, so the big model's context window isn't crippled by a local profile's small value.

### Hard invariants preserved

- **Zero egress by default.** With cloud unset, `ctx.client` is the plain local `HttpOllamaClient` and behavior is byte-identical to v2.6.0. A Bearer key is never sent to a loopback host.
- Embeddings/corpus tools never route to cloud.
- The README's headline reframes from "No cloud" to **local-first**; the threat model gains §11 (opt-in cloud egress) so shipcheck Hard Gate A still passes.

### Tests / verify

- 1001 vitest passing (+ new `tests/cloudClient.test.ts`, `tests/routing.test.ts`, `tests/cloudConfig.test.ts`, `tests/routingIntegration.test.ts`, `tests/doctorCloud.test.ts`). Typecheck + build clean.
- Routing/breaker/fallback unit-tested network-free via the injected fake-client seam.

## [2.6.0] — 2026-05-17

Minor — non-breaking server-side feature for the v0.13 cross-repo finalization arc. Adds a per-call tier-budget override on `ollama_extract` so research-os (and any other MCP client) can authoritatively set the inner tier-budget that drives `TIER_TIMEOUT` events at the live guardrail layer. Pre-R-019 callers see byte-identical behavior (field is optional and omitted = profile defaults govern).

### Added

- **`tier_budget_ms_override?: number` schema field on `ollama_extract`.** Optional, bounded `[1, 600000]` ms. When present, the runner builds an `effectiveTimeouts` record (override applied to every tier visited; cascade still honored) and passes it as `timeoutOverrideMs` into the existing `runWithTimeoutAndFallback` machinery at `guardrails/timeouts.ts:61`. The per-tier override slot already existed; v2.6.0 adds the MCP-client entry point to populate it. Handler threads via `RunToolInput.tierBudgetMsOverride` and `RunBatchInput.tierBudgetMsOverride` for items-mode batches.

### Why this matters

The R-018 wrapper that shipped in research-os v0.12.1 wrapped the MCP `callTool` with `Promise.race`. The v0.4 rerun's MISTARGETED-PATCH finding showed the wrapper's effective budget did NOT reach the inner mechanism — `DEV_RTX5080_TIMEOUTS.instant = 15_000` in `src/profiles.ts` continued to fire `TIER_TIMEOUT` at 15000ms regardless of the wrapper's 180000ms budget. v2.6.0's schema field is the MCP-side authoritative budget surface: when research-os passes a `tier_budget_ms_override`, the value reaches the inner mechanism directly, and the operator's `--planner-timeout-ms` flag (or `RESEARCH_OS_SYNTH_PLANNER_TIMEOUT_MS` env var) finally controls inner-tier timeouts as designed.

### Hard invariants preserved

- Default behavior preserved when the field is omitted. Pre-R-019 callers (any research-os version below 0.13.0; any other MCP client; any direct `ollama_extract` caller that doesn't set the field) see profile defaults govern byte-identically.
- The existing `guardrails/timeouts.ts` per-tier override slot at line 61 is UNCHANGED. The plumbing was already there; v2.6.0 supplies the client-side entry point.
- The cascade (workhorse → instant on timeout) honors the override on every tier visited; `effectiveTimeouts` applies the override uniformly.
- R-010 fallback-cause regex (`/elapsed=(\d+)ms/`, `/budget=(\d+)ms/`) preserved on the server-side `TIER_TIMEOUT` shape.

### Tests / verify

- 958 → 968 vitest passing (+10 R-019.SERVER tests at `tests/tools/r019TierBudgetOverride.test.ts`). 77 → 78 test files.
- Typecheck clean.
- Behavior verified live against the v0.4 rerun pack via research-os R-019 client (separate research-os release; arrives as v0.13.0 in the same release window).

### Notes

- Non-breaking minor: the new schema field is optional with a documented default; backward-compatible.
- Consumed by research-os v0.13.0 (cumulative R-019 client wire-up + R-020 + R-021); coordinated multi-repo release per `memory/multi-repo-publish-sequencing.md`.

## [2.5.3] — 2026-05-16

Patch — finishes the macOS realpath story. v2.5.1 realpath'd allowedRoots. v2.5.2 realpath'd the assertSafePath input. Both fail when the input file doesn't exist (synthetic-path amends — a documented use case where the path is recorded in the manifest before the operator creates the file). v2.5.3 fixes this by expanding allowedRoots to return BOTH the literal-normalized form AND the realpath form. Input check passes if it matches either side — no longer requires input.realpath to succeed.

### Fixed

- **`src/corpus/manifest.ts:allowedRoots()` returns both literal + realpath forms.** On macOS, `/var/folders/...` and `/private/var/folders/...` are the same directory through the system symlink. With both forms in the allowed-roots set, an input path in either form matches without requiring the input itself to exist on disk. Closes the corpusAmend macOS failure where synthetic-path tests pass an `INTERN_CORPUS_ALLOWED_ROOTS = /var/folders/...` but `corpusAmend` is called with a path whose file isn't on disk (`realpathSync` throws ENOENT → falls back to literal → doesn't match the realpath'd root from v2.5.1).

### Notes

- Local 958/959 passing. Coverage thresholds unchanged.

## [2.5.2] — 2026-05-16

Patch — completes the v2.5.1 macOS fix. v2.5.1 made `allowedRoots()` realpath each entry, but the INPUT path passed to `assertSafePath()` was still un-realpath'd by `corpusAmend.ts` (and any other caller that doesn't go through the indexer's `realpath → assertSafePath` pipeline). On macOS that left `/var/folders/...` (input) vs `/private/var/folders/...` (root) asymmetric — paths were still rejected as outside-roots. This patch realpaths inside `assertSafePath` itself so both sides match, with an OR-fallback to the normalized form so non-existent paths still validate against the literal allowed-roots string (preserves the historical pre-realpath behavior for the indexer's "file recorded in manifest but no longer on disk" case).

Also fixes the Doc Drift workflow to `npm run build` before `npm test` — without it, tests that spawn `dist/index.js` (cli, mcpGolden, mcp.integration, pack) error at `beforeAll`, making the parseable pass count artificially low and exit code 1.

### Fixed

- **`src/corpus/manifest.ts:assertSafePath` realpaths the input path before comparison.** Symmetric with v2.5.1's `allowedRoots()` realpath. Now `corpusAmend` (and any future caller that doesn't pre-realpath) compares apples-to-apples. Fallback: if `realpathSync` fails (file doesn't exist yet), use the normalized form — both candidates are tried so any path that passed pre-v2.5.1 still passes.
- **`.github/workflows/doc-drift.yml`** adds `npm run build` between install and test.

### Notes

- Tests, typecheck, build, coverage thresholds unchanged. Local Windows run: 958/959 passing.

## [2.5.1] — 2026-05-16

Patch — closes three cross-platform CI matrix failures the v2.5.0 multi-OS strategy surfaced on first invocation. No API or behavior changes. The release-spine doing exactly what it was built to do: catching real platform-sensitive code that had been sitting in the repo behind the Linux-only gate.

### Fixed

- **`tests/errorHintQuality.test.ts` Node 20 compatibility.** Test used `fs.globSync` which is a Node 22+ API; Node 20 doesn't have it (`TypeError: globSync is not a function`). Replaced with a small hand-rolled `walkTsFilesSync` (recursive `readdirSync` with `withFileTypes`). Skips `.dot` dirs + `node_modules`. No new dep. `engines.node: ">=20.0.0"` honored.
- **`src/corpus/manifest.ts` macOS realpath consistency.** `allowedRoots()` returned entries as-is, while the indexer calls `realpath(path)` before checking them. On macOS, `realpath('/var/folders/...')` resolves to `/private/var/folders/...` (the canonical symlink target). An allowed root configured as `/var/folders/...` was therefore rejected as outside-roots even though it pointed at the same directory. `allowedRoots()` now calls `realpathSync` on each entry (fall through to `normalize` if the path doesn't exist yet). Tests on macOS that set `INTERN_CORPUS_ALLOWED_ROOTS = tmpdir()` now produce paths consistent with `realpath(file)` from inside the indexer.
- **`tests/corpus/indexerSearcher.test.ts` Windows skip widened.** The TOCTOU-style "outside allowed roots" test had a dynamic skip (`if (tmpdir().startsWith(homedir())) return`) intended to catch the local-dev case where Windows tmpdir is under the user profile. On GitHub Actions Windows runners, tmpdir is on `D:\a\_temp` and homedir is on `the runner user profile on C:` (different drive), so the dynamic skip didn't fire but the test setup couldn't produce a reliable "outside" path either. Skip is now `process.platform === 'win32'` unconditionally; `assertSafePath` has its own direct unit tests covering the rejection path, this integration test exists to verify the indexer's `realpath → assertSafePath` wiring on POSIX where the topology is controllable.

### Notes

- Tests, typecheck, build, coverage thresholds unchanged. Local Windows run: 958/959 passing, 1 todo. Coverage holds at 86.52% statements / 88.94% lines.
- v2.5.0 npm package + GitHub release are unaffected — the publish workflow gated on `ubuntu × 22` which passed; this patch only restores green CI across the multi-OS verify matrix that v2.5.0 introduced.

## [2.5.0] — 2026-05-15

Health hardening, proactive defenses, humanization of error/observability surfaces, and 10 user-facing feature additions from a 10-phase dogfood swarm. The 41-tool surface gains `ollama_code_review` (42 total). Correlation IDs now propagate across every NDJSON event so an operator can join `pack_step` to its originating `tools/call` envelope. A breaking behavior change in the confidence guardrail default (now fail-closed) is the reason for the minor bump's prominence — see **Changed** below.

### Added

- **`ollama_code_review` atom tool.** Structured PR review: takes a unified diff (`diff_text`, 2MB cap) + optional source paths (max 50), returns `{findings:[{severity, category, file, line?, symbol?, description, recommendation}], summary, diff_size_bytes}`. Severity `critical|high|medium|low`, category `bug|security|performance|style|maintainability`. `severity_floor` and `max_findings` filters. Tier defaults to workhorse; `tier:'deep'` for high-stakes. `coerceReview` drops malformed entries instead of throwing — same pattern as `coerceOnboardingFacts` in packs. Distinct from `ollama_multi_file_refactor_propose` (which proposes refactors): code_review flags issues to fix in the diff as-is.
- **Correlation IDs across the stack.** Every NDJSON event now carries `{run_id, call_id?, parent_call_id?, op, ...}` where `run_id` is minted in `runner.ts` at every tool entry, `call_id` is per-HTTP-attempt, and `parent_call_id` lets pack sub-step events link back to the originating tool call. `op` enum is closed (`chat|embeddings|pack_step|semaphore_wait|guardrail|shutdown|startup`), borrows OTel `gen_ai.operation.name` vocab. Propagation uses Node's `AsyncLocalStorage` — no parameter threading required for the read side. Tool envelopes echo `run_id` for client-side correlation. Design grounded by a study-swarm (W3C TraceContext / OTel GenAI / MCP progressToken trade-offs; see commit messages for sources).
- **CLI surface.** `npx ollama-intern-mcp [--version|-V|--help|-h|doctor|init]`. Doctor reuses the `ollama_doctor` tool with NullLogger and renders a human-readable report (Profile / Tiers / Ollama / Models / Healthy). Init scaffolds `hermes.config.yaml` in cwd, refuses to overwrite. No new dependencies.
- **Profile validation fail-fast.** `INTERN_TIER_<TIER>` env values are validated at `loadProfile()` against `^[a-z0-9._-]+(:[a-z0-9._-]+)?$` for model names and `[256, 1048576]` for `num_ctx`. Catches the `hermes3-8b` (dash instead of colon) typo at load time with a "Did you mean hermes3:8b?" hint instead of failing as `OLLAMA_MODEL_MISSING` hours later.
- **Vitest coverage configuration.** `npm run test:coverage` (v8 provider, 4 reporters incl. lcov + json-summary, thresholds 70/70/60/70 lines/functions/branches/statements). Current suite reports 86.52% statements / 88.94% lines / 73.96% branches / 86.80% functions.
- **E2E MCP integration test suite.** `tests/integration/mcp.integration.test.ts` spawns `dist/index.js` as a subprocess and exercises the wire JSON-RPC: handshake, tools/list, tool call, error path, SIGTERM shutdown. Skipped under `SKIP_MCP_GOLDEN=1`.
- **Shared test helpers.** `tests/_helpers/{fakeOllama,fixtures,index}.ts` — `createFakeOllama({generateImpl, chatImpl, embedImpl, ...})` factory and `makeFakeCtx({client, profile, ...})` RunContext builder. Migrates 4 test files to demonstrate the pattern; future migrations remove the 43-file hand-rolled-mock surface incrementally.
- **6 new guardrail event helpers.** `buildBannedPhraseEvent`, `buildWriteConfirmEvent` (closes Stage B `rules_version` omission), `buildCompileCheckEvent` (was emitting no event), `buildStringifiedArrayEvent` (stderr-only previously), `buildAtomicWriteOrphanEvent`, `buildCorpusRefreshStepEvent` / `buildCorpusIndexStepEvent` / `buildCorpusLockWaitEvent`. All tagged with the new `op` enum.
- **SIGTERM / SIGINT handlers in MCP server.** Graceful shutdown emits a structured `op:'shutdown'` event with signal name + lock state, drains the NDJSON queue, closes the MCP transport, then exits 0. Re-entrancy guard for double-Ctrl-C.
- **Ollama unreachable diagnostics.** `OLLAMA_UNREACHABLE` errors now carry the response Content-Type + status + first 200 chars of the body + a `curl <host>/api/tags` reproduction hint, so an operator can distinguish "Ollama down" from "captive portal in front of OLLAMA_HOST" without leaving the terminal.
- **50MB payload size cap on Ollama calls.** Pre-`JSON.stringify` size check on `prompt + input + messages`. Refuses with `SCHEMA_INVALID` naming the largest field's byte count, so the operator sees WHICH input is bloated before the process OOMs at serialization.
- **POSIX parent-dir fsync in `atomicWriteFile`.** Closes the durability half-truth from v2.4.0 — file is atomic, but the rename's effect on the dir entry needs `fsync(parent_dir)` to survive a crash. Windows no-op.
- **`.tmp` cleanup on writeFile/fsync failure in `atomicWriteFile`.** v2.4.0 only handled rename-failure cleanup; ENOSPC during write or fsync now also cleans up. Optional `onOrphan` callback for operator-grep'able orphan events.
- **Tag-push auto-release CI workflow.** `push: tags: v*.*.*` trigger added to `publish.yml` alongside the existing `release:published` trigger. Tag-vs-package.json version verify gate runs BEFORE publish. Provenance + NPM_TOKEN preserved. Auto-create GH release with CHANGELOG section extraction.
- **CodeQL workflow** (`.github/workflows/codeql.yml`) — javascript pack covers TypeScript, push / PR / weekly schedule, security-and-quality query suite.
- **Dependency-review action** (`.github/workflows/dependency-review.yml`) — PR-only, fail-on-severity moderate+, license allowlist `[MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0]`.
- **OS matrix in CI** — `verify` job now runs on `{ubuntu, windows, macos} × {node 20, 22}` with `fail-fast: false`. Stage A audit found 3 Windows-specific bugs; CI now catches the next one.
- **Quickstart tutorial** at `site/src/content/docs/handbook/quickstart.md` — 6-step "first 5 minutes": Ollama check → Claude wiring → ollama_doctor → corpus_index → corpus_answer → incident_pack on disk.
- **5 per-tool reference pages** at `site/src/content/docs/handbook/tools/{doctor,classify,extract,corpus-answer,chat}.md` — consistent template (job, tier, when-to-use/NOT, schema, examples, pitfalls, related).
- **Mermaid architecture diagram** in README.md + handbook/index.md.
- **scripts/sync-doc-versions.mjs** — propagates version + tool count + test count from package.json + src/index.ts + npm test output into HTML-comment-marked spans across README/HANDOFF/CONTRIBUTING/SHIP_GATE/site-config. Idempotent. `--check` mode for CI gating.
- **.github/workflows/doc-drift.yml** — CI guard for CHANGELOG-vs-version drift + Released:TBD detection + README/HANDOFF/SHIP_GATE test-count drift.
- **3 new test files** (Stage C): `tests/observability.test.ts` (14), `tests/corpus/lock.test.ts` (10), `tests/corpus/atomicWrite.test.ts` (15). Plus `tests/tools/runner.test.ts` (22), `tests/runContext.test.ts` (13), `tests/cli.test.ts` (9), `tests/tools/codeReview.test.ts` (10) from Phase 7.
- **`.gitattributes`** pins LF for source/docs (stops CRLF warnings on Windows).
- **Issue + PR templates** at `.github/ISSUE_TEMPLATE/` and `pull_request_template.md`.

### Changed

- **BREAKING (behavior, not API): `applyConfidenceThreshold` defaults to fail-closed.** Previously `belowThreshold && opts.allow_none ? null : raw.label` returned the weak label by default. Now `allow_none ?? true` flips the default — callers that want the weak-label propagation must opt in via `allow_none: false`. Every sibling guardrail in `src/guardrails/` is fail-closed; this aligns confidence with the rest. Operators calling the guardrail directly with the default options will see different return values for `below_threshold` cases. The fix surface is small (most callers don't override `allow_none`); the test suite catches the few that do. Reason: defense-in-depth — guardrail defaults should be conservative.
- **Citation strip events carry per-strip detail.** `validateCitations` now logs `{path, reason}` per stripped citation via the new `buildCitationStripEventDetails` helper, replacing the previous `{count}`-only summary. Wired into `src/tools/research.ts`.
- **Confidence strip events carry raw label/confidence/threshold.** `src/tools/classify.ts` emits the structured event via `buildConfidenceStripEvent` instead of an inline summary.
- **`semaphore:wait` events carry the actual tier.** Previously hardcoded `tier:'unknown'` because the HTTP layer didn't know which tier originated the call. The `Tier` is now an optional parameter on `OllamaClient.generate/chat/embed`.
- **Brief-parser null-entry handling unified.** New `readObjectArray` helper in `src/tools/briefs/common.ts` filters non-object entries (null, numbers, strings, nested arrays) before the loop. Applied to all 11 brief-parser call sites across `incidentBrief`, `repoBrief`, `changeBrief`, `codeCitation`, `refactorPlan`, `multiFileRefactorPropose`. Closes the silent-crash window when the model returned `[null, {...}]`.
- **`classify.ts` null-narrowing.** Same-family bug as the brief parsers — `JSON.parse('null')` returns `null`; `obj.label` throws. Now uses the standard narrowing pattern + emits a structured `classify_abstain` event with reason enum (`parse_error|non_object|missing_label`) plus a raw preview.
- **`triageLogs.ts` null-narrowing.** Same fix as classify, found by sweep.
- **Pack write-failure UX restructured.** `incidentPack`, `changePack`, `repoPack` now set `result.artifact.markdown_path/json_path` to `null` on write failure (previously claimed nonexistent paths). Envelope surfaces a coherent warning with the failed path + partial-data location + fix hint.
- **Atomic-write helper extracted.** `src/corpus/atomicWrite.ts` consolidates the tmp+fsync+rename pattern previously inline in `saveCorpus`; `saveManifest` now uses it too — closes the durability half-truth where the corpus was crash-safe but the manifest wasn't.
- **Chunker char offsets preserve CRLF bytes.** `src/corpus/chunker.ts` now returns `char_start`/`char_end` that satisfy `text.slice(char_start, char_end) === chunk.text` byte-for-byte even on CRLF input. EOF off-by-one clamped.
- **Pack baseline (`tests/pack.test.ts`)** bumped 385000 → 470000 to reflect new tools + ALS modules + 13 v2.1.0 atoms now enumerated.
- **HANDOFF / SHIP_GATE / CONTRIBUTING / README / handbook** all caught up to v2.5.0 + 42 tools via `scripts/sync-doc-versions.mjs`.

### Fixed

- **CRITICAL: Shell injection on Windows in `batchProofCheck.ts`.** `spawn(..., {shell: process.platform === 'win32'})` combined with caller-controlled `input.files[]` paths embedded into argv was a real RCE. cmd.exe expands `& | ; ^ " > <` etc. inside arguments. New `assertSafeFilePath` validator rejects shell metacharacters before spawn. Legitimate paths with spaces, dots, parens, hyphens pass through.
- **CRITICAL: regression-guard test correctness (`tests/regressions.test.ts:176`).** The raw-vector leak guard was using `expect.not.arrayContaining(["embedding", "vector"])` which passes when EITHER key is absent. Replaced with explicit per-key `not.toContain` checks (BOTH-absent invariant). The original bug (raw vectors blowing past Claude's 115KB tool-output limit) would now be caught.
- **CRITICAL: startupProbe sentinel test (`tests/startupProbe.test.ts:74`).** Was `expect("1").toBe("1")` — a tautology asserting a local constant against itself. Now uses a source-grep regex against `src/index.ts` to lock the actual `"1"` comparison shape; would catch drift in the env-var sentinel.
- **HIGH: `protectedPaths.normalizePath` case-bypass on Windows.** JSDoc claimed "lowercase on win32" but the body didn't. `Memory/foo.md` / `MEMORY/foo.md` evaded the `memory/` protected-path rule. Now lowercases on `process.platform === 'win32'` as documented; also flows through `validateCitations` to fix the citation-allowlist case bypass.
- **HIGH: `codeMap.walkPaths` symlink traversal.** Now skips symlinks/junctions by default in the BFS walker (Windows junctions too). Closes the exfil window where a symlink to `/etc` or `~/.ssh` would be enumerated.
- **HIGH: `repoPack` / `changePack` cast safety.** `extractResult.data` was cast to `OnboardingFacts` / `ChangeFacts` without runtime validation; model could return `package_names: "string-not-array"` which crashed at render time. New `coerceOnboardingFacts` / `coerceChangeFacts` validators sanitize each field, drop bad entries, never throw.
- **HIGH: 6 brief-parser null-entry crashes** — see **Changed** above (consolidated via `readObjectArray`).
- **HIGH: classify + triageLogs null-crash** — see **Changed** above.
- **HIGH: `saveManifest` non-atomic write.** Mirrored `saveCorpus`'s tmp+fsync+rename pattern via the shared `atomicWrite.ts` helper; `loadManifest(...).catch(() => null)` no longer silently masks a torn-write.
- **HIGH: 3 timeout-test guard patterns** in `tests/timeoutLogEnrichment.test.ts` were silently skipping assertions if the `kind` discriminant ever changed. Restructured to assert kind directly without using it as a guard.
- **HIGH: README + 7 translations + handbook tool count drift** (28 vs 41). Stage A landed the EN fix; Stage B's `scripts/sync-doc-versions.mjs` makes the drift impossible going forward (HTML-comment markers + CI guard).
- **HIGH: HANDOFF / SHIP_GATE / CONTRIBUTING stale.** All caught up to current version + test count + tool count.
- Tests went from 792 → 958 passing (+166, 1 todo).

### Deprecated

None.

### Removed

None.

### Security

- **HIGH: Shell injection in `batchProofCheck.ts`** — see **Fixed** (RCE on Windows).
- **HIGH: Symlink-traversal in `codeMap.ts`** — see **Fixed** (exfil window).
- **HIGH: Protected-path / citation-allowlist case bypass on Windows** — see **Fixed**.
- **CodeQL workflow** added (covers JS/TS, weekly).
- **dependency-review-action** added on PRs.
- **POSIX parent-dir fsync + .tmp cleanup** in `atomicWriteFile` close the durability gap from v2.4.0.

### Upgrade notes

- **Confidence guardrail callers**: if you call `applyConfidenceThreshold` directly without setting `allow_none`, you now get fail-closed behavior (returns `null` label when below threshold, with `below_threshold:true` flag) instead of the previous fail-open (returned the weak label). Pass `allow_none: false` to restore the old behavior. Most callers go through the standard tools (classify, research, etc.) which already handle the strip event; this is only relevant if you import the helper directly.
- **New tool surface**: `ollama_code_review` is registered in `src/index.ts`. No client-side changes needed unless you maintain a hard-coded tool whitelist — bump the count from 41 → 42.
- **Correlation IDs** are additive — new fields in NDJSON events + envelope. Existing parsers that ignore unknown fields continue to work.
- **CLI verbs** (`doctor`, `init`, `--version`, `--help`) only fire when the binary is invoked with args; no-args behavior (MCP stdio default) unchanged.

## [2.4.0] — 2026-05-12

Non-breaking additive minor. All v2.3.0 callers continue working unchanged. Per-tier `num_ctx` control on the profile system; current behavior preserved when unset.

Closes the operational gap surfaced by the research-os v0.8.0 Phase 1 diagnostic: hermes3:8b at the default 32K context on RTX 5080 16GB VRAM spills to CPU, causing workhorse-tier `ollama_extract` to time out. v2.4.0 lets profiles declare per-tier context-window size so workhorse/instant can run at smaller `num_ctx` while deep keeps its long-context default.

### Added

- **`TierConfig.num_ctx` (per-tier context-window map).** Optional `{ instant?, workhorse?, deep?, embed? }` map on `TierConfig`. When set for a tier, the MCP server places `options.num_ctx = <value>` on every Ollama generate / chat request routed to that tier — initial attempt and fallback. When unset, the request omits `num_ctx` entirely and Ollama uses the model-loaded default (v2.3.0 behavior preserved).
- **`envelope.num_ctx_used` field.** Present only when the MCP server actually sent `num_ctx` to Ollama on the final attempt. Absent when no `num_ctx` was sent. Do not infer a default — absent means "Ollama chose."
- **`dev-rtx5080` profile defaults.** `instant: 4096`, `workhorse: 8192`. Deep + embed left unset. Sized to keep hermes3:8b resident in the RTX 5080's 16GB VRAM budget for fast tools.
- **`dev-rtx5080-qwen3` profile defaults.** Mirrors `dev-rtx5080` — same VRAM constraint applies to Qwen3 8B as hermes3:8b.
- **`m5-max` profile defaults.** All tiers UNSET. 128GB unified memory has no spill problem at any reasonable context size.

### Changed

- **Tool runner / batch helpers** (`src/tools/runner.ts`, `src/tools/batch.ts`) resolve per-tier `num_ctx` against the ACTIVE tier — so a workhorse→instant fallback picks up instant's `num_ctx` (or stays unset). Threading happens once in shared infrastructure; atom and composite tools inherit it automatically.
- **`ollama_chat`** (non-runner path) now also resolves and applies workhorse `num_ctx`.
- **Prewarm** (`src/prewarm.ts`) carries the active tier's `num_ctx` so the warmed model loads at the same context size the runtime uses — prevents Ollama from reloading the model on first real call.
- **`corpus_search` explain sub-call** carries the instant tier's `num_ctx` for the same reason.

### Fixed

- **Pack-size baseline** (`tests/pack.test.ts`) — bumped `BASELINE_PACKED_BYTES` from 350_000 to 385_000 to absorb prior legitimate growth that had pushed the pristine v2.3.0 tarball above the 10% tolerance ceiling.

### Semantics (locked)

1. Profile's tier `num_ctx` set → request carries `options.num_ctx`; envelope carries `num_ctx_used`.
2. Profile's tier `num_ctx` unset → request omits `num_ctx`; envelope omits `num_ctx_used`. Ollama uses its model-loaded default. This is the v2.3.0 contract.
3. Fallback retries resolve `num_ctx` against the FALLBACK tier, not the initial tier — same posture as `modelOverride` (per-call model override): degradation is per-tier-coherent.
4. No per-call `num_ctx` input on any tool. Operators tune by selecting / editing the profile.

### Tests

- 792 total (up from 762 in v2.3.0). New: `tests/numCtx.test.ts` (atom-tool coverage for the 8 atom tools × set/unset, batch-mode positive/negative, composite via `change_brief`, diagnostic regression smoke on workhorse hermes3:8b → 8192), plus profile-schema assertions in `tests/profiles.test.ts`, `tests/tiers.test.ts` (`resolveNumCtx` helper), and `tests/envelope.test.ts` (`num_ctx_used` builder field).

### Migration

Drop-in upgrade from v2.3.x. No breaking changes. Existing callers see identical Ollama wire payloads unless they're on `dev-rtx5080` / `dev-rtx5080-qwen3` (where `instant`/`workhorse` calls will start carrying explicit `num_ctx`). The fix is the point — operators on those profiles get the spill-prevention behavior for free.

If you've been pinning a custom model via `INTERN_TIER_*` and need the old 32K behavior on a constrained-VRAM box, switch to `m5-max` or edit the profile's `num_ctx` map directly.

### Out of scope (deliberately)

- No per-tier `num_gpu` / `num_thread` / batch size.
- No profile inheritance / composition.
- No runtime `/api/ps` querying for effective-context detection.
- No per-call `num_ctx` override on tool inputs (only profile-level).
- No deep-tier `num_ctx` change on shipped profiles (current default preserved; future revision when/if deep-tier spill surfaces).
- No new tools.

## [2.3.0] — 2026-05-11

Non-breaking additive minor. All v2.2.0 callers continue working unchanged. Per-call model override on atom tools; tier/profile defaults preserved when `model` omitted.

The motivating use case: receipt-backed orchestration (research-os reviewer profiles, calibration evidence, model-comparison proofs) needs to specify an exact model per call while still inheriting the tier's timeout + fallback discipline. Composite/brief tools continue to use tier defaults — orchestrators that need per-call control should call atom tools directly.

### Added

- **Per-call `model: string` input on 8 atom tools.** `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep`, `ollama_research`, `ollama_corpus_answer`, `ollama_chat`, and `ollama_code_citation` accept an optional `model` field. When provided, the first attempt on the tool's tier runs against that model instead of the tier-resolved default. Empty / whitespace-only inputs throw `ZodError` at schema parse (loud schema failure beats silent fallthrough).
- **`envelope.model_requested` field.** Present only when `input.model` was supplied. Calibration-aware callers detect fallback substitution by comparing `model_requested` vs `model`: `if (env.model_requested && env.model !== env.model_requested) { /* substitution */ }`.
- **Operator contract — atoms vs composites.** Atom tools accept `model`; composite/brief/pack tools (`change_brief`, `incident_brief`, `repo_brief`, `repo_pack`, `change_pack`, `incident_pack`, `hypothesis_drill`, `triage_logs`) do NOT. Their internal extract/classify calls continue to use tier defaults. Orchestrators that need per-call model identity should call atoms directly. This is a load-bearing design choice — composites bundle multiple LLM calls and per-call control across them would be a leaky abstraction.

### Changed

- **Tool descriptions for the 8 atom tools** in the MCP schema surface the new optional `model` input and explicitly document the override-then-fallback semantics (override applies only to the initial attempt; fallback uses the tier-resolved model, NOT the caller's override).

### Fixed

- **`src/version.ts` drift.** The runtime `VERSION` constant was hardcoded "2.0.0" and silently drifted across v2.1.0 and v2.2.0. Replaced with a JSON import from `package.json` (`with { type: "json" }`); a new `tests/version.test.ts` locks `VERSION === pkg.version` so future bumps stay in sync automatically. tsconfig already had `resolveJsonModule: true` and `module: NodeNext`, so no config change was needed.

### Semantics (locked)

1. `input.model` provided → first attempt uses that model, the tier's `TIER_TIMEOUT_MS` still applies.
2. On timeout → fallback to the tier-resolved fallback model (per the existing `TIER_FALLBACK` chain). The fallback retry does NOT use `input.model`.
3. `input.model` omitted → existing tier/profile resolution unchanged; `model_requested` absent from the envelope.
4. Empty / whitespace-only `input.model` → `ZodError` at schema parse, NOT silent fallthrough.

### Tests

- 762 total (up from 725 in v2.2.0). New: per-tool model-override coverage on all 8 atom tools (override threading, tier-default fallthrough, ZodError on `""` and `"   "`), an integration test for the research-os calibration pattern (`frame + model` together), the load-bearing fallback-semantics test (override times out on workhorse → instant fallback uses tier-resolved model, envelope surfaces both `model` and `model_requested`), and `tests/version.test.ts` (`VERSION === pkg.version`).

### Migration

Drop-in upgrade from v2.2.x. No breaking changes. Existing callers that do not pass `model` see identical behavior. New callers can begin specifying `model` per call where needed.

### Out of scope (deliberately)

- No new tier types, no new profile fields, no new env vars.
- No changes to the `TIER_FALLBACK` chain.
- No `model` override on composite/brief/pack tools — atom tools only.
- No `timeout_ms` or `temperature` per-call overrides — separate proposal if/when needed.
- No widening into non-atom tools (`corpus_search`, `corpus_index`, `embed`, `embed_search`, `doctor`, `log_tail`, `code_map`, `batch_proof_check`, `artifact_*`, etc.).
- No new top-level tools.

## [2.2.0] — 2026-05-11

Non-breaking additive minor. All v2.1.0 callers continue working unchanged. New behavior unlocks when new optional inputs are supplied.

Closes the relevance-laundering gap identified in the 2026-05-11 role-contract dogfood: tools can now signal topicality and abstain from synthesis when sources do not address the caller's frame, rather than laundering off-topic-but-true content into authoritative-looking output.

### Added

- **Frame-bound extraction.** `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, and `ollama_summarize_deep` accept an optional `frame: string` input. Output includes a structured `frame_alignment` block (`on_topic: boolean`, `reason: string`, `unaddressed_aspects: string[]` for `extract`; equivalent shape for the other three). Omitting `frame` preserves v2.1.0 behavior.
- **Abstention contract on `ollama_research`.** New output fields `weak: boolean`, `abstained: boolean`, `sources_address_question: boolean | null`. An empty `citations[]` paired with a non-empty `answer` is no longer silent — the tool now declares abstention explicitly. Abstention is a success, not a failure.
- **Topicality threshold on `ollama_corpus_answer`.** New optional input `min_top_score: number` (0.0–1.0). When the top retrieval score is below this floor, the tool short-circuits with `abstained: true` and does not invoke the synthesis model. Closes the "five sub-threshold hits still drive a confident answer" gap that `weak: true` (which only fired on `hits.length < 2`) did not catch.
- **Per-citation retrieval score on `ollama_corpus_answer`.** Each item in `citations[]` now includes `score: number` (the underlying retrieval score for that chunk). Operators can audit retrieval quality directly from the envelope.
- **Retrieval score propagation into brief evidence.** `corpusHitsToEvidence` now carries the retrieval `score` through to `EvidenceItem` records consumed by `incident_brief`, `repo_brief`, and `change_brief`. Briefs synthesized from corpus material can now expose the underlying retrieval grounding rather than dropping it at the corpus→evidence boundary.

### Changed

- **README envelope example** — corpus `citations[]` field renamed from the historical `chunk_id` to the actual implementation field `chunk_index`. The example envelope previously documented a field that did not exist in the return shape.
- **README "validated server-side" wording** — the sentence "Every claim in `answer` cites a chunk id validated server-side." has been rewritten to explicitly disclose that server validation is citation-identity / range-bound, not semantic-content-bound. The model remains responsible for grounding claims in cited content.
- **README Evidence Laws section** — new clarifying bullet: ID-validated is not content-validated. Reframes the existing "unknowns stripped server-side" law to make the boundary explicit.
- **README cathedral example** — `weak: false` annotated as "≥2 evidence items assembled, not vetted hypotheses." Renderer-deterministic language qualified: the renderer is code, the *content* is generative.
- **`docs/marketing-research.md` slogan** — "Evidence-first. No fiction." now qualified inline with the citation-ID-validated boundary clarification.
- **Tool descriptions for affected tools** in the MCP schema surface the new optional inputs and the abstention contract (see `src/index.ts`).

### Fixed

- **`line_range` bounds-check in citations.** `src/guardrails/citations.ts` now validates that `line_range` falls within the actual file's line count before accepting a citation, matching the posture already in `code_citation`. Previously only `code_citation` performed this check; `research` accepted unbounded ranges.

### Stats (preliminary — will firm up at release)

- Tool count unchanged at 41 (extends existing tools; no new tier class).
- All v2.1.0 callers continue to work without changes.

## [2.1.0] — 2026-04-22

Feature pass of the dogfood swarm. 28-tool freeze lifted after validating Hermes integration on v2.0.0-v2.0.2. Tool count **28 → 41**. Extends existing tiers with ops, refactor, corpus, and artifact tools. No new tier class.

### Migration

Drop-in upgrade from v2.0.x. No breaking changes. `summarize_deep` gained a `source_path` alternative to `text` (both shapes supported). `corpus_search` gained optional `filter` and `explain` params (omitting them preserves existing behavior).

### Added — new tools (13)

**Ops**
- **`ollama_doctor`** — first-run prereqs + status snapshot. Ollama reachability, loaded/pulled/required models, profile tiers, allowed_roots, recent errors. One-call health gate.
- **`ollama_log_tail`** — structured read of `~/.ollama-intern/log.ndjson`. Filterable by `limit`, `filter_kind`, `filter_tool`, `since`. No Ollama round-trip.
- **`ollama_batch_proof_check`** — run `tsc` / `eslint` / `pytest` / `ruff` / `cargo-check` over a file list; single envelope with per-check pass/fail. Cwd validation + per-check timeouts. New process-execution surface — see SECURITY.md.

**Refactor**
- **`ollama_code_map`** — fast structural summary (languages, frameworks, entrypoints, build commands).
- **`ollama_code_citation`** — Deep-tier answer over `source_paths` with every claim grounded at `{file, start_line, end_line}`. Out-of-scope citations stripped server-side.
- **`ollama_multi_file_refactor_propose`** — Workhorse-tier coordinated cross-file change plan. Risk levels, affected imports, verification steps. No writes.
- **`ollama_refactor_plan`** — Workhorse-tier phased sequencing (phases, parallelism, tests, rollback). Pairs with `multi_file_refactor_propose`.

**Artifact / Brief**
- **`ollama_artifact_prune`** — age/pack-type cleanup of `~/.ollama-intern/artifacts/`. `dry_run: true` default; `false` must be explicit.
- **`ollama_hypothesis_drill`** — Deep-tier focused sub-brief from one `incident_pack` hypothesis. No re-running the pack.

**Corpus**
- **`ollama_corpus_health`** — per-corpus health superset of `corpus_list`: chunks, staleness, drift, failed_paths, write_complete, amend status.
- **`ollama_corpus_amend`** — Embed-tier single-file re-embed without full refresh. **Breaks the "corpus is a disk snapshot" invariant**; manifest records `has_amended_content: true`.
- **`ollama_corpus_amend_history`** — read-only companion. Lists amended paths, timestamps, chunk-count deltas. Use before re-indexing.
- **`ollama_corpus_rerank`** — post-retrieval re-sort by `recency` / `path_specificity` / `lexical_boost`. No Ollama call.

### Changed — enhancements (4)

- **`corpus_search({filter: {path_glob?, since?}})`** — in-house glob matcher (`**`, `*`, `?`); `since` is ISO-8601. Filters apply before RRF fusion.
- **`corpus_search({explain: true})`** — per-hit "why matched" reasoning via Instant tier. Top-5 cap; degrades gracefully to an envelope warning if the explain model is unavailable.
- **`summarize_deep({source_path})`** — closes adoption-memory SEAM #2. Accepts either `text` or `source_path`; the latter loads the file server-side via safePath.
- **`ollama_embed`** — description + handbook warning about vector-overflow on large batches; runtime envelope warns when serialized payload exceeds ~500KB.

### Dev ops

- **`npm run ship`** — typecheck + build + test + pack check. One-liner pre-publish gate.
- **`tests/mcpGolden.test.ts`** +3 roundtrip tests (unknown tool, malformed args, structured tool-level error).
- **`tests/pack.test.ts`** size-regression floor: compressed baseline + 10% tolerance.
- **`actions/checkout@v6`** and **`actions/setup-node@v6`** SHA-pinned in both CI workflows (supersedes closed Dependabot #2/#3).

### Docs

- NEW `handbook/observability.md` — NDJSON anatomy, jq recipes, degradation signatures.
- NEW `handbook/comparison.md` — honest matrix vs `houtini-lm`, `mcp-local-llm`, raw Ollama HTTP, Claude-direct.
- NEW `examples/` — `simple-client-node.js`, `simple-client-python.py`, `curl-example.md`. Not shipped to npm.
- `handbook/tools.md` — all 13 new tools + 4 enhancements; end-to-end refactor workflow example.
- `handbook/artifacts.md` — snippet-tool walkthroughs + `artifact_prune` safety example.
- `README.md` — hardware minimums, examples pointer, "New in v2.1.0" block, tool count 28 → 41.
- `CONTRIBUTING.md` — examples pointer + `npm run ship` note.

### Security

- **Filesystem delete in `artifact_prune`** — first tool that deletes. Dry-run default; deletion scoped to `~/.ollama-intern/artifacts/<pack>/`.
- **Process execution in `batch_proof_check`** — new surface. Mitigated by cwd validation + per-check timeouts + tool whitelist.
- **Corpus-snapshot invariant break** in `corpus_amend` — `has_amended_content` flag + `corpus_amend_history` tool surface the drift.
- **File-reading in `code_map` / `code_citation`** — same `allowed_roots` mitigation as existing `research` / corpus tools.

### Stats

- Tests **582 → 672** (+90)
- Tool count **28 → 41** (13 new + 4 enhancements)
- Tarball 254.9 kB → 336.7 kB compressed (1.3 MB unpacked, 331 files)
- Shipcheck audit 96% (non-blocking gap: landing-page Phase 2, org-level)

## [2.0.2] - 2026-04-21

### Changed

- **deps: zod 3.25.76 → 4.3.6.** Two breaking-change fixes in-house: `z.record` now requires an explicit key type (`z.record(z.string(), z.unknown())`); `ctx.addIssue` no longer accepts bare `$ZodIssue`, so issues are spread into a plain object to satisfy the new index-signature shape. No runtime behavior change. Closes #13.
- **deps: typescript 5.9.3 → 6.0.3, @types/node 20 → 22.** TS 6 tightened ambient-type handling; `tsconfig.json` now declares `"types": ["node"]` so node globals (`process`, `console`, `Buffer`, `node:` imports) resolve without the implicit fallback TS 5 allowed. Zero source changes. Closes #14.

All 481 tests pass on the new toolchain.

### Migration

No breaking changes — drop-in upgrade from v2.0.1.

## [2.0.1] - 2026-04-20

Three-stage dogfood-swarm health pass. No API changes, no tool-surface changes — everything here is hardening, observability, and operator-experience polish on the existing v2.0.0 surface.

### Fixed (Stage A — bugs + security)

- **corpus/indexer: TOCTOU race between `readFile` and `stat`.** `stat()` now runs before read; `mtime` is the pre-read state, guaranteeing a successful index means "the file was in this state when hashed."
- **corpus/indexer: unbounded file reads.** 50 MB hard cap on indexed files (`MAX_FILE_BYTES`). Throws a typed error naming the offending path and size when exceeded.
- **corpus/indexer: symlink-follow vulnerability.** `realpath` + `lstat` check now rejects symlinks before read.
- **corpus/indexer: chunk ID collisions across re-index runs.** Chunk IDs now include the content hash so they are stable-per-content and can't collide across runs or wrap at 16 M.
- **corpus/indexer: silent model-mismatch on reindex.** Indexing an existing corpus with a different embed model now errors instead of quietly mixing vector spaces.
- **corpus/manifest: unvalidated paths on load.** Manifest paths are validated against `..` escapes on load and rejected with a clear error.
- **corpus/manifest: silent schema downgrade.** Every write stamps `schema_version_written_by`; loading a newer-than-runtime manifest now errors instead of silently downgrading.
- **corpus/storage: 1 GB+ JSON writes.** `MAX_CHUNKS` guard (100 k) before serialize.
- **tools/artifacts: path-traversal hole under Windows.** `assertUnderAllowedRoots` rewritten with `path.relative` for authoritative containment (pre-normalize `..` check kept as defence-in-depth).
- **tools/triage_logs: prompt injection via user-supplied patterns.** `sanitizePatterns()` rejects patterns with newlines, triple-backticks, or over 200 chars before prompt build.
- **tools/summarize_deep: generic `Error` instead of `InternError`.** Error shape consistency restored.
- **tools/artifacts/scan: unsafe `brief!` non-null assertion.** Guard rewritten to narrow `brief` directly.
- **observability: unhandled promise rejection in `mkdir`.** `.catch` added; logger failures degrade silently instead of hanging the process.
- **tests/corpus/refresh: env restore leak under setup failure.** Module-load `MODULE_ORIG_CORPUS_DIR` snapshot + try/finally `afterEach` — applied to 10 more test files for parallel-run safety.
- **tests/mcpGolden: flaky subprocess timeout.** `SKIP_MCP_GOLDEN=1` opt-out; timeout now reports first 500 chars of stdout + parse-error details.

### Added (Stage B proactive + Stage C humanization)

- **Corpus partial-failure results.** `indexCorpus` now captures per-file failures in `failed_paths: Array<{path, reason}>` and continues past them. One bad file in a batch of 1000 no longer halts the whole pass.
- **Corpus atomic writes.** `saveCorpus` writes to `${path}.tmp` then `rename` (atomic on same filesystem). A crash mid-write leaves the prior corpus intact.
- **Prewarm cold-start signal.** `prewarm:in_progress_request` observability event emitted when a tool call arrives while prewarm is still running, so first-call-slow has a correlation point.
- **Semaphore wait observability.** `semaphore:wait` event emitted with `queue_depth`, `in_flight`, `expected_wait_ms` when a caller blocks. `Semaphore` also now exposes `snapshot()` + `wouldBlock`.
- **Actionable timeout error messages.** Terminal `TIER_TIMEOUT` messages now include tool, tier, model, elapsed ms, budget ms, and `fallback_attempted` flag.
- **Profile env-override logging.** `INTERN_TIER_*` env overrides log one stderr line at startup with `KEY overrides tier: from → to`. No more silent config surprises.
- **Residency probe diagnostics.** Probe failures log endpoint + model + error string (was silent).
- **Logger self-report.** First NDJSON logger write failure emits one stderr warning with errno + path; further warnings suppressed.
- **artifacts/scan safeListDir observability.** Unreadable directory emits a structured NDJSON `artifact_scan_skip` event to stderr (was silent).
- **corpus_answer zero-retrieval fast path.** Skips the residency probe when retrieval returns nothing (saves one Ollama round-trip on dead-end queries).
- **mcpGolden `tools/call` E2E test.** Uses `ollama_artifact_list` (no Ollama needed) as the minimum regression guard for the tools/call RPC path.
- **Troubleshooting handbook page.** New `site/handbook/troubleshooting.md` covering Ollama not running, model pull failures, hardware insufficient + tier fallbacks, `OLLAMA_MODEL_MISSING`, MCP server not appearing in Claude Code.
- **Hardware minimums in getting-started.** VRAM / RAM table for `hermes3:8b` + `nomic-embed-text`, with profile hints (`dev-rtx5080` / `dev-rtx5080-qwen3` / `m5-max`).
- **`.npmignore`.** Conservative deny-list belt-and-braces the `package.json` files allowlist.

### Changed

- **`num_predict` clamped** in `corpus_answer` to `Math.min(maxWords * 2.5, 4000)`.
- **README install order.** Claude Code MCP config block is now the recommended install; global install moved to "advanced" with an explicit "no global install required" note.
- **CI timeouts.** Every job in `ci.yml` and `pages.yml` now has `timeout-minutes: 15`. Prevents runaway minute burn from hung tests or Ollama timeouts.
- **CI paths-gating.** `.github/dependabot.yml`, `.npmignore`, and `package-lock.json` now trigger CI.
- **`.github/workflows/pages.yml` Node version 22 → 20** to match `ci.yml` and `engines.node >= 18`.
- **SECURITY.md vulnerability disclosure** now points to a GitHub private security advisory (the previous `@users.noreply` mailto was non-deliverable).
- **`.github/dependabot.yml`** no longer groups major upgrades. Minor + patch stay grouped (safe to batch); each major now gets its own PR so migrations get dedicated review. Fixes the root cause of the 5-major bundle in closed PR #4.

### Tests

- **464 → 481 tests** (+17). +16 tests in `guardrails/confidence.test.ts` (boundary / NaN / negative / > 1 / threshold=0,1 corners). +1 `tools/call` E2E in `mcpGolden.test.ts`.

### Deferred

- 16 LOW findings from Stages A/B (cosmetic, unused-code, micro-consistency).
- Corpus progress callback + `isCorpusStale` primitive (the Stage C corpus amend agent ran out of steam mid-task; followed up with the `failed_paths` half to close the type gap it opened).

### Meta

Swarm run: `swarm-1776670768-fd1a`, save point `swarm-save-1776670761`. Three PRs: #9 (dependabot config), #15 (Stage A), #16 (Stage B + C).

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
