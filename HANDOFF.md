# Ollama Intern MCP — Session Handoff

**Status:** v0.1.0 LIVE · 28 tools across 3 tiers · 395 tests · shape complete
**Repo:** https://github.com/mcp-tool-shop-org/ollama-intern-mcp
**Local:** `F:/AI/ollama-intern-mcp`
**Hardware:** RTX 5080 16GB (Windows 11) — `dev-rtx5080` profile active; M5 Max arriving ~2026-04-24

---

## What this is

The product has crossed from "MCP server with local tools" into a **local cognitive labor layer** with three real classes of work:

- **Bulk repetitive work** — batch classify / extract / triage / summarize
- **Persistent knowledge work** — living corpora (manifest + incremental refresh), grounded retrieval, chunk-cited answers
- **Compound operator briefs** — incident / repo / change, each with durable markdown + JSON artifacts

Plus a **continuity surface** over artifacts — list, read, diff, export, and pack-shaped snippet helpers — so the intern's outputs live outside its own artifact directory without the product turning into a file-management tool.

Thesis + anti-drift laws in `memory/ollama-intern-mcp-handoff.md` §0. Do not soften.

---

## Tool surface (28 tools, 4 tiers)

### Atoms — 18 (frozen)
Retrieval & answer flagships:
- `ollama_research` — paths → answer with validated citations
- `ollama_corpus_search` — persistent corpus concept search
- `ollama_corpus_answer` — chunk-grounded synthesis over a corpus

Atoms:
- `ollama_embed_search` / `ollama_embed` / `ollama_corpus_index` / `ollama_corpus_refresh` / `ollama_corpus_list`
- `ollama_classify` / `ollama_triage_logs` / `ollama_summarize_fast` / `ollama_summarize_deep` / `ollama_draft` / `ollama_extract`
- `ollama_chat` (last resort)

Batch-capable atoms accept `items: [{id, text}]` for bulk workloads with one envelope per batch (classify, extract, triage_logs).

### Briefs — 3 flagships
- `ollama_incident_brief` — "what just happened" structured operator brief
- `ollama_repo_brief` — operator map of a repo
- `ollama_change_brief` — change impact brief with DRAFT release note

### Packs — 3 (frozen)
Each runs a fixed pipeline end-to-end and writes markdown + JSON artifacts:
- `ollama_incident_pack`
- `ollama_repo_pack`
- `ollama_change_pack`

Default artifact roots:
- `~/.ollama-intern/artifacts/incident/`
- `~/.ollama-intern/artifacts/repo/`
- `~/.ollama-intern/artifacts/change/`

### Artifact tier — 7 tools
Continuity surface over pack outputs:
- `ollama_artifact_list` — metadata-only index with filters
- `ollama_artifact_read` — typed read by `{pack, slug}` or `{json_path}`
- `ollama_artifact_diff` — structured same-pack comparison, weak flip surfaced
- `ollama_artifact_export_to_path` — handoff: writes existing markdown (with provenance header) to a caller-allowlisted path
- `ollama_artifact_incident_note_snippet` — operator-note fragment
- `ollama_artifact_onboarding_section_snippet` — handbook fragment
- `ollama_artifact_release_note_snippet` — DRAFT release-note fragment

---

## Spines shipped this session

| Spine | Commit | What |
|---|---|---|
| Retrieval Truth | `98b4600..e1d6eea` | schema v2 · lexical BM25 · query modes + RRF · retrieval eval pack · corpus_answer |
| Workflow | `ef55a8f..7a9309f` | batch surfaces · living corpora · incident/repo/change briefs |
| Pack | `842fd96..5466a62` | incident/repo/change packs with fixed markdown + JSON artifacts |
| Artifact | `8b43050..84e3277` | list · read · diff · export · three pack-shaped snippets |

Laws locked across the session (see commit bodies):
- **No remediation drift** — investigative checks only; prompts forbid "apply this fix"
- **Deterministic renderers** — no `ollama_draft` rendering for artifact markdown
- **Evidence first-class** — every claim cites evidence ids; unknown refs stripped server-side
- **Weak brief banner** — thin evidence never smoothes into fake narrative
- **Path safety strict** — `..` rejected before normalize; allowed_roots required for export
- **Same-pack diffs only** — cross-pack refused loudly; payloads stay distinct

---

## Pre-publish workflow (in order)

This repo is near publish. The canonical workflow lives in the global memory:

```
C:/Users/mikey/.claude/projects/F--AI/memory/
  shipcheck.md        — 31-item quality gate (MUST pass first)
  full-treatment.md   — 7-phase polish + publish playbook
  handbook-playbook.md — Starlight docs setup
  npm-publish.md      — npm tarball verification
  translation-workflow.md — README translation via polyglot-mcp
```

### Step 1 — Shipcheck (MUST pass first)

```bash
cd F:/AI/ollama-intern-mcp
npx @mcptoolshop/shipcheck init     # if not initialized
npx @mcptoolshop/shipcheck audit    # 31-item audit, hard gates A-D must pass
```

Hard gates A-D block release:
- **A. Security** — SECURITY.md, threat model in README, no secrets/telemetry
- **B. Errors** — structured `{code, message, hint, retryable}` shape (already done), exit codes, no raw stacks
- **C. Docs** — README current, CHANGELOG, LICENSE, --help accurate
- **D. Hygiene** — verify script, version matches tag, dep scanning, clean packaging

If shipcheck fails: fix, don't publish.

### Step 2 — Marketing research swarm (new — research the positioning)

Before running the full treatment, spawn a research swarm to sharpen the marketing story. The product shape is now distinct enough to position clearly:

**Research swarm prompt** (hand to an Explore/general-purpose agent):

> Research competitive positioning for `ollama-intern-mcp`. The product is a local cognitive labor layer (MCP server) that lets Claude Code delegate bulk work to Ollama models via 28 job-shaped tools across 4 tiers: 18 atoms (classify/extract/triage/summarize/draft/search/answer), 3 briefs (incident/repo/change), 3 packs (fixed-pipeline compound jobs producing markdown + JSON artifacts), 7 artifact tools (list/read/diff/export/three snippet helpers). Produce a structured brief with:
>
> 1. **Adjacent / comparable projects** — other MCP servers for local LLMs (rawveg/ollama-mcp, houtini-ai/houtini-lm, disler/just-prompt, aplaceforallmystuff/mcp-local-llm), plus local-LLM delegation tools more broadly. How do they position? What do they claim? What do they miss?
> 2. **Differentiators we can own** — job-shaped tools (Claude picks the tool, the tool picks the tier), evidence-backed briefs with server-side citation validation, fixed-pipeline packs with durable artifacts, artifact continuity (list/read/diff/export/snippets), honest-degradation laws (weak banners, coverage notes, no remediation drift). What language captures each of these that isn't already overloaded?
> 3. **Audience shape** — Claude Code power users building MCP tools, Ollama users who want more than chat, solo indie devs doing bulk repo work. What do they search for? What words do they use?
> 4. **Taglines / one-liners** — 3–5 candidate tags that stay honest. Avoid "AI agent," "autopilot," "copilot." Prefer "intern," "delegation layer," "local cognitive labor."
> 5. **README structure for MCP servers** — what shape works? Hero → problem → example call → tool table → install → threat model? Look at the houtini-lm and shipcheck READMEs for reference.
> 6. **Terms to avoid** — phrases already owned by other products, or that drift the framing (e.g. "agent," "autonomous," "thinking"). Be specific.
> 7. **Landing-page scaffolding** — section list, recommended visual weight, what not to include.
>
> Return under 2000 words. Concrete recommendations, not a literature review.

Capture findings in a commit under `docs/marketing-research.md` in this repo.

### Step 3 — Full Treatment (7 phases)

Read `memory/full-treatment.md` AND `memory/handbook-playbook.md` — then execute in order:

1. README polish — hero, threat model, tool table, example call, install, verify
2. CHANGELOG — 0.1.0 entry describing the four spines
3. LICENSE + SECURITY.md verification
4. Translations (polyglot-mcp, run locally — NEVER from Claude)
5. Repo-knowledge DB entry (never skip this)
6. Starlight handbook (handbook-playbook.md)
7. Landing page linking the handbook

Version bump to v1.0.0 per shipcheck rule: "every shipchecked repo MUST be bumped to v1.0.0 minimum before commit."

### Step 4 — npm publish

Read `memory/npm-publish.md` for the tarball verification checklist.

```bash
npm run verify                      # all green (395 tests)
npm pack --dry-run                  # inspect tarball contents
npm publish --access public         # requires npm login as mcp-tool-shop-org
```

After publish, verify CI is green (`gh run list --limit 1`). If red, fix immediately.

---

## Verification commands

```bash
# Full verify — must pass before any publish step
cd F:/AI/ollama-intern-mcp && npm run verify
# Expected: 395 tests, 34 files, typecheck clean, build clean

# Ollama alive
curl -s http://127.0.0.1:11434/api/version

# MCP connected
cd F:/AI && claude mcp list | grep ollama-intern   # ✓ Connected
```

---

## What NOT to do next

Per explicit direction from the user (honoring the spine-completion boundary):

- No more atom tools (frozen at 18)
- No more pack types (frozen at 3)
- No agent planner / auto-router
- No grading/eval framework expansion
- No more retrieval substrate unless a real workflow breaks
- No generic chat-over-corpus surface
- No VCS integration in change_pack
- No watcher/daemon for corpora or artifacts
- No generic markdown templating engine

The product has a shape. The next move is polish + publish, not more machinery.

---

## Deep reads (canonical memory)

- `memory/ollama-intern-state-2026-04-17.md` — current state (update this after publish)
- `memory/ollama-intern-mcp-handoff.md` §0 — thesis + anti-drift laws
- `memory/full-treatment.md` — publish playbook
- `memory/shipcheck.md` — 31-item quality gate
- `memory/handbook-playbook.md` — Starlight docs setup
- `memory/npm-publish.md` — tarball verification
