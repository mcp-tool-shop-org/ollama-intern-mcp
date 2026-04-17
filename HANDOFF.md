# Ollama Intern MCP — Session Handoff

**Status:** v0.1.0 LIVE · 13 tools · 140 tests · 4 commits past Phase 0 scaffold
**Repo:** https://github.com/mcp-tool-shop-org/ollama-intern-mcp
**Local:** `F:/AI/ollama-intern-mcp`
**Hardware:** RTX 5080 16GB (Windows 11) — dev-rtx5080 profile active; M5 Max arriving ~2026-04-24

---

## What this is

An MCP server that gives Claude Code a **local delegation layer**. Claude picks the work type by picking the tool; the tool implies the Ollama model tier (Instant / Workhorse / Deep / Embed). Every call returns a uniform envelope with `tier_used`, `model`, `hardware_profile`, `tokens_in/out`, `elapsed_ms`, and `residency` (from `/api/ps` — guards the Ollama eviction bug #13227).

Full product-thesis + anti-drift laws live in `memory/ollama-intern-mcp-handoff.md` §0. Do not soften them.

---

## Shipped commits (newest first)

| Commit | What |
|---|---|
| `ce16084` | **Phase C** — Named corpus spine: `ollama_corpus_search` (flagship), `ollama_corpus_index`, `ollama_corpus_list`. JSON persistence at `~/.ollama-intern/corpora/`, idempotent by sha256, drift-guarded by model_version match. |
| `258e838` | **Phase B** — Coverage contract: `covered_sources` / `omitted_sources` / `coverage_notes` on `research` + `summarize_deep`. Multi-source silent-omission can't recur. |
| `7210322` | **Phase A** — Tests-as-law: 34 new tests (24 regressions named per commit, 7 prewarm invariants, 3 MCP stdio golden via subprocess). |
| `4ab1776` | Seam fixes: `ollama_embed_search` flagship added (raw vectors never leak); `summarize_deep` accepts `source_paths[]`. |
| `0ccfa1f` | Instant-tier prewarm on dev profiles; first real call is warm (~500ms not ~7s). |
| `fed244c` | Profile-aware timeouts (dev=15s, m5-max=5s Instant); compileCheck merges stdout+stderr for real tsc errors. |
| `259a949` | Windows MCP registration fix (realpathSync on both sides); `OLLAMA_HOST` accepts scheme-less host:port. |
| `cf91e30` | Three hardware profiles with `hardware_profile` stamped on every envelope + NDJSON line. |
| `5b6f657` | Initial 8-tool scaffold, 5 guardrails, NDJSON observability, bench + evals scaffolded. |

---

## Current tool surface (13 tools)

**Flagships — reach for these by default:**
- `ollama_research(question, source_paths[])` → grounded answer + validated citations (Deep, ~30-46s)
- `ollama_corpus_search(corpus, query, top_k?, preview_chars?)` → ranked hits from persistent corpus (Embed, ~100-200ms)
- `ollama_embed_search(query, candidates[{id,text}])` → ad-hoc concept ranking (Embed, ~100-200ms)

**Core:**
- `ollama_classify(text, labels, allow_none?, threshold?)` — Instant, sub-second warm
- `ollama_triage_logs(log_text)` — Instant, stable shape {errors, warnings, suspected_root_cause}
- `ollama_summarize_fast(text, max_words?)` — Instant
- `ollama_summarize_deep({text | source_paths}, focus?, max_words?)` — Deep, returns coverage report on multi-source
- `ollama_draft(prompt, language?, style?, target_path?, confirm_write?)` — Workhorse, compile check rides envelope
- `ollama_extract(text, schema)` — Workhorse, `{ok, data}` or `{ok: false, error: "unparseable"}`

**Corpus management:**
- `ollama_corpus_index(name, paths[], chunk_chars?, chunk_overlap?)` — idempotent by sha256
- `ollama_corpus_list()` — no Ollama call, just reads corpus dir

**Low-level + last resort:**
- `ollama_embed(input)` — raw vectors for external indexes. Not for normal Claude use.
- `ollama_chat(messages)` — last resort. Specialty tools always beat it when one fits.

---

## How to use it

### Config in `.mcp.json`
```json
{
  "mcpServers": {
    "ollama-intern": {
      "command": "node",
      "args": ["F:/AI/ollama-intern-mcp/dist/index.js"],
      "env": {
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}
```

### Profiles
- **`dev-rtx5080`** (default) — Qwen ladder: 7b / coder-7b / 14b / nomic. Instant prewarm ON. Instant timeout 15s.
- **`dev-rtx5080-llama`** — parity rail: same Instant+Workhorse, llama3.1:8b on Deep.
- **`m5-max`** — prod target: 14b / coder-32b / llama3.3:70b / nomic. No prewarm. Instant timeout 5s.

### Logs
NDJSON at `~/.ollama-intern/log.ndjson`. Event kinds: `call`, `timeout`, `fallback`, `guardrail`, `prewarm`. Every call line carries `hardware_profile` so benchmarks can filter dev numbers out of publishable tables.

### Corpora
JSON at `~/.ollama-intern/corpora/<name>.json`. Currently indexed: `memory` (15 seed files from the adoption smoke; can be expanded). Search drift-guarded: refuses if corpus model_version doesn't match active embed tier.

---

## Adoption doctrine (earned in use, not guessed)

1. **Logs** → `ollama_triage_logs` before any grep.
2. **Long files** → `ollama_summarize_deep({ source_paths })` not `{ text }`.
3. **Semantic recall** over memory/canon/doctrine → `ollama_corpus_search`.
4. **Specific-question grounding** → `ollama_research({ source_paths })` — pick paths that actually contain the answer. Bad sources produce confident-wrong digests.
5. **Draft code** → `ollama_draft({ language: ... })` trusts compile check.
6. **Bulk structured extraction** → `ollama_extract` is the strongest tool by cost/value.
7. **Chat** → only when no specialty tool fits; usage should stay rare.

---

## Known limits / open seams

- `summarize_fast` still takes `text` only — follow-up, not blocking.
- Deep 14B rarely produces a citations block — `research.citations` often empty even with well-grounded answers (not a product bug, a model-prompt signal).
- 3 parallel Instant calls on RTX 5080 with a Deep call in flight can push one past 15s — cap at 2 concurrent or expect retries.
- Corpus search precision is good for topic queries, weaker on specific-fact queries (nomic-embed limit; paragraph-aware chunking is a future win).
- `residency` is `null` for embed models — they don't show up in `/api/ps`.

---

## Queued work (next session picks up here)

### Phase D — Batch inputs on trusted tools
`classify`, `extract`, `triage_logs` earn habit in bulk. Add batch mode as a shape change, not new tools:
- `classify({ text: string | string[], ... })` → array of `{label, confidence}` on array input
- Same for extract + triage

### Phase E — Real eval pack with quality-floor assertions
Upgrade `evals/gold/*.jsonl` from seed cases to real assertions: grounded answers, citation validity, coverage enforced, compile-check truth, schema conformance under messy input, embed byte budget.

### M5 Max arrival (~2026-04-24)
Run `bench/run.py` for real prod-profile numbers. The harness is scaffolded; fill in `run_cell()` + `run_concurrency_test()` per the TODO docstrings.

### Later candidates (not this cycle)
- SQLite corpus backend when a corpus exceeds ~10K chunks
- Paragraph-aware chunker (replace fixed-window) for better search precision
- OpenClaw integration (see `memory/openclaw-roadmap.md`) — start only after this product's Phase D+E land

---

## Verification commands (run these to check you're in a known-good state)

```bash
# Ollama alive?
curl -s http://127.0.0.1:11434/api/version

# MCP connects?
cd F:/AI && claude mcp list | grep ollama-intern   # should be ✓ Connected

# Full local verify (~1s)
cd F:/AI/ollama-intern-mcp && npm run verify
# Expected: 140 tests passing across 20 files, tsc clean, build clean

# Live smoke across all categories
cd F:/AI/ollama-intern-mcp && OLLAMA_HOST=http://127.0.0.1:11434 node smoke/live.mjs
# (there are also smoke/targeted.mjs, smoke/seams.mjs, smoke/coverage.mjs, smoke/corpus.mjs for focused checks)
```

---

## Deep reads for context

- **Thesis + anti-drift laws:** `memory/ollama-intern-mcp-handoff.md` §0 (do not soften)
- **Current state (this session's ship):** `memory/ollama-intern-state-2026-04-17.md`
- **First adoption pass observations:** `memory/ollama-intern-adoption-pass-2026-04-16.md`
- **OpenClaw roadmap (parked):** `memory/openclaw-roadmap.md`
- **Cross-cutting feedback laws that shaped this:** `memory/feedback_phase_hardening_not_soul.md`
