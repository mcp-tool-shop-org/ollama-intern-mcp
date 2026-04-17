# ollama_research — flagship

Reads file paths, reads and chunks them server-side, returns an answer
with validated citations. Never loads raw source bytes into Claude's
context. This is the grounded-retrieval flagship.

## Inputs

- `question`: what you are asking
- `source_paths`: file paths to read (not raw text)

## Guarantees

- Citations are validated against source_paths
- Answer never ships with unknown-path citations
- Multi-source calls return a coverage report
