# ollama_embed_search — ad-hoc

Ranks a caller-supplied list of candidates against a query via cosine
similarity. One-shot, never persists, no corpus file on disk. Use
when you have an ephemeral list to rank; use corpus_search when you
need repeated queries over the same material.

## Inputs

- `query`: the query text
- `candidates`: array of { id, text } objects

## Output

Ranked list of { id, score } pairs. No raw vectors ever leak to the
caller — the tool computes cosine locally and returns scores only.
