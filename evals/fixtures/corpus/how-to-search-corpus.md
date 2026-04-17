# How to search a corpus

Call `ollama_corpus_search` with a corpus name and a query. Optional:
pass `mode` to pick the ranking strategy.

## Example

```json
{
  "corpus": "memory",
  "query": "coverage contract",
  "mode": "hybrid"
}
```

The default mode is hybrid, which fuses dense cosine and lexical
BM25 via RRF. Pick fact mode if you remember the exact phrase. Pick
title_path when you only remember the doc's name.
