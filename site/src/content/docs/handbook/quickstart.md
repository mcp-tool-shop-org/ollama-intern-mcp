---
title: Quickstart — Your first 5 minutes
description: From install to first artifact in five minutes — install, start Ollama, build a corpus, run corpusAnswer, export the artifact, view it on disk.
sidebar:
  order: 1
  badge:
    text: Start here
    variant: tip
---

This is the shortest path from "nothing installed" to "an artifact on disk you
can read." End-to-end target: **five minutes**, assuming you already have
Ollama running.

If you want the full prerequisite walkthrough (hardware sizing, profile picks,
Claude Desktop config), see [Getting Started](../getting-started/) — this page
is the compressed version for someone who just wants to see it work.

---

## Step 1 — Make sure Ollama is alive (30 seconds)

```bash
# Is the daemon listening?
curl -sS http://127.0.0.1:11434/api/tags | head -c 80
```

Expected: a JSON response. If you get `Connection refused`, start the daemon:

```bash
ollama serve         # foreground; or:
brew services start ollama   # macOS
```

Pull the two models the default profile uses:

```bash
ollama pull hermes3:8b
ollama pull nomic-embed-text
```

These are the `dev-rtx5080` ladder. If you're on a Mac with the M5 Max,
substitute `INTERN_PROFILE=m5-max` later — it swaps the ladder to heavier
Qwen 3 tiers.

---

## Step 2 — Wire ollama-intern-mcp into Claude Code (1 minute)

Add this block to your Claude Code MCP server config (no global install needed
— `npx` fetches and runs the server on demand):

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

Restart Claude Code so it re-reads the config.

---

## Step 3 — Run `ollama_doctor` (the smallest possible call) (30 seconds)

In Claude Code, ask:

> Use the ollama-intern `ollama_doctor` tool. Show me the envelope.

You should see:

```jsonc
{
  "result": {
    "ollama":  { "reachable": true, "host": "http://127.0.0.1:11434" },
    "models":  {
      "required": ["hermes3:8b", "nomic-embed-text"],
      "pulled":   ["hermes3:8b", "nomic-embed-text", "..."],
      "loaded":   [],
      "missing":  []
    },
    "profile": { "name": "dev-rtx5080", "tiers": { "instant": "hermes3:8b", "...": "..." } },
    "healthy": true
  },
  "tier_used": "instant",
  "model": "hermes3:8b",
  "elapsed_ms": 12,
  "...": "..."
}
```

`healthy: true` means the box is wired correctly. If anything is wrong,
`doctor` tells you exactly what's missing — go fix it before continuing.
This is the call you make on every session start.

**If you see `healthy: false`:** check `models.missing` first. Most "doctor
says unhealthy" reports are an `ollama pull` you forgot.

---

## Step 4 — Build a corpus from a directory (1 minute)

Pick a small docs directory you have on disk — even a folder of three
markdown files works. Then ask Claude Code:

> Use `ollama_corpus_index` on `/path/to/your/docs`. Name the corpus `myfirst`.

You'll get back an envelope like:

```jsoncon
{
  "result": {
    "corpus_id":     "myfirst",
    "chunks_indexed": 47,
    "embed_model":    "nomic-embed-text",
    "duration_ms":    8120
  },
  "tier_used": "embed",
  "...":      "..."
}
```

The corpus and its chunk store now live under
`~/.ollama-intern/corpora/myfirst/`. It survives reboots; you only re-index
when the underlying files change (and there's `corpus_refresh` for that).

---

## Step 5 — Ask the corpus a question (1 minute)

> Use `ollama_corpus_answer` on the `myfirst` corpus. Question: "What
> does this project do?"

The envelope comes back with a synthesized answer plus per-claim citations
that point at the chunk ids the model actually grounded on:

```jsonc
{
  "result": {
    "answer": "...",
    "citations": [
      { "chunk_id": "abc123", "source_path": "/path/to/docs/intro.md", "score": 0.81 },
      { "chunk_id": "def456", "source_path": "/path/to/docs/usage.md", "score": 0.74 }
    ],
    "weak":      false,
    "abstained": false
  },
  "tier_used": "deep",
  "...":      "..."
}
```

If the corpus didn't address your question, the tool returns
`abstained: true` with an empty answer rather than smoothing a fake
narrative — that's the [abstention contract](../laws/) at work.

---

## Step 6 — Run an `incident_pack` and see the artifact on disk (1 minute)

Briefs and atoms return JSON to Claude. Packs go further: they write a
durable artifact to disk you can open later. Try:

> Use `ollama_incident_pack`. Title: "first run". Logs:
> "[05:07] worker-3 OOM killed". source_paths: [].

After the pack runs, look on disk:

```bash
ls ~/.ollama-intern/artifacts/incident/
# 2026-05-15-first-run.md
# 2026-05-15-first-run.json
```

Open the `.md` file. That's your artifact — a deterministic-rendered
markdown report with a citations block, a `weak` flag, and `next_checks`
the model wants you to investigate. **Code rendered it, not a prompt.** It
will look exactly the same shape every time.

---

## What just happened

In ~5 minutes you ran a tool from each tier:

| Tier | Tool | What it produced |
|---|---|---|
| Atom | `ollama_doctor`     | Status snapshot (`healthy: true`) |
| Atom | `ollama_corpus_index`  | A persistent corpus on disk |
| Atom | `ollama_corpus_answer` | A grounded answer with citations |
| Pack | `ollama_incident_pack` | A durable markdown artifact |

You can now:

- List artifacts: `ollama_artifact_list`
- Re-read one without re-running the pack: `ollama_artifact_read`
- Diff two artifacts of the same pack: `ollama_artifact_diff`
- Tail the NDJSON log: `ollama_log_tail` (or `tail -f ~/.ollama-intern/log.ndjson`)

---

## Common pitfalls

**`healthy: false` from doctor with `models.missing` populated.** Run
`ollama pull <model>` for each missing model. The default `dev-rtx5080`
profile needs `hermes3:8b` + `nomic-embed-text`.

**`SCHEMA_INVALID` on a tool call.** You passed an arg the schema didn't
accept. The error `details` field tells you the field name and the expected
shape — fix and retry.

**`PATH_NOT_ALLOWED`.** A tool tried to read or write outside
`INTERN_ALLOWED_ROOTS`. Either the path is wrong, or you need to extend
the allow-list. See [Security](../security/).

**Empty `citations[]` with `abstained: true`.** Not a bug — the corpus
or the source files didn't address your question well enough. Either
expand the corpus, supply better `source_paths`, or accept the abstention.

**Long elapsed_ms on the first call.** Cold-start prewarm cost. Subsequent
calls in the same tier reuse the resident model.

---

## Where to go next

- **[Tool reference](../tools/)** — all 41 tools grouped by tier
- **[Per-tool pages](../tools/)** — schema + example + pitfalls for the
  most-used tools
- **[Envelope & tiers](../envelope-and-tiers/)** — every field of the
  uniform envelope, hardware profile knobs
- **[Artifacts & continuity](../artifacts/)** — how packs use the disk
- **[Laws & guardrails](../laws/)** — evidence-first, weak-is-weak,
  deterministic renderers
- **[Observability](../observability/)** — read the NDJSON log,
  `ollama_log_tail`, jq recipes
