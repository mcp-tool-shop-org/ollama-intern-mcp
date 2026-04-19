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

> **The local intern for Claude Code.** 28 job-shaped tools, evidence-first briefs, durable artifacts.

An MCP server that gives Claude Code a **local intern** with rules, tiers, a desk, and a filing cabinet. Claude picks the _tool_; the tool picks the _tier_ (Instant / Workhorse / Deep / Embed); the tier writes a file you can open next week.

**Also drives [Hermes Agent](https://github.com/NousResearch/hermes-agent) on `hermes3:8b`** — validated end-to-end 2026-04-19. The default ladder is `hermes3:8b`; `qwen3:*` is the alternate rail. See [Use with Hermes](#use-with-hermes) below.

No cloud. No telemetry. No "autonomous" anything. Every call shows its work.

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

That markdown file is the intern's desk output — headings, evidence block with cited ids, investigative `next_checks`, `weak: true` banner if evidence is thin. It's deterministic: the renderer is code, not a prompt. Open it tomorrow, diff it next week, export it into a handbook with `ollama_artifact_export_to_path`.

Every competitor in this category leads with "save tokens." We lead with _here is the file the intern wrote._

---

## What's in here — four tiers, 28 tools

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

The full tool reference lives in the [handbook](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/reference/).

---

## Install

```bash
npm install -g ollama-intern-mcp
```

Requires [Ollama](https://ollama.com) running locally and the tier models pulled.

### Claude Code

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
- **D. Hygiene** — `npm run verify` (395 tests), CI with dep scanning, Dependabot, lockfile, `engines.node`

---

## Roadmap (hardening, not scope creep)

- **Phase 1 — Delegation Spine** ✓ shipped: atom surface, uniform envelope, tiered routing, guardrails
- **Phase 2 — Truth Spine** ✓ shipped: schema v2 chunking, BM25 + RRF, living corpora, evidence-backed briefs, retrieval eval pack
- **Phase 3 — Pack & Artifact Spine** ✓ shipped: fixed-pipeline packs with durable artifacts + continuity tier
- **Phase 4 — Adoption Spine** — real-use observation on the RTX 5080, hardening the rough edges that surface
- **Phase 5 — M5 Max benchmarks** — publishable numbers once the hardware lands (~2026-04-24)

Phase by hardening layer. The atom/pack/artifact surface stays frozen.

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
