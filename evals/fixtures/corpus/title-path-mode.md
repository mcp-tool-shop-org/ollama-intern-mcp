# Title-Path Mode

Pure metadata retrieval: scores title, heading_path, and path tokens
only. Body text is ignored (weight = 0). Never calls embed — sub-ms
latency.

## When to use

- You remember the doc's title or a word in its filename
- You need sub-millisecond response
- You are OK losing body-text signal entirely

Distinct from lexical mode, which uses the same BM25 rail but keeps
body as a scored field.
