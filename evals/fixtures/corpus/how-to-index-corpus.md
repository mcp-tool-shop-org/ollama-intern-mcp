# How to index a corpus

Call `ollama_corpus_index` with a name and a list of file paths. The
indexer is idempotent — unchanged files are reused from the existing
corpus by sha256.

## Example

```json
{
  "name": "memory",
  "paths": ["memory/doctrine.md", "memory/protocols.md"]
}
```

Re-run the same command whenever the source files change. Unchanged
files will be reused; changed files are re-embedded. Files no longer
in the input set are dropped from the corpus.
