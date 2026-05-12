<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/ollama-intern-mcp/readme.png" alt="Ollama Intern MCP" width="500">
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/ollama-intern-mcp/actions"><img alt="CI" src="https://github.com/mcp-tool-shop-org/ollama-intern-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://mcp-tool-shop-org.github.io/ollama-intern-mcp/"><img alt="Landing Page" src="https://img.shields.io/badge/landing-page-8b5cf6"></a>
  <a href="https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/"><img alt="Handbook" src="https://img.shields.io/badge/handbook-docs-10b981"></a>
</p>

> **The local intern for Claude Code.** 41 job-shaped tools, evidence-first briefs, durable artifacts.

An MCP server that gives Claude Code a **local intern** with rules, tiers, a desk, and a filing cabinet. Claude picks the _tool_; the tool picks the _tier_ (Instant / Workhorse / Deep / Embed); the tier writes a file you can open next week.

**Also drives [Hermes Agent](https://github.com/NousResearch/hermes-agent) on `hermes3:8b`** — validated end-to-end 2026-04-19. The default ladder is `hermes3:8b`; `qwen3:*` is the alternate rail. See [Use with Hermes](#use-with-hermes) below.

**Hardware requirements:** ~6 GB VRAM for `hermes3:8b`, or ~16 GB RAM for CPU inference. See [handbook/getting-started](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/getting-started/#hardware-minimums) for the full breakdown.

**Not using Claude?** The [`examples/`](./examples/) directory has a minimal Node.js and Python MCP client you can spawn over stdio. See also [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/).

No cloud. No telemetry. No "autonomous" anything. Every call shows its work.

---

## New in v2.4.0

Per-tier `num_ctx` (context window) control on the profile system. Additive minor — v2.3.0 callers unchanged. Detailed entries in [CHANGELOG.md](./CHANGELOG.md) and [docs/release-notes/v2.4.0.md](./docs/release-notes/v2.4.0.md).

- **`TierConfig.num_ctx` map (new)** — optional `{ instant?, workhorse?, deep?, embed? }` on the profile. When set for a tier, the MCP server places `options.num_ctx = <value>` on every Ollama generate/chat request routed to that tier (initial + fallback). When unset, the request omits `num_ctx` entirely so Ollama uses its model-loaded default — v2.3.0 behavior preserved exactly.
- **New envelope field `num_ctx_used?: number`** — present only when the MCP server actually sent `num_ctx`. Absent when the request let Ollama choose. Do not infer a default — the MCP server does not query Ollama for the effective value.
- **Profile defaults**: `dev-rtx5080` / `dev-rtx5080-qwen3` ship with `instant: 4096`, `workhorse: 8192`, `deep`/`embed` UNSET. Sized to keep `hermes3:8b` resident in the RTX 5080's 16GB VRAM budget for fast tools. `m5-max` leaves every tier UNSET — 128GB unified memory has no spill problem.
- **Closes the v0.8.0 Phase 1 diagnostic** — `hermes3:8b` at the default 32K context on RTX 5080 spilled to CPU and started timing out workhorse `ollama_extract` calls. v2.4.0 prevents that at the profile layer.

### Per-tier `num_ctx` control (new in v2.4.0)

Profile (excerpt from `src/profiles.ts`):

```ts
"dev-rtx5080": {
  tiers: {
    instant: "hermes3:8b",
    workhorse: "hermes3:8b",
    deep: "hermes3:8b",
    embed: "nomic-embed-text",
    num_ctx: {
      instant: 4096,    // fast classify/summarize
      workhorse: 8192,  // schema-bound extract / batch
      // deep: UNSET — long-context briefs keep current behavior
      // embed: UNSET — no context-window pressure on embed
    },
  },
  // ... timeouts, prewarm
}
```

Envelope on a workhorse-tier call (e.g. `ollama_extract`):

```jsonc
{
  "result": { /* extracted data */ },
  "tier_used": "workhorse",
  "model": "hermes3:8b",
  "num_ctx_used": 8192,        // present because the profile set workhorse=8192
  // ... rest of envelope unchanged
}
```

On `m5-max` (or any profile that leaves a tier unset), `num_ctx_used` is absent from the envelope and the wire request to Ollama does not include the `num_ctx` field — Ollama uses its model-loaded default.

Operators tune by selecting / editing the profile; there is no per-call `num_ctx` input on tool schemas. If a future call surfaces the need, the pattern follows v2.3.0's `model` override.

### Historical — v2.3.0 deliverables

See [CHANGELOG.md](./CHANGELOG.md) and [docs/release-notes/v2.3.0.md](./docs/release-notes/v2.3.0.md) for the full v2.3.0 entry (per-call model override).

## New in v2.3.0

Per-call model override across LLM-backed atom tools. Additive minor — v2.2.0 callers unchanged. Detailed entries in [CHANGELOG.md](./CHANGELOG.md) and [docs/release-notes/v2.3.0.md](./docs/release-notes/v2.3.0.md).

- **Optional `model: string` input on 8 atom tools** — `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep`, `ollama_research`, `ollama_corpus_answer`, `ollama_chat`, `ollama_code_citation`. The first attempt on the tool's tier runs against the caller-specified model; on timeout, the existing `TIER_FALLBACK` cascade resolves the cheaper tier's own model (NOT the caller's override). Composite/brief/pack tools deliberately do NOT accept `model` — atoms get per-call control, composites use tier defaults.
- **New envelope field `model_requested?: string`** — present only when the override was supplied. Calibration-aware callers compare `model_requested` vs `model` to detect fallback substitution: `if (env.model_requested && env.model !== env.model_requested) { /* substitution */ }`. Empty / whitespace-only inputs throw `ZodError` at schema parse, not silent fallthrough.
- **Bug fix — `src/version.ts` drift.** The runtime `VERSION` constant is now read from `package.json` at module load; v2.1.0 and v2.2.0 had shipped reporting the stale `"2.0.0"` identity string. New `tests/version.test.ts` locks `VERSION === pkg.version`.

### Per-call model override (new in v2.3.0)

```jsonc
{
  "tool": "ollama_classify",
  "arguments": {
    "text": "patch null pointer in auth",
    "labels": ["feat", "fix", "chore"],
    "frame": "what is the change kind?",
    "model": "hermes3:8b"
  }
}
```

Envelope:

```jsonc
{
  "result": { "label": "fix", "confidence": 0.9, "off_topic": false, ... },
  "tier_used": "instant",
  "model": "hermes3:8b",
  "model_requested": "hermes3:8b",       // present because override was supplied
  // ... rest of envelope unchanged
}
```

If the workhorse/deep tier had timed out and the call had cascaded to the instant tier, `env.model` would be the instant tier's resolved model and `env.fallback_from` would be `"workhorse"` — `env.model_requested` would still be `"hermes3:8b"`, and `env.model !== env.model_requested` is the substitution signal. The override is deliberately NOT carried into the cheaper tier; the chosen model may not fit that tier's role at all.

### Historical — v2.2.0 deliverables

See [CHANGELOG.md](./CHANGELOG.md) and [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md) for the full v2.2.0 entry (frame-bound topicality + structured abstention).

## New in v2.2.0

Local evidence-worker role contract: frame-bound topicality and structured abstention. Additive minor — v2.1.0 callers unchanged. Detailed entries in [CHANGELOG.md](./CHANGELOG.md) and [docs/release-notes/v2.2.0.md](./docs/release-notes/v2.2.0.md).

- **Frame-bound extraction** on `ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, `ollama_summarize_deep` — optional `frame: string` input + structured `frame_alignment` / `on_topic` / `frame_addressed` outputs. Off-topic sources are flagged instead of paraphrased into the schema.
- **Structured abstention** on `ollama_research` — `weak` / `abstained` / `sources_address_question` fields. Empty `citations[]` with non-empty `answer` is no longer silent success.
- **Topicality threshold** on `ollama_corpus_answer` — optional `min_top_score`. Below the floor, the tool short-circuits with `abstained: true` and skips synthesis. Per-citation `score` now visible on each citation.
- **Retrieval score preservation** through brief evidence — `corpusHitsToEvidence` carries `score` (and `corpus_min_evidence_score` knob filters at assembly time on `incident_brief` / `repo_brief` / `change_brief`).
- **Citation line-range bounds** — `guardrails/citations.ts` rejects out-of-bounds ranges on `ollama_research`, matching the existing posture on `ollama_code_citation`.
- **Operator-contract docs corrected** — README `chunk_id`/`chunk_index` fix, "validated server-side" rewritten, Evidence Laws section qualified, marketing slogan annotated.

### Seed regression — the verification

The slice's contract is verified against the literal research-os fresh-pack failure: arxiv 2112.10422 (Cosmological Standard Timers) under the section-01 frame *"What does evidence custody mean in local-first vs cloud LLM deep-research workflows?"* — 9 / 9 mocked-LLM contract tests confirm the off-topic source is now contained (`frame_alignment.on_topic = false` on extract; `off_topic: true` on classify; `frame_addressed: false` on summarize_deep; `abstained: true` on corpus_answer with `min_top_score` set).

### Historical — v2.1.0 deliverables

See [CHANGELOG.md](./CHANGELOG.md) for the full v2.1.0 entry (feature pass: 13 new tools + 4 enhancements + freeze lift).

---

## Lead example — one call, one artifact

```jsonc
// Claude → ollama-intern-mcp
{
  "tool": "ollama_incident_pack",
  "arguments": {
    "title": "sprite pipeline 5 AM paging regression",
    "logs": "[2026-04-16 05:07] worker-3 OOM killed\n[2026-04-16 05:07] ollama /api/ps reports evicted=true size=8.1GB\n...",
    "source_paths": ["F:/AI/sprite-foundry/src/worker.ts", "memory/sprite-foundry-visual-mastery.md"]
  }
}
```

Returns an envelope pointing at a file on disk:

```jsonc
{
  "result": {
    "pack": "incident",
    "slug": "2026-04-16-sprite-pipeline-5-am-paging-regression",
    "artifact_md":   "~/.ollama-intern/artifacts/incident/2026-04-16-sprite-pipeline-5-am-paging-regression.md",
    "artifact_json": "~/.ollama-intern/artifacts/incident/2026-04-16-sprite-pipeline-5-am-paging-regression.json",
    "weak": false,
    "evidence_count": 6,
    "next_checks": ["residency.evicted across last 24h", "OLLAMA_MAX_LOADED_MODELS vs loaded size"]
  },
  "tier_used": "deep",
  "model": "hermes3:8b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

→ `weak: false` means ≥2 evidence items were assembled; it does NOT mean the hypotheses are vetted. See [Evidence laws](#evidence-laws) below.

That markdown file is the intern's desk output — headings, evidence block with cited ids, investigative `next_checks`, `weak: true` banner if evidence is thin. It's deterministic: the renderer is code, not a prompt. (The renderer is deterministic; the *content* of hypotheses and surfaces is generative — read them as draft, not verified.) Open it tomorrow, diff it next week, export it into a handbook with `ollama_artifact_export_to_path`.

Every competitor in this category leads with "save tokens." We lead with _here is the file the intern wrote._

### Second example — build a corpus, then ask it

```jsonc
// 1. Build a persistent, searchable corpus over your project.
{ "tool": "ollama_corpus_index",
  "arguments": { "name": "sprite-foundry",
                 "paths": ["F:/AI/sprite-foundry/src"],
                 "embed_model": "nomic-embed-text" } }
// → { chunks_written: 1204, paths_indexed: 312, failed_paths: [] }

// 2. Ask an evidence-bound question against it.
{ "tool": "ollama_corpus_answer",
  "arguments": { "name": "sprite-foundry",
                 "query": "how does the worker handle OOM eviction?",
                 "top_k": 8 } }
// → { answer: "...", citations: [{chunk_index, path}...], weak: false }
```

The server validates citation identity and that each `chunk_index` is in range of the retrieved hits. It does NOT prove that every generated claim is semantically supported by the cited chunk content — that's the model's responsibility, and weak retrieval can still produce citation-shaped answers. Full walkthrough in [handbook/corpora](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/corpora/).

---

## Frame-bound extraction (new in v2.2.0)

`ollama_extract`, `ollama_classify`, `ollama_summarize_fast`, and `ollama_summarize_deep` accept an optional `frame: string` input. The frame names the question the source is being asked to answer; the model is instructed to abstain rather than emit true-but-off-topic content when the source doesn't address the frame.

```jsonc
{
  "tool": "ollama_extract",
  "arguments": {
    "text": "<long source document>",
    "schema": { /* your fields */ },
    "frame": "section purpose here — e.g. 'OOM eviction behavior in the sprite worker'"
  }
}
// → result includes frame_alignment: { on_topic: boolean, reason: string, unaddressed_aspects: string[] }
```

If `frame` is omitted, behavior is unchanged from v2.1.0. When supplied, `frame_alignment.on_topic = false` signals that extracted fields may be true-of-the-source but not relevant to the frame — treat that as the same shape as a `weak: true` brief: useful, but spot-check before promoting into downstream evidence.

---

## Abstention contract (new in v2.2.0)

`ollama_research` returns structured abstention fields: `weak: boolean`, `abstained: boolean`, `sources_address_question: boolean | null`. An empty `citations[]` with a non-empty `answer` is no longer silent — `abstained: true` says the model declined to synthesize because the caller-supplied paths did not address the question. Treat abstention as a success, not a failure: it is the tool refusing to launder weak retrieval into authoritative output.

`ollama_corpus_answer` accepts an optional `min_top_score: number` topicality threshold (0.0–1.0). When the top retrieval score for a query falls below `min_top_score`, the tool short-circuits with `abstained: true` and skips synthesis — preventing the "5 off-topic chunks at score 0.21 still drive a full answer" failure mode that the v2.1.0 `weak: true` rule did not catch (`weak: true` only fired on `hits.length < 2`). Pair this with the per-citation `score` field newly surfaced on each citation to audit retrieval quality directly from the envelope.

---

## What's in here — four tiers, 41 tools

**Job-shaped** means each tool names a job you'd hand to an intern — classify this, extract that, triage these logs, draft this release note, pack this incident. The tool's input is the job spec; the output is the deliverable. No generic `run_model` / `chat_with_llm` primitive at the top.

| Tier | Count | What lives here |
|---|---|---|
| **Atoms** | 15 | Job-shaped primitives. `classify`, `extract`, `triage_logs`, `summarize_fast` / `deep`, `draft`, `research`, `corpus_search` / `answer` / `index` / `refresh` / `list`, `embed_search`, `embed`, `chat`. Batch-capable atoms (`classify`, `extract`, `triage_logs`) accept `items: [{id, text}]`. |
| **Briefs** | 3 | Evidence-backed structured operator briefs. `incident_brief`, `repo_brief`, `change_brief`. Every claim cites an evidence id; unknowns stripped server-side. Weak evidence surfaces `weak: true` rather than fake narrative. |
| **Packs** | 3 | Fixed-pipeline compound jobs that write durable markdown + JSON to `~/.ollama-intern/artifacts/`. `incident_pack`, `repo_pack`, `change_pack`. Deterministic renderers — no model calls on the artifact shape. |
| **Artifacts** | 7 | Continuity surface over pack outputs. `artifact_list` / `read` / `diff` / `export_to_path`, plus three deterministic snippets: `incident_note`, `onboarding_section`, `release_note`. |

Total: **18 primitives + 3 packs + 7 artifact tools = 28**.

Freeze lines:
- Atoms frozen at 18 (atoms + briefs). No new atom tools.
- Packs frozen at 3. No new pack types.
- Artifact tier frozen at 7.

The full tool reference lives in the [handbook](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/).

---

## Install

Requires [Ollama](https://ollama.com) running locally and the tier models pulled (see [Model pulls](#model-pulls) below).

### Claude Code (recommended)

Most users install this by adding it to their Claude Code MCP server config — no global install required. Claude Code runs the server on demand via `npx`:

```json
{
  "mcpServers": {
    "ollama-intern": {
      "command": "npx",
      "args": ["-y", "ollama-intern-mcp"],
      "env": {
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}
```

### Claude Desktop

Same block, written to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

### Global install (advanced)

Only needed if you want the binary on your `PATH` for ad-hoc use outside Claude Code:

```bash
npm install -g ollama-intern-mcp
```

### Use with Hermes

This MCP was validated end-to-end with [Hermes Agent](https://github.com/NousResearch/hermes-agent) against `hermes3:8b` on Ollama (2026-04-19). Hermes is an external agent that *calls into* this MCP's frozen primitive surface — it does the planning, we do the work.

Reference config ([hermes.config.example.yaml](hermes.config.example.yaml) in this repo):

```yaml
model:
  provider: custom
  base_url: http://localhost:11434/v1
  default: hermes3:8b
  context_length: 65536    # Hermes requires 64K floor under model.*

providers:
  local-ollama:
    name: local-ollama
    base_url: http://localhost:11434/v1
    api_mode: openai_chat
    api_key: ollama
    model: hermes3:8b

mcp_servers:
  ollama-intern:
    command: npx
    args: ["-y", "ollama-intern-mcp"]
    env:
      OLLAMA_HOST: http://localhost:11434
      INTERN_PROFILE: dev-rtx5080
      # hermes3:8b is the default ladder in v2.0.0, so tier overrides are
      # only needed if you're pinning a different local model.
```

**Prompt shape matters.** Imperative tool-invocation prompts ("Call X with args …") are the integration test — they give an 8B local model enough scaffolding to emit clean `tool_calls`. List-form multi-task prompts ("do A, then B, then C") are capability benchmarks for larger models; don't interpret a list-form failure on 8B as "the wiring is broken." See [handbook/with-hermes](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/with-hermes/) for the full integration walkthrough + known transport caveats (Ollama `/v1` streaming + openai-SDK non-streaming shim).

### Model pulls

**Default dev profile (RTX 5080 16GB and similar):**

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=-1
```

**Qwen 3 alternate rail (same hardware, for Qwen tooling):**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export INTERN_PROFILE=dev-rtx5080-qwen3
```

**M5 Max profile (128GB unified):**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

Per-tier env vars (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) still override profile picks for one-offs.

---

## Uniform envelope

Every tool returns the same shape:

```ts
{
  result: <tool-specific>,
  tier_used: "instant" | "workhorse" | "deep" | "embed",
  model: string,
  hardware_profile: string,     // "dev-rtx5080" | "dev-rtx5080-qwen3" | "m5-max"
  tokens_in: number,
  tokens_out: number,
  elapsed_ms: number,
  residency: {
    in_vram: boolean,
    size_bytes: number,
    size_vram_bytes: number,
    evicted: boolean
  } | null
}
```

`residency` comes from Ollama's `/api/ps`. When `evicted: true` or `size_vram < size`, the model paged to disk and inference dropped 5–10× — surface this to the user so they know to restart Ollama or trim loaded-model count.

Every call is logged as one NDJSON line to `~/.ollama-intern/log.ndjson`. Filter by `hardware_profile` to keep dev numbers out of publishable benchmarks.

---

## Hardware profiles

| Profile | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| **`dev-rtx5080`** (default) | hermes3 8B | hermes3 8B | hermes3 8B | nomic-embed-text |
| `dev-rtx5080-qwen3` | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 14B | qwen3 32B | nomic-embed-text |

**Default dev** collapses all three work tiers onto `hermes3:8b` — the validated Hermes Agent integration path. Same model top to bottom means there is one thing to pull, one residency cost, one set of behavior to understand. Users who prefer Qwen 3 (with its `THINK_BY_SHAPE` plumbing) opt into `dev-rtx5080-qwen3`. `m5-max` is the Qwen 3 ladder sized for unified memory.

---

## Evidence laws

These are enforced in the server, not the prompt:

- **Citations required.** Every brief claim cites an evidence id.
- **Unknowns stripped server-side.** Models that cite ids not in the evidence bundle have those ids dropped with a warning before the result returns.
- **ID-validated, not content-validated.** Server checks that every cited `evidence_ref` points to a real evidence id in the assembled set. It does NOT verify that the claim text is derivable from the cited evidence — that is the model's job, and weak briefs sometimes contain unsupported claims with valid refs. Use `weak: true` + coverage_notes + the included `excerpt` field to spot-check.
- **Weak is weak.** Thin evidence flags `weak: true` with coverage notes. Never smoothed into fake narrative.
- **Investigative, not prescriptive.** `next_checks` / `read_next` / `likely_breakpoints` only. Prompts forbid "apply this fix."
- **Deterministic renderers.** Artifact markdown shape is code, not a prompt. `draft` stays reserved for prose where model wording matters.
- **Same-pack diffs only.** Cross-pack `artifact_diff` is refused loudly; payloads stay distinct.

---

## Artifacts & continuity

Packs write to `~/.ollama-intern/artifacts/{incident,repo,change}/<slug>.(md|json)`. The artifact tier gives you a continuity surface without turning this into a file-management tool:

- `artifact_list` — metadata-only index, filterable by pack, date, slug glob
- `artifact_read` — typed read by `{pack, slug}` or `{json_path}`
- `artifact_diff` — structured same-pack comparison; weak-flip surfaced
- `artifact_export_to_path` — writes an existing artifact (with provenance header) to a caller-declared `allowed_roots`. Refuses existing files unless `overwrite: true`.
- `artifact_incident_note_snippet` — operator-note fragment
- `artifact_onboarding_section_snippet` — handbook fragment
- `artifact_release_note_snippet` — DRAFT release-note fragment

No model calls in this tier. All render from stored content.

---

## Threat model & telemetry

**Data touched:** file paths the caller explicitly hands in (`ollama_research`, corpus tools), inline text, and artifacts the caller asks to be written under `~/.ollama-intern/artifacts/` or a caller-declared `allowed_roots`.

**Data NOT touched:** anything outside `source_paths` / `allowed_roots`. `..` is rejected before normalize. `artifact_export_to_path` refuses existing files unless `overwrite: true`. Drafts targeting protected paths (`memory/`, `.claude/`, `docs/canon/`, etc.) require explicit `confirm_write: true`, enforced server-side.

**Network egress:** **off by default.** The only outbound traffic is to the local Ollama HTTP endpoint. No cloud calls, no update pings, no crash reporting.

**Telemetry:** **none.** Every call is logged as one NDJSON line to `~/.ollama-intern/log.ndjson` on your machine. Nothing leaves the box.

**Errors:** structured shape `{ code, message, hint, retryable }`. Stack traces are never exposed through tool results.

Full policy: [SECURITY.md](SECURITY.md).

---

## Standards

Built to the [Shipcheck](https://github.com/mcp-tool-shop-org/shipcheck) bar. Hard gates A–D pass; see [SHIP_GATE.md](SHIP_GATE.md) and [SCORECARD.md](SCORECARD.md).

- **A. Security** — SECURITY.md, threat model, no telemetry, path-safety, `confirm_write` on protected paths
- **B. Errors** — structured shape across all tool results; no raw stacks
- **C. Docs** — README current, CHANGELOG, LICENSE; tool schemas self-document
- **D. Hygiene** — `npm run verify` (full vitest suite), CI with dep scanning, Dependabot, lockfile, `engines.node`

---

## Roadmap (hardening, not scope creep)

- **Phase 1 — Delegation Spine** ✓ shipped: atom surface, uniform envelope, tiered routing, guardrails
- **Phase 2 — Truth Spine** ✓ shipped: schema v2 chunking, BM25 + RRF, living corpora, evidence-backed briefs, retrieval eval pack
- **Phase 3 — Pack & Artifact Spine** ✓ shipped: fixed-pipeline packs with durable artifacts + continuity tier
- **Phase 4 — Adoption Spine** ✓ v2.0.1: three-stage health pass hardened corpus (TOCTOU, 50 MB file cap, symlink rejection, atomic writes, per-file failure capture), tool path traversal, observability (semaphore wait events, timeout error context, profile env-override logging, prewarm cold-start signal), test safety (module-load env snapshot across 10 files, `tools/call` E2E). Troubleshooting handbook + hardware minimums added for operators.
- **Phase 5 — M5 Max benchmarks** — publishable numbers once the hardware lands (~2026-04-24)

Phase by hardening layer. The atom/pack/artifact surface stays frozen.

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
