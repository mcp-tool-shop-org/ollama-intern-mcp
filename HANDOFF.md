# Ollama Intern MCP — Handoff

**Status:** v2.1.0 published · 41 tools (atoms + briefs + packs + artifact tier) · 672 tests · CI green
**Repo:** https://github.com/mcp-tool-shop-org/ollama-intern-mcp
**npm:** https://www.npmjs.com/package/ollama-intern-mcp
**Hardware:** M5 Max 128GB unified (active 2026-04-24+); RTX 5080 16GB box still works for `dev-rtx5080` profile

For the canonical session-by-session state, see `memory/ollama-intern-state-2026-04-22.md` in the user's memory tree (not in this repo).
For forward-looking work, see [ROADMAP.md](./ROADMAP.md).
For shipped history, see [CHANGELOG.md](./CHANGELOG.md).

---

## What this is

A **local cognitive labor layer** (MCP server) with three classes of work:

- **Bulk repetitive work** — batch classify / extract / triage / summarize
- **Persistent knowledge work** — living corpora (manifest + incremental refresh), grounded retrieval, chunk-cited answers
- **Compound operator briefs** — incident / repo / change, each with durable markdown + JSON artifacts

Plus a **continuity surface** over artifacts — list, read, diff, export, and pack-shaped snippet helpers — so the intern's outputs live outside its own artifact directory without the product turning into a file-management tool.

---

## Tool surface (41 tools, 4 tiers — freeze lifted at v2.1.0)

- **Atoms** — 15+13 (was 18; freeze lifted, 13 new ones added in v2.1.0 feature pass)
- **Briefs** — 3 (`incident_brief`, `repo_brief`, `change_brief`)
- **Packs** — 3 (`incident_pack`, `repo_pack`, `change_pack`)
- **Artifact tier** — 7 (list / read / diff / export + 3 snippet helpers)

Full inventory: `README.md` tool tables, or `src/tools/` directory.

The `28-tool freeze` that held v1.0.0 → v2.0.2 was lifted at v2.1.0 with discipline: new tools allowed when an audit shows a real gap, each new tool needs tests + handbook page + CHANGELOG entry. The Phase 2.5 surface (skill / memory / routing / shadow / audit / calibration) stays reverted — Hermes/Claude still plan, MCP still works. See `memory/feedback_dont_push_smaller_scope.md`.

---

## Local setup (Mac / M5 Max)

```bash
# 1. Install Ollama
brew install ollama
ollama serve &

# 2. Pull the m5-max profile's models (or whichever profile you use)
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text

# 3. Set the profile (per-tier env vars also override; see src/profiles.ts)
export INTERN_PROFILE=m5-max

# 4. Install + verify
cd /Volumes/T9-Shared/AI/ollama-intern-mcp
npm ci
npm run verify   # typecheck + build + 672 tests
```

For RTX 5080 (Windows or other dev box), use `INTERN_PROFILE=dev-rtx5080` (hermes3:8b ladder) or `dev-rtx5080-qwen3` (Qwen 3 alternate).

---

## Verify

```bash
# Full verify — must pass before any release work
npm run verify
# Expected: typecheck clean, build clean, 672 tests passing

# Ollama alive
curl -s http://127.0.0.1:11434/api/version

# MCP connected (from a Claude session)
claude mcp list | grep ollama-intern   # ✓ Connected
```

---

## Hard rules (don't do these)

Per explicit user direction, the product has a shape. Polish work is welcome; structural expansion needs an audit-driven gap.

- **No more pack types** (frozen at 3: incident / repo / change)
- **No agent planner / auto-router** (Hermes/Claude plans; MCP works)
- **No grading/eval framework expansion** beyond the existing eval pack
- **No more retrieval substrate** unless a real workflow breaks
- **No generic chat-over-corpus surface**
- **No VCS integration in change_pack**
- **No watcher/daemon for corpora or artifacts**
- **No generic markdown templating engine**

The freeze on **atoms** was lifted at v2.1.0 — new atoms are allowed when audit-justified. The freeze on **packs** still holds.

---

## Where to look

| Looking for... | Read |
|---|---|
| Current public state | `README.md`, `CHANGELOG.md` |
| Forward-looking work | [`ROADMAP.md`](./ROADMAP.md) |
| Threat model + security | `SECURITY.md` |
| Quality gate | `SHIP_GATE.md` |
| Tool-by-tool reference | `site/src/content/docs/handbook/` (Starlight) |
| NDJSON log shape | `site/src/content/docs/handbook/observability.md` |
| Corpus lifecycle | `site/src/content/docs/handbook/corpora.md` |
| Competitive positioning | `site/src/content/docs/handbook/comparison.md` |
| Client examples | `examples/` (Node + Python + curl) |
| Bench harness | [`bench/README.md`](./bench/README.md) |
| Hardware profiles | [`src/profiles.ts`](./src/profiles.ts) |

For session-state context (Claude / agent handoffs across sessions), see the user's memory tree under `memory/ollama-intern-*.md`. The most recent canonical entry as of this writing is `memory/ollama-intern-state-2026-04-22.md`.
