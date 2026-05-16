---
title: ollama_classify
description: Single-label classification with confidence — Tier&#58; Instant. Batch-capable. Frame-bound (v2.2.0+).
sidebar:
  order: 10
---

`ollama_classify` is the Instant-tier label-picker. Give it text and a list
of candidate labels; it returns the best match plus a confidence score.

## Tier — Instant

Fast. `hermes3:8b` on the default profile, `num_ctx: 4096` for the
`dev-rtx5080` profile. Designed for high-throughput batch work.

## When to use it

- Routing tickets / logs / messages into a fixed taxonomy
- Spam / quality / sentiment-style binary or N-way classification
- Pre-filtering inputs before more expensive tools run

## When NOT to use it

- The labels are open-ended → `ollama_extract` with a string field
- You need extracted reasoning, not just a label → `ollama_extract`
- The text is a long file → use `source_path` mode (server reads it for you)

## Schema

```ts
{
  // Exactly one of {text, source_path, items} must be provided.
  text?:        string;       // single text, classified directly
  source_path?: string;       // server reads + classifies the file
  items?: Array<{
    id: string;               // caller-provided, unique within the batch
    text: string;
  }>;                          // batch mode

  labels:       string[];     // min 2; the model picks exactly one (or null)
  allow_none?:  boolean;      // if true, return label=null when conf < threshold
  threshold?:   number;       // 0..1; default 0.7
  frame?:       string;       // v2.2.0+ — what the classification is FOR; off-topic → null
  per_file_max_chars?: number; // bytes to read for source_path (default 40k)
  model?:       string;       // per-call model override (advanced)
}
```

Full source: `src/tools/classify.ts`.

## Example call (single)

```jsonc
{
  "tool": "ollama_classify",
  "arguments": {
    "text": "the build failed because the API returned 502",
    "labels": ["infra", "code", "user-error"]
  }
}
```

Envelope `result`:

```jsonc
{
  "label": "infra",
  "confidence": 0.93,
  "allow_none": false,
  "threshold": 0.7
}
```

## Example call (batch)

```jsonc
{
  "tool": "ollama_classify",
  "arguments": {
    "labels": ["bug", "feature-request", "question", "spam"],
    "items": [
      { "id": "t-001", "text": "login button does nothing on mobile Safari" },
      { "id": "t-002", "text": "can you add dark mode?" },
      { "id": "t-003", "text": "BUY NOW AMAZING CRYPTO DEAL" }
    ]
  }
}
```

Envelope `result`:

```jsonc
{
  "items": [
    { "id": "t-001", "ok": true, "result": { "label": "bug",             "confidence": 0.94 } },
    { "id": "t-002", "ok": true, "result": { "label": "feature-request", "confidence": 0.91 } },
    { "id": "t-003", "ok": true, "result": { "label": "spam",            "confidence": 0.97 } }
  ]
}
```

## Example call (frame-bound, v2.2.0+)

When `frame` is supplied, the model first decides whether the text is on-topic
for the frame, and returns `null` (with `off_topic: true`) if it's not — even
if a label would technically fit.

```jsonc
{
  "tool": "ollama_classify",
  "arguments": {
    "text": "this PR refactors the date-formatting utility",
    "labels": ["security-relevant", "not-security-relevant"],
    "frame": "Should this PR get a security review?"
  }
}
```

Returns `{ label: "not-security-relevant", confidence: 0.88, frame_alignment: { on_topic: true } }`.

## Common pitfalls

**`SCHEMA_INVALID` on duplicate ids in `items[]`.** Batch inputs require
unique caller-provided ids. Pick stable ids (e.g. row IDs from your DB).
There is no implicit dedup.

**Confidence below `threshold` returning a label anyway.** Set
`allow_none: true` to opt into the null-return-when-uncertain behavior.
Without it, the threshold is informational only.

**Using `text` for a 50K-char document.** Use `source_path` instead — the
server reads + truncates per `per_file_max_chars` (default 40k chars). You
save Claude context AND avoid the prompt-too-long error.

**Both `text` and `items` provided.** Returns `SCHEMA_INVALID`. Pick one
input mode per call.

## Related tools

- [`ollama_extract`](./extract/) — when you need a richer structured output
- [`ollama_corpus_answer`](./corpus-answer/) — when the labels need
  corpus-grounded reasoning
- See [Frame-bound extraction](../../README.md#frame-bound-extraction-new-in-v220)
  in the README for the topicality contract
