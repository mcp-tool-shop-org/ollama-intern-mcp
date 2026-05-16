---
title: ollama_chat
description: LAST RESORT chat-shape tool — visibly second-class. Tier&#58; Workhorse.
sidebar:
  order: 90
  badge:
    text: Last resort
    variant: caution
---

{/* PER-TOOL REFERENCE TEMPLATE
    Each tool page in this directory follows the same shape:
      1. One-line job description (name what intern-job this names)
      2. Tier + when-to-use
      3. Schema — derived from src/tools/<tool>.ts (zod)
      4. Example call + envelope
      5. Common pitfalls
      6. Related tools
    Keep it under ~200 lines. The full tier-grouped overview lives at ../.
*/}

`ollama_chat` is the catch-all for ad-hoc model interaction. **It is visibly
last-resort by design.** If you find yourself reaching for `chat` more than
once a session, a specialty tool is missing — file a feature request rather
than rely on `chat` as your normal entrypoint.

## Tier — Workhorse

`hermes3:8b` on the default `dev-rtx5080` profile. The Workhorse tier shape
budget is ~4–8k tokens per turn (per `TierConfig.num_ctx` for your profile).

## When to use it

- One-off prose generation that doesn't fit any specialty tool
- Light back-and-forth where structured output would be overkill
- Bridge calls where a future feature will replace this with a job-shaped tool

## When NOT to use it

- **Classification** → `ollama_classify` (gives you confidence + threshold + frame)
- **Extraction** → `ollama_extract` (schema-constrained JSON, no parse errors)
- **Reading a corpus** → `ollama_corpus_answer` (chunk-grounded citations)
- **Reading specific files** → `ollama_research` (path-grounded citations)
- **Producing an artifact** → packs (`incident_pack` / `repo_pack` / `change_pack`)

## Schema

```ts
{
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;       // min 1 char
  }>;                      // min 1 message
  system?: string;         // optional preface, merged with any system messages
  model?: string;          // per-call model override (advanced — use sparingly)
}
```

Full source: `src/tools/chat.ts`.

## Example call

```jsonc
{
  "tool": "ollama_chat",
  "arguments": {
    "messages": [
      { "role": "user", "content": "Summarize this commit message in one sentence: 'feat(corpus): surface :latest drift on refresh'" }
    ]
  }
}
```

Returns:

```jsonc
{
  "result": {
    "reply": "Adds drift detection to corpus refresh when the source path uses ':latest' tag resolution."
  },
  "tier_used": "workhorse",
  "model": "hermes3:8b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 38,
  "tokens_out": 24,
  "elapsed_ms": 920,
  "residency": { "in_vram": true, "evicted": false }
}
```

## Common pitfalls

**You're using `chat` to extract structured data.** Switch to
`ollama_extract` with a schema. `chat` reply is a free-form string — you
have to parse it yourself, and the parse will fail half the time.

**You're using `chat` to classify.** Switch to `ollama_classify`. It
gives you a confidence score, an `allow_none` escape, and a `threshold`
floor. `chat` does not.

**You're chaining 5+ `chat` turns.** That's a sign the job is bigger than
`chat` should handle — consider splitting into a `corpus_index` +
`corpus_answer` flow, or a `repo_brief` if you're trying to characterize
something.

**You're hitting context limits.** `chat` runs at the Workhorse tier's
`num_ctx`. For longer-form prose, reach for `ollama_summarize_deep`
(Deep tier, larger window).

## Related tools

- [`ollama_classify`](./classify/) — when the answer is one of N labels
- [`ollama_extract`](./extract/) — when the answer must conform to a JSON schema
- [`ollama_corpus_answer`](./corpus-answer/) — when the answer should be grounded in a corpus
- [`ollama_doctor`](./doctor/) — to gate session start on prerequisites
