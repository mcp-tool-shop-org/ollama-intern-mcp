---
title: Ollama Cloud (optional)
description: Opt-in cloud-primary routing — run the generative tiers on a 600B-class Ollama Cloud model with automatic local fallback. Off by default, zero egress until you set a key.
sidebar:
  order: 7
---

Local 8B models are the hardware bottleneck most people hit. [Ollama Cloud](https://ollama.com/cloud) serves 600B-class models behind the **same** `/api/*` surface, so you can route the heavy tools to a far stronger model and free up local VRAM — while keeping local as an always-on fallback.

:::caution[Opt-in, off by default]
The package stays **local-first with zero network egress** unless you set **both** `OLLAMA_CLOUD_PRIMARY=1` and `OLLAMA_API_KEY`. Anyone who doesn't opt in is unaffected. Embeddings **always** stay local.
:::

## Enable it

Set the two vars in your MCP client's `env` block (Claude Code shown):

```json
{
  "mcpServers": {
    "ollama-intern": {
      "command": "npx",
      "args": ["-y", "ollama-intern-mcp"],
      "env": {
        "OLLAMA_CLOUD_PRIMARY": "1",
        "OLLAMA_API_KEY": "sk-...your-key...",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}
```

:::tip[The key is a runtime env var, not a CI secret]
A GitHub Actions secret only exists inside CI runs — it never reaches the running server. Create a key at [ollama.com/settings/keys](https://ollama.com/settings/keys) and put it in your MCP client's `env` block (or your shell environment).
:::

## How routing works

When cloud is on, the generative tiers (instant / workhorse / deep) go to the cloud model; **embeddings always stay local** (Ollama Cloud serves no embedding models, so the corpus/embed tools are unaffected). A circuit breaker decides the backend per call:

- **Healthy** → cloud serves the call.
- **Transient cloud failure** (timeout / 5xx / 429 / network) → fall back to the local profile, breaker counts the failure. After 3 consecutive failures it opens for 20s, then admits a single probe.
- **Bad key** (401/403) → a *sticky* "misconfigured" breaker surfaces the failure loudly instead of degrading silently forever.
- **Retired/typo'd model id** (404) → surfaced, not silently swapped for a local model.

The local profile (`INTERN_PROFILE`) is the fallback ladder, so keep its models pulled. Backend resolution happens first (a near-instant breaker check), then the existing tier-degradation runs *within* the chosen backend — the two never chain into a slow timeout ladder.

## You're never silently downgraded

Every [envelope](./envelope-and-tiers/) reports which backend served the call:

```ts
{
  ...envelope,
  backend: "cloud" | "local",
  degraded?: true,
  degrade_reason?: "cloud_timeout" | "cloud_5xx" | "cloud_rate_limited"
                 | "cloud_unreachable" | "cloud_auth_failed" | "circuit_open"
}
```

`residency` is `null` for cloud-served calls (the stateless cloud has no local-VRAM residency). A `backend_fallback` line lands in `~/.ollama-intern/log.ndjson` on every cloud→local fallback — watch the **rate**, not just per-call state:

```bash
ollama_log_tail --filter_kind backend_fallback
```

`ollama-intern-mcp doctor` shows a **Cloud (primary)** block with reachability + auth status. Note: cloud `/api/tags` lists public models without gating on the key, so doctor reports `auth: unverified (checked on first call)` until a real call validates the key (a bad key then trips the sticky breaker).

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `OLLAMA_CLOUD_PRIMARY` | _(unset)_ | **The opt-in switch.** `1`/`true`/`yes`/`on` enables cloud-primary. Unset = local-only, zero egress. |
| `OLLAMA_API_KEY` | _(unset)_ | Bearer key for Ollama Cloud. **Required** when cloud is enabled (fail-fast at startup if missing). |
| `OLLAMA_CLOUD_HOST` | `https://ollama.com` | Cloud base host. |
| `INTERN_CLOUD_MODEL` | `minimax-m3:cloud` | Cloud model for instant + workhorse + deep. |
| `INTERN_CLOUD_DEEP_MODEL` | _(= `INTERN_CLOUD_MODEL`)_ | Optional deep-tier-only override, e.g. `deepseek-v3.1:671b`. |
| `INTERN_CLOUD_TIMEOUT_{INSTANT,WORKHORSE,DEEP}_MS` | `30000` / `120000` / `300000` | Per-tier cloud-attempt timeouts. |
| `INTERN_CLOUD_NUM_CTX` | `32768` | Context-window cap for cloud calls (cloud bills by GPU-time; the cap controls cost). |

:::note[Model availability changes]
Ollama periodically retires cloud models. `minimax-m3:cloud`, `deepseek-v3.1:671b`, `gpt-oss:120b`, and `qwen3-coder:480b` are current picks; check [ollama.com/search?c=cloud](https://ollama.com/search?c=cloud) before pinning an id.
:::

## Latency vs quality

Big cloud models run far slower per token than a local 8B (seconds, not milliseconds) — a **quality** upgrade, not a speed one. That's why the cloud tiers use a generous timeout ladder (instant 30s / workhorse 120s / deep 300s). If short `classify`/`extract` calls feel sluggish, set `INTERN_CLOUD_MODEL` to a smaller-but-fast cloud model, or keep cloud for the heavy tiers only.

## Privacy

Routing to Ollama Cloud sends prompts to a third party. Ollama's [privacy policy](https://ollama.com/privacy) states cloud prompts are processed transiently, not retained beyond the request, and not used for training — but it is still egress, which is why it's opt-in and disclosed. Local-only mode (the default) sends nothing off the box. See [SECURITY.md §11](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md) for the full threat-model entry.
