---
title: Ollama Cloud
description: Run the same 44 job-shaped tools on 600B-class models when local VRAM is the ceiling — per-call escalation or cloud-primary, always with automatic local fallback. Off by default, zero egress until you set a key.
sidebar:
  order: 7
---

**The hardware ceiling, lifted.** A local 8B is what most machines can actually hold, and it is the bottleneck nearly everyone hits — not budget, not interest, just VRAM. [Ollama Cloud](https://ollama.com/cloud) serves 600B-class models behind the **same** `/api/*` surface, so the heavy tools run on a frontier model and your VRAM goes back to whatever else needs it. Local stays the always-on fallback, so you gain a ceiling without losing the floor.

:::caution[Opt-in, off by default]
With no key set, the package stays **local-first with zero network egress** — anyone who doesn't opt in is unaffected. Setting **both** `OLLAMA_CLOUD_PRIMARY=1` and `OLLAMA_API_KEY` enables **cloud-primary**; setting **only** `OLLAMA_API_KEY` arms **[standby](#cloud-standby--per-call-escalation)** (still local-primary, still zero egress, until a call explicitly escalates). Embeddings **always** stay local.
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

`ollama-intern-mcp doctor` shows a **Cloud (primary | standby)** block with the mode, reachability, and auth status. Note: cloud `/api/tags` lists public models without gating on the key, so doctor reports `auth: unverified (checked on first call)` until a real call validates the key (a bad key then trips the sticky breaker).

## Cloud standby & per-call escalation

*(v2.9)* Cloud-primary is all-or-nothing: every generative call tries cloud first. **Standby** is the per-call middle ground, grounded in the routing literature (per-invocation decisions beat static per-tool policy — RouteLLM):

1. Set **only** `OLLAMA_API_KEY` (leave `OLLAMA_CLOUD_PRIMARY` unset).
2. Everything runs local, exactly as before — the server doesn't even probe the cloud host at startup, so a globally-exported key never causes boot-time egress.
3. A single call escalates by passing `backend: "cloud"` — exposed on [`ollama_chat`](./tools/chat/), and used internally by [`ollama_verify_claims`](./tools/verify-claims/) for its juror calls.

Escalated calls get the full cloud machinery: breaker gating, local fallback with an honest `degrade_reason`, envelope `backend` provenance, and the cloud `num_ctx` cap. The **first** escalation in a standby process prints a loud stderr disclosure naming the host and writes a `cloud_egress` NDJSON event — egress is disclosed **at the point it happens**, not just on this page.

Mechanically enforced rules:

- **No key →** `backend: "cloud"` fails with `CLOUD_NOT_CONFIGURED`. Never silently served local while claiming escalation.
- **Standby + no directive →** local, zero egress.
- **Cloud-primary + `backend: "local"` →** pins that one call local (the inverse escape hatch, e.g. for a privacy-sensitive call).
- **Per-call `model` + cloud →** the override is the model actually sent to cloud (it used to be clobbered by the tier map), so per-call flagship selection works — the mechanism `verify_claims` builds its panel on.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `OLLAMA_CLOUD_PRIMARY` | _(unset)_ | **The cloud-primary switch.** `1`/`true`/`yes`/`on` routes the generative tiers to cloud. Unset with a key = **standby** (local-primary, per-call escalation only). Unset without a key = local-only, zero egress. |
| `OLLAMA_API_KEY` | _(unset)_ | Bearer key for Ollama Cloud. Setting it alone arms **standby**; **required** when `OLLAMA_CLOUD_PRIMARY` is enabled (fail-fast at startup if missing). |
| `OLLAMA_CLOUD_HOST` | `https://ollama.com` | Cloud base host. |
| `INTERN_CLOUD_MODEL` | `qwen3-coder-next:cloud` | Cloud model for instant + workhorse + deep. Keep the default **non-thinking** — a thinking model here burns short-output `num_predict` budgets on CoT and returns empty replies; put big reasoners on the deep override below. |
| `INTERN_CLOUD_DEEP_MODEL` | _(= `INTERN_CLOUD_MODEL`)_ | Optional deep-tier-only override, e.g. `deepseek-v3.1:671b`. |
| `INTERN_CLOUD_TIMEOUT_{INSTANT,WORKHORSE,DEEP}_MS` | `30000` / `120000` / `300000` | Per-tier cloud-attempt timeouts. |
| `INTERN_CLOUD_NUM_CTX` | `32768` | Context-window cap for cloud calls (cloud bills by GPU-time; the cap controls cost). |

:::note[Model availability changes]
Ollama rotates/retires cloud ids server-side. As of 2026-07, `qwen3-coder-next:cloud` (non-thinking default) and the thinking flagships `deepseek-v4-pro:cloud` / `kimi-k2.7-code:cloud` / `glm-5.2:cloud` are current; check [ollama.com/search?c=cloud](https://ollama.com/search?c=cloud) before pinning an id. A retired id degrades visibly (`cloud_model_missing`), never silently.
:::

## Latency vs quality

Big cloud models run far slower per token than a local 8B (seconds, not milliseconds) — a **quality** upgrade, not a speed one. That's why the cloud tiers use a generous timeout ladder (instant 30s / workhorse 120s / deep 300s). If short `classify`/`extract` calls feel sluggish, set `INTERN_CLOUD_MODEL` to a smaller-but-fast cloud model, or keep cloud for the heavy tiers only.

## Privacy

Routing to Ollama Cloud sends prompts to a third party. Ollama's [privacy policy](https://ollama.com/privacy) states cloud prompts are processed transiently, not retained beyond the request, and not used for training — but it is still egress, which is why it's opt-in and disclosed. Local-only mode (the default) sends nothing off the box. See [SECURITY.md §11](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md) for the full threat-model entry.
