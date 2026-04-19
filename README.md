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

> **The local intern for Claude Code.** 40 tools across a frozen primitive core and four additive layers — skills, memory, shadow routing, operator-gated calibration. Evidence-first, durable, every call shows its work.

An MCP server that gives Claude Code a **local intern** with rules, tiers, a desk, a filing cabinet, a memory, and a shadow supervisor. Claude picks the _tool_; the tool picks the _tier_ (Instant / Workhorse / Deep / Embed); the tier writes a file you can open next week. Above that spine: reusable skills, embedding-backed memory across past runs, and a shadow router that records what _should_ have happened so operators can tune routing with proposals that are inspectable, replayable, and reversible.

No cloud. No telemetry. No "autonomous" anything. Shadow routing is shadow-only — no calibration can take control.

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
  "model": "qwen3:14b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}
```

That markdown file is the intern's desk output — headings, evidence block with cited ids, investigative `next_checks`, `weak: true` banner if evidence is thin. It's deterministic: the renderer is code, not a prompt. Open it tomorrow, diff it next week, export it into a handbook with `ollama_artifact_export_to_path`.

Every competitor in this category leads with "save tokens." We lead with _here is the file the intern wrote._

---

## What's in here — frozen core + four additive layers, 40 tools

The primitive core stays frozen. New functionality lives in layers above it.

### Core (28, frozen)

| Tier | Count | What lives here |
|---|---|---|
| **Atoms** | 15 | Job-shaped primitives. `classify`, `extract`, `triage_logs`, `summarize_fast` / `deep`, `draft`, `research`, `corpus_search` / `answer` / `index` / `refresh` / `list`, `embed_search`, `embed`, `chat`. Batch-capable atoms (`classify`, `extract`, `triage_logs`) accept `items: [{id, text}]`. |
| **Briefs** | 3 | Evidence-backed structured operator briefs. `incident_brief`, `repo_brief`, `change_brief`. Every claim cites an evidence id; unknowns stripped server-side. Weak evidence surfaces `weak: true` rather than fake narrative. |
| **Packs** | 3 | Fixed-pipeline compound jobs that write durable markdown + JSON to `~/.ollama-intern/artifacts/`. `incident_pack`, `repo_pack`, `change_pack`. Deterministic renderers — no model calls on the artifact shape. |
| **Artifacts** | 7 | Continuity surface over pack outputs. `artifact_list` / `read` / `diff` / `export_to_path`, plus three deterministic snippets: `incident_note`, `onboarding_section`, `release_note`. |

Freeze lines:
- Atoms + briefs frozen at 18. No new atom primitives.
- Packs frozen at 3. No new pack types.
- Artifact tier frozen at 7.

### Layers above the core (12)

| Layer | Count | What it does |
|---|---|---|
| **Skills** | 5 | Durable workflows that compose atoms into a named pipeline with triggers and a receipt. `ollama_skill_list`, `ollama_skill_match`, `ollama_skill_run`, `ollama_skill_propose`, `ollama_skill_promote`. Global skills ship in `~/.ollama-intern/skills/`; project skills in `<cwd>/skills/` override global by name. |
| **Memory** | 5 | Embedding-backed retrieval across past receipts, artifacts, skills, and proposals. `ollama_memory_refresh`, `ollama_memory_search`, `ollama_memory_read`, `ollama_memory_explain`, `ollama_memory_neighbors`. Nomic-style prefixes, typed hits with score bands, deterministic explanations with opt-in Instant-tier narration. |
| **Shadow routing** | 0 surface | Transparent instrumentation. Every call to a shadowable tool (10 atoms + 5 flagships + 3 packs) writes a `RoutingReceipt` to `<cwd>/artifacts/routing-receipts/` capturing the pre-execution decision, the actual invocation, outcome linkage, and the calibration version in effect. Actual behavior is unchanged — shadow is shadow-only. |
| **Routing** | 2 | Read-only audit + operator-gated calibration over shadow receipts. `ollama_routing_audit` surfaces findings (promotion_gap / override_hotspot / abstain_cluster / missed_abstain / unused_candidate / overconfident_route). `ollama_routing_calibrate` runs a propose / list / replay / approve / reject / rollback lifecycle — every approval requires a reason; every transition is appended to history; nothing auto-applies. |

Total: **28 core + 5 skills + 5 memory + 2 routing = 40 tools.**

The full tool reference lives in the [handbook](https://mcp-tool-shop-org.github.io/ollama-intern-mcp/handbook/tools/).

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

### Model pulls

**Default dev profile (RTX 5080 16GB and similar) — Qwen 3 ladder:**

```bash
ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
```

**M5 Max profile (128GB unified) — Qwen 3 + Llama 4 Scout:**

```bash
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull llama4:scout
ollama pull nomic-embed-text
export INTERN_PROFILE=m5-max
```

Qwen 3 requires `think: false` on short-output shapes (classify / extract / triage / summarize-fast) — the server enforces this automatically via `THINK_BY_SHAPE`. Without it, thinking tokens consume `num_predict` and the response comes back empty. Llama 4 Scout uses a different chat template than Llama 3.x (`<|header_start|>` / `<|eot|>`); the formatter layer branches on model family.

Per-tier env vars (`INTERN_TIER_INSTANT`, `INTERN_TIER_WORKHORSE`, `INTERN_TIER_DEEP`, `INTERN_EMBED_MODEL`) still override profile picks for one-offs. The former `dev-rtx5080-llama` profile was retired on 2026-04-18 — Llama 3.1 8B is obsolete and Llama 4 Scout (109B-total / 17B-active MoE) doesn't fit on 16GB VRAM.

---

## Uniform envelope

Every tool returns the same shape:

```ts
{
  result: <tool-specific>,
  tier_used: "instant" | "workhorse" | "deep" | "embed",
  model: string,
  hardware_profile: string,     // "dev-rtx5080" | "m5-max"
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
| **`dev-rtx5080`** (default) | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 32B | **llama4:scout** | nomic-embed-text |

**Same-family ladder on dev** so bad outputs are tool/design problems, not cross-family mismatches. Workhorse stays on qwen3:8b until a quantized Qwen3-Coder MoE variant fits the 16GB VRAM budget comfortably. The M5 Max deep slot promotes to Llama 4 Scout — the formatter layer branches on model family so Llama 4's `<|header_start|>` / `<|eot|>` template doesn't silently misalign.

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

## Skills — durable workflows above the atoms

Skills capture repeatable ways of working: a named pipeline over atoms + briefs + packs, with declared triggers, parameters, and a receipt written after every run. The skill layer is five tools — `ollama_skill_list`, `ollama_skill_match`, `ollama_skill_run`, `ollama_skill_propose`, `ollama_skill_promote`.

- **Global skills** live in `~/.ollama-intern/skills/*.json`. **Project skills** in `<cwd>/skills/*.json` override global by name.
- **Skill receipts** land in `<cwd>/artifacts/skill-receipts/*.json` — one JSON envelope per run, suitable for replay, diff, and memory indexing.
- **Proposals** surface in two flavors: lifecycle proposals (promote a draft to active, retire a skill with poor receipts) and new-skill proposals reconstructed from ad-hoc chains in the NDJSON call log.

Skills never grow the primitive surface — they compose what's already there.

---

## Memory — retrieval across past work

Memory indexes receipts, pack artifacts, skills, and candidate proposals into a single queryable substrate. Five tools: `ollama_memory_refresh`, `ollama_memory_search`, `ollama_memory_read`, `ollama_memory_explain`, `ollama_memory_neighbors`.

- **Embeddings** follow the nomic prefix contract: records get `search_document:`, queries get `search_query:`. Never reversed, never dropped.
- **Retrieval** returns typed hits with score bands and optional metadata pre-filters. `memory_search` is embedding-backed; `memory_neighbors` is pure math over the embedding space (no model call).
- **Explanations** are deterministic field-level match reports. `narrate=true` flips on an opt-in Instant-tier natural-language summary — defaults stay deterministic.
- **Excerpts** are opt-in (`include_excerpt=true`) and come from structured source extracts, not free-form model output.

Memory index lives at `~/.ollama-intern/memory/index.json` with an embeddings sidecar at `memory/embeddings.json`. Override both with `INTERN_MEMORY_DIR`.

---

## Shadow routing & calibration

Every call to a shadowable tool (10 atoms + 5 flagships + 3 packs = 18 tools) writes a **routing receipt** to `<cwd>/artifacts/routing-receipts/` capturing the pre-execution decision the router would have made, the actual invocation, the outcome link, and the calibration overlay version in effect. Actual behavior is unchanged — shadow is shadow-only.

Over those receipts, two operator tools run the learning loop:

- **`ollama_routing_audit`** — read-only findings across six categories: `promotion_gap`, `override_hotspot`, `abstain_cluster`, `missed_abstain`, `unused_candidate`, `overconfident_route`. Each finding carries a `recommended_next_action` — sometimes "calibrate," sometimes "author a skill trigger," sometimes "leave alone."
- **`ollama_routing_calibrate`** — action-typed lifecycle: `propose` / `list` / `replay` / `approve` / `reject` / `rollback`. Proposals are inspectable before approval. Replay shows the effect a proposal would have on a historical receipt window. Approvals require a `reason` string. Every transition appends to history; nothing auto-applies.

Design laws baked into tests:

- Shadow routing is **shadow-only**. No calibration can "take control."
- Calibration is **operator-gated**. No auto-apply, ever.
- Every routing decision under an overlay **stamps the overlay version** onto its receipt — the audit can always answer "which calibration produced this decision?"
- When a finding points at a gap calibration can't close (e.g., `missed_abstain` on a primitive that isn't in the candidate space), replay says so honestly and the audit recommends skill authoring instead.

Receipts, calibration store, and audit outputs all live on disk as plain JSON. `INTERN_CALIBRATIONS_DIR` overrides the calibration store location.

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
- **D. Hygiene** — `npm run verify` (596 tests), CI with dep scanning, Dependabot, lockfile, `engines.node`

---

## Roadmap

Shipped (the frozen spine):

- **Phase 1 — Delegation Spine** ✓ atom surface, uniform envelope, tiered routing, guardrails
- **Phase 2 — Truth Spine** ✓ schema v2 chunking, BM25 + RRF, living corpora, evidence-backed briefs, retrieval eval pack
- **Phase 3 — Pack & Artifact Spine** ✓ fixed-pipeline packs with durable artifacts + continuity tier

Shipped 2026-04-18 (the four additive layers — 28 → 40 tools):

- **Skill Layer (Phase 1 / 2 / 2.5)** ✓ named pipelines over atoms, receipts, lifecycle proposals, new-skill reconstruction from call-log chains
- **Memory (Phase 3A / 3B / 3C)** ✓ normalized index, embedding retrieval with nomic prefixes, deterministic explanations with opt-in narration, embedding-space neighbors
- **Shadow Routing (Phase 3D-A / 3D-B)** ✓ router core + pre-execution receipts across 18 shadowable tools, outcome linkage, no control transfer
- **Audit + Calibration (Phase 3D-C / 3D-D)** ✓ six finding categories, propose / replay / approve / rollback lifecycle, versioned overlays stamped onto every receipt

Next:

- **Skill-authoring proposer** — close the loop between `missed_abstain` audit findings and draft skill files the operator can review
- **Active routing** — narrow, deliberate control transfer once shadow data has earned trust (separate product decision, not unfinished cleanup)
- **M5 Max benchmarks** — publishable numbers once the hardware lands (~2026-04-24)
- **Eval harness** — held-out gold set with precision@k over time, replacing the current one-off live proofs

The core primitive surface stays frozen. New functionality is always a new layer above it.

---

## License

MIT — see [LICENSE](LICENSE).

---

<p align="center">Built by <a href="https://mcp-tool-shop.github.io/">MCP Tool Shop</a></p>
