---
title: Corpora
description: Build, refresh, search, and answer over a living corpus — manifest schema v2, drift detection, path safety.
sidebar:
  order: 4
---

A **corpus** is a persistent, indexed view of a directory tree. It lives on disk under `~/.ollama-intern/corpora/<name>/`, carries a manifest of its intent, and can be searched lexically (BM25), vector (embed), or fused (RRF).

Four tools cover the lifecycle:

| Tool | Tier | Job |
|---|---|---|
| `ollama_corpus_index` | Embed | Build or rebuild a corpus from a root directory. |
| `ollama_corpus_refresh` | Embed | Reconcile an existing corpus against disk using its manifest. |
| `ollama_corpus_search` | Embed | Lexical + vector search with RRF fusion. |
| `ollama_corpus_answer` | Deep | Chunk-grounded synthesis — every claim cites a chunk id. |
| `ollama_corpus_list` | — | Metadata-only index of corpora on disk. |

## The manifest is the source of truth

Every corpus has a `<name>.manifest.json` alongside its chunk file. The manifest declares:

- `paths[]` — the roots indexed (directories or files)
- `embed_model` — the model name the caller asked for (e.g. `nomic-embed-text`)
- `embed_model_resolved` — what Ollama actually resolved that tag to at index time (schema v2, added in v2.0.0)
- `chunk_size`, `chunk_overlap` — chunking params
- `schema_version`, `schema_version_written_by` — forward-compat guard

Refresh reads this manifest and reconciles it against disk. The manifest is the intent; disk is the reality; refresh reports the drift.

## Schema v2 and `:latest` drift detection

When a manifest is loaded as v1 (no `embed_model_resolved`), the server migrates it in memory — the field stays `null` until the next embed call supplies a value.

The interesting case: you indexed under `nomic-embed-text:latest`, Ollama pulled a new `latest` tag last week, and now your embeddings come from a different model. `ollama_corpus_refresh` surfaces this as:

```jsonc
{
  "embed_model_resolved_drift": {
    "prior": "nomic-embed-text@sha256:abc123…",
    "current": "nomic-embed-text@sha256:def456…"
  }
}
```

Report-only in v2.0.x — no forced re-embed. When you see drift, re-run `ollama_corpus_index` if you want uniform vector space; reused chunks are from the prior model and mixing is OK for BM25 but degrades vector ranking.

## Indexing — partial failure by design

`ollama_corpus_index` does not halt on a single bad file. One unreadable file in 1000 doesn't abort the pass — instead the report carries:

```jsonc
{
  "chunks_written": 847,
  "paths_indexed": 999,
  "failed_paths": [{ "path": "corpus/root/broken.bin", "reason": "binary blob — not utf8" }]
}
```

Writes are atomic: the indexer writes `<file>.tmp` then `rename`s. A crash mid-write leaves the prior corpus intact.

Symlinks are refused up front with `SYMLINK_NOT_ALLOWED` (lstat check before read) — defends against size-cap bypass + TOCTOU.

## Path safety — `INTERN_CORPUS_ALLOWED_ROOTS`

Corpus tools refuse to read outside a caller-declared allow-list:

```bash
export INTERN_CORPUS_ALLOWED_ROOTS="/home/you/projects:/srv/docs"
```

Paths are validated with `path.relative` (authoritative containment, Windows-safe) plus a pre-normalize `..` reject as defence-in-depth. Any `source_paths` entry outside the allowed roots returns `SOURCE_PATH_NOT_FOUND`. The env var is read at server start — restart the server after changing it.

## Per-corpus lock

A per-corpus file lock wraps index / refresh / answer writes. Two callers racing on the same corpus queue up rather than clobber each other's manifest. The lock is advisory within a single server process — if you run two MCP servers against the same corpus dir, they compete. Don't.

## Workflow — build, refresh, answer

A full pass from zero to grounded answer:

```jsonc
// 1. Build the corpus from your project roots.
{
  "tool": "ollama_corpus_index",
  "arguments": {
    "name": "sprite-foundry",
    "paths": ["F:/AI/sprite-foundry/src", "F:/AI/sprite-foundry/docs"],
    "embed_model": "nomic-embed-text"
  }
}
// → chunks_written: 1204, paths_indexed: 312, failed_paths: []

// 2. Later — pick up new / changed files without a full reindex.
{
  "tool": "ollama_corpus_refresh",
  "arguments": { "name": "sprite-foundry", "embed_model": "nomic-embed-text" }
}
// → added: 3, changed: 11, unchanged: 298, deleted: 0, no_op: false

// 3. Ask an evidence-bound question.
{
  "tool": "ollama_corpus_answer",
  "arguments": {
    "name": "sprite-foundry",
    "query": "how does the worker handle the OOM eviction path?",
    "top_k": 8
  }
}
// → { answer: "...", citations: [{chunk_id: "...", path: "src/worker.ts"}, ...], weak: false }
```

Every claim in `answer` cites a chunk id. If retrieval comes up empty, the answer is short and `weak: true` — never a smoothed narrative.

## Common gotchas

- **Refusing to refresh with a different embed model.** The manifest pins `embed_model`; calling refresh with a different one errors. Re-index instead.
- **Mixed vector spaces.** If you see `EMBED_DIMENSION_MISMATCH` on search, the corpus was built under a different embed model than the one live now. Re-index.
- **Empty allowed roots.** An unset `INTERN_CORPUS_ALLOWED_ROOTS` means *nothing* is allowed, not *everything*. Set it explicitly.
- **`:latest` surprise.** Ollama updates `:latest` tags silently. Pin a specific digest in the manifest if you want stable embeddings across weeks.

## Related

- [Tool reference](../tools/) — full schemas for each corpus tool
- [Error codes](../error-codes/) — `SOURCE_PATH_NOT_FOUND`, `SYMLINK_NOT_ALLOWED`, `EMBED_DIMENSION_MISMATCH`, `SCHEMA_INVALID`
- [Security & threat model](../security/) — path-traversal and symlink threat mitigations
