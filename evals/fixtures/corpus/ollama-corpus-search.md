# ollama_corpus_search — flagship

Searches a persistent named corpus by concept. Unlike embed_search,
the corpus is indexed once and reused across calls. The right tool
for semantic recall over memory, canon, doctrine files.

## Inputs

- `corpus`: named corpus (e.g. "memory")
- `query`: concept or question
- `mode`: semantic / lexical / hybrid / fact / title_path

## Persistence

The corpus lives at `~/.ollama-intern/corpora/<name>.json`. Unchanged
files are reused by sha256 on re-index, so daily use does not re-embed
the entire set.
