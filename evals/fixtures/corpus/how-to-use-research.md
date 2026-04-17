# How to use the research tool

Call `ollama_research` with a question and a list of file paths.
Never pass raw text — that defeats the context-preservation story.

## Example

```json
{
  "question": "What temperature does classify use?",
  "source_paths": ["src/tiers.ts", "src/tools/classify.ts"]
}
```

The tool reads each path, chunks them, runs the Deep tier model, and
returns an answer with citations validated against the input paths.
