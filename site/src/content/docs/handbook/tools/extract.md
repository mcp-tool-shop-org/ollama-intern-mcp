---
title: ollama_extract
description: Schema-constrained JSON extraction — Tier&#58; Workhorse. Batch-capable. Frame-bound (v2.2.0+).
sidebar:
  order: 20
---

`ollama_extract` pulls structured fields out of free-form text. You provide
the JSONSchema; the model fills it in. Output is constrained to round-trip
through your schema, or the call fails loud with `unparseable`.

## Tier — Workhorse

`hermes3:8b` on the default `dev-rtx5080` profile, `num_ctx: 8192`. Larger
context than Instant tier so multi-paragraph inputs fit.

## When to use it

- Pulling fields out of commits / tickets / log lines / email threads
- Converting prose specs into structured task lists
- Normalizing messy CSV / JSON / log inputs into a consistent shape

## When NOT to use it

- The output is a single label → `ollama_classify` (faster, has confidence)
- You need cross-file synthesis → `ollama_research` or `ollama_corpus_answer`
- The input is a long file → use `source_path` mode (server reads it)

## Schema

```ts
{
  // Exactly one of {text, source_path, items} must be provided.
  text?:        string;
  source_path?: string;
  items?: Array<{
    id: string;
    text: string;
  }>;

  schema:       Record<string, unknown>;  // JSONSchema the result must conform to
  hint?:        string;                    // optional field-by-field hint
  frame?:       string;                    // v2.2.0+ — what the extraction is FOR
  per_file_max_chars?: number;
  model?:       string;
}
```

Full source: `src/tools/extract.ts`.

## Example call (single)

```jsonc
{
  "tool": "ollama_extract",
  "arguments": {
    "text": "feat(corpus): surface :latest drift on refresh",
    "schema": {
      "type": "object",
      "properties": {
        "kind":  { "enum": ["feat", "fix", "chore", "docs", "refactor"] },
        "scope": { "type": "string" },
        "summary": { "type": "string" }
      },
      "required": ["kind", "summary"]
    }
  }
}
```

Returns:

```jsonc
{
  "result": {
    "extracted": {
      "kind": "feat",
      "scope": "corpus",
      "summary": "surface :latest drift on refresh"
    }
  },
  "tier_used": "workhorse",
  "...": "..."
}
```

## Example call (batch)

```jsonc
{
  "tool": "ollama_extract",
  "arguments": {
    "schema": {
      "type": "object",
      "properties": {
        "severity": { "enum": ["low", "medium", "high"] },
        "service": { "type": "string" }
      }
    },
    "items": [
      { "id": "log-1", "text": "[ERROR] payments-svc: timeout after 30s" },
      { "id": "log-2", "text": "[WARN] auth-svc: token refresh slow (1.2s)" }
    ]
  }
}
```

Returns one envelope with per-item `{id, ok, result|error}` entries.

## Example call (`source_path` mode)

For a long file you don't want Claude to pre-read:

```jsonc
{
  "tool": "ollama_extract",
  "arguments": {
    "source_path": "/repo/src/index.ts",
    "schema": { "type": "object", "properties": { "exported_symbols": { "type": "array" } } },
    "per_file_max_chars": 60000
  }
}
```

The server reads the file, truncates to `per_file_max_chars`, and runs
extraction — Claude never sees the raw file content.

## Common pitfalls

**`{ error: "unparseable" }` returned in `result`.** The model produced
output that couldn't round-trip through your JSONSchema. Most common
causes: schema is too restrictive (missing `additionalProperties: false`
that the model can satisfy), `required` field has no signal in the input,
or the input is genuinely off-topic. Try simplifying the schema or adding
a `hint`.

**`PATH_NOT_ALLOWED` on `source_path`.** The path is outside
`INTERN_ALLOWED_ROOTS`. Either fix the path or extend the allow-list.

**Schema too large.** Massive nested schemas eat the context window. Split
into multiple targeted extractions if you need to fill 30+ fields.

**Two input modes provided.** Returns `SCHEMA_INVALID`. Pick exactly one
of `text` / `source_path` / `items`.

## Related tools

- [`ollama_classify`](./classify/) — single-label fast path
- [`ollama_corpus_answer`](./corpus-answer/) — when extraction needs corpus grounding
- [`ollama_research`](./) — when extraction needs to span multiple specific files
