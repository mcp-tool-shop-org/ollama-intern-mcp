---
title: Envelope & Tiers
description: Uniform envelope, tier model, hardware profiles, residency.
sidebar:
  order: 3
---

## Every tool returns the same envelope

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

The envelope is the audit trail. Every call shows what tier it used, which model served it, how long it took, and whether the model was resident in VRAM.

## The four tiers

| Tier | Job shape | Token budget | Typical tool |
|---|---|---|---|
| **Instant** | Short, stable-shape classification/triage | 5s timeout | `classify`, `triage_logs`, `summarize_fast` |
| **Workhorse** | Code/prose drafting, schema-constrained extraction | 20s timeout | `draft`, `extract`, `chat` |
| **Deep** | Long-input synthesis, chunk-grounded answers | 90s timeout | `research`, `summarize_deep`, `corpus_answer`, briefs, packs |
| **Embed** | Vectors only | — | `embed`, `embed_search`, corpus index/refresh/search |

Tiers are picked by the tool, not by Claude. Pick the job; the tier follows.

## Hardware profiles

| Profile | Instant | Workhorse | Deep | Embed |
|---|---|---|---|---|
| `dev-rtx5080` (default) | qwen3 8B | qwen3 8B | qwen3 14B | nomic-embed-text |
| `m5-max` | qwen3 14B | qwen3 32B | **llama4:scout** | nomic-embed-text |

The default dev profile keeps the same Qwen family top-to-bottom so bad outputs are tool/design problems, not cross-family mismatches. Workhorse stays on qwen3:8b until a quantized Qwen3-Coder MoE variant fits 16GB VRAM comfortably. The M5 Max deep slot promotes to Llama 4 Scout (109B-total / 17B-active MoE); the formatter layer branches on model family because Llama 4 uses a different chat template (`<|header_start|>` / `<|eot|>`) than Llama 3.x.

The former `dev-rtx5080-llama` profile was retired on 2026-04-18 — Llama 3.1 8B is obsolete and Llama 4 Scout doesn't fit 16GB VRAM.

Qwen 3 requires `think: false` on short-output shapes (classify / extract / triage / summarize-fast) — enforced automatically by `THINK_BY_SHAPE` in `src/tiers.ts`. Without it, thinking tokens consume `num_predict` and the response comes back empty.

## Residency — reading `/api/ps`

Ollama pages models to disk silently when VRAM is tight. Inference drops 5–10× when this happens, and the only signal is in `/api/ps`. The envelope carries that signal:

- `residency.in_vram: false` — not loaded
- `residency.evicted: true` — was loaded, paged out
- `residency.size_vram_bytes < residency.size_bytes` — partially resident

When you see any of these during a slow call, trim `OLLAMA_MAX_LOADED_MODELS` or restart Ollama. This is the main way production slowdowns sneak in.

## The NDJSON log

Every call is logged as one line of NDJSON to `~/.ollama-intern/log.ndjson`:

```json
{"kind":"call","ts":"2026-04-18T12:00:00Z","tool":"ollama_classify","envelope":{"tier_used":"instant","model":"qwen3:8b","hardware_profile":"dev-rtx5080","tokens_in":87,"tokens_out":12,"elapsed_ms":340,"residency":{"in_vram":true,"evicted":false}}}
```

No prompts are logged. No inline text is logged. Just the envelope. Nothing leaves the box.

Filter by `hardware_profile` to keep dev numbers out of publishable benchmark tables — bench scripts already do this.

## One-tier overrides

Env vars beat profile picks for one-off swaps:

| Env var | Example |
|---|---|
| `INTERN_TIER_INSTANT` | `qwen3:8b` |
| `INTERN_TIER_WORKHORSE` | `qwen3:8b` |
| `INTERN_TIER_DEEP` | `qwen3:14b` |
| `INTERN_EMBED_MODEL` | `nomic-embed-text` |
