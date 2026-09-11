# smoke/ — manual rig rituals

These are **not** part of `npm test`, `npm run verify`, or any workflow. Nothing
in the repo invokes them; they are hand-run proofs against a live rig, kept
because a real model answering a real call proves something the mocked suite
cannot.

## Prerequisites

1. **A live Ollama** at `OLLAMA_HOST` (default `http://127.0.0.1:11434`) with
   the active profile's models pulled — check with `node dist/index.js doctor`.
2. **A built `dist/`** — every script imports from `../dist/*.js`:
   ```
   npm run build
   ```

Then run one by path:

```
node smoke/live.mjs
```

## The scripts

| Script | What it does | Notes |
| --- | --- | --- |
| `live.mjs` | Calls the **9 atom handlers** (triage_logs, summarize_fast, summarize_deep, research, draft, embed, classify, extract, chat) and prints envelopes, guardrail proofs, and the NDJSON log tail. | Covers the delegation spine, **not** the 44-tool surface. The full surface is pinned by `tests/mcpGolden.test.ts`, which needs no live model. |
| `corpus.mjs` | Index → re-index (idempotency) → list → search, end to end. | ⚠ **Writes to your home directory.** It indexes ~15 `.md` files from `~/.claude/projects/F--AI/memory` and creates a corpus named `memory` under the corpus dir. Point it somewhere harmless with `OLLAMA_INTERN_MEMORY_DIR=/path/to/docs`. |
| `coverage.mjs` | Reproduces the multi-source omission bug (`summarize_deep` silently covering only the first file) and shows the coverage contract catching it. | Reads the same memory dir; honours `OLLAMA_INTERN_MEMORY_DIR`. Read-only. |
| `seams.mjs` | 5 `summarize_deep` + 5 `embed_search` calls via `source_paths`, asserting the responses stay sub-KB — the context-saving thesis. | Reads the same memory dir; honours `OLLAMA_INTERN_MEMORY_DIR`. Read-only. |
| `targeted.mjs` | **Retired one-off.** The 5 calls that failed in one early debugging pass (Instant-tier 5s timeouts on an RTX 5080, an npx invocation bug in `draft`). | Kept only as a record of that pass. It is not a general smoke — do not treat a pass here as coverage of anything. |

## Environment

| Variable | Effect |
| --- | --- |
| `OLLAMA_HOST` | Ollama base URL. |
| `INTERN_PROFILE` | Which model ladder to run (`dev-rtx5080`, `dev-rtx5080-qwen3`, `m5-max`). `live.mjs` and `targeted.mjs` were written against `dev-rtx5080`. |
| `OLLAMA_INTERN_MEMORY_DIR` | Source directory for `corpus.mjs`, `coverage.mjs`, `seams.mjs`. Set it — the default points at the author's notes. |
