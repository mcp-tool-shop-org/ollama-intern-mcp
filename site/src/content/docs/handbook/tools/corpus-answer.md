---
title: ollama_corpus_answer
description: Chunk-grounded synthesis over a corpus — Tier&#58; Deep + Embed. Every claim cites a chunk id. Flagship tool.
sidebar:
  order: 30
  badge:
    text: Flagship
    variant: success
---

`ollama_corpus_answer` is the synthesis flagship. Give it a corpus name and
a question; it retrieves the top-k chunks, then synthesizes an answer
grounded **only** in those chunks. Every claim cites a chunk id. Outside
knowledge is forbidden by the system prompt and the citations are validated
server-side — invalid ids are stripped before the result returns.

## Tier — Deep + Embed

Embed tier for retrieval (`nomic-embed-text` on the default profile),
Deep tier for synthesis (`hermes3:8b`, larger context). Two model loads
back-to-back.

## When to use it

- "What does our docs say about X?" — over a pre-indexed corpus
- "Summarize what we've decided about Y" — over project memory
- "Give me a chunk-grounded answer about Z" — when you need citation trail

## When NOT to use it

- You have specific files in mind → `ollama_research` (path-grounded)
- The corpus isn't indexed yet → run `ollama_corpus_index` first
- You need a one-shot answer with no grounding → `ollama_chat` (last resort)

## Schema

```ts
{
  corpus:      string;        // name; matches /^[a-zA-Z0-9_-]+$/
  question:    string;        // max 1000 chars
  mode?:       "hybrid" | "vector" | "lexical";  // retrieval strategy
  top_k?:      number;        // 1..20, default 5
  max_words?:  number;        // 20..1000, default 200 (target answer length)
  min_top_score?: number;     // 0..1, topicality floor; v2.2.0+
  model?:      string;        // per-call model override (advanced)
}
```

Full source: `src/tools/corpusAnswer.ts`.

## Example call

```jsonc
{
  "tool": "ollama_corpus_answer",
  "arguments": {
    "corpus": "ollama-docs",
    "question": "How is residency reported in /api/ps?",
    "top_k": 6,
    "min_top_score": 0.5
  }
}
```

Envelope `result`:

```jsonc
{
  "answer": "/api/ps reports loaded models with size_vram, size, and digest...",
  "citations": [
    {
      "chunk_id":     "abc123",
      "source_path":  "/repo/docs/api/ps.md",
      "heading_path": ["API", "/api/ps"],
      "score":        0.84
    },
    {
      "chunk_id":     "def456",
      "source_path":  "/repo/docs/concepts/residency.md",
      "score":        0.71
    }
  ],
  "weak":      false,
  "abstained": false,
  "retrieval": { "mode": "hybrid", "top_k": 6, "hits_returned": 6 }
}
```

## Abstention contract (v2.2.0+)

The tool can return three honest non-answers:

| Shape | When | What you should do |
|---|---|---|
| `weak: true` | Fewer than 2 retrieval hits | Treat the answer as a hint, not authoritative |
| `abstained: true`, `min_top_score` exceeded | Top hit fell below the threshold you set | Lower the threshold, expand the corpus, or accept the abstention |
| `abstained: true`, zero hits | No chunks matched at all | Index more relevant content into the corpus |

`abstained: true` always comes with an empty `answer` and empty
`citations[]`. **It is success, not failure** — the tool refusing to
launder weak retrieval into authoritative output.

## Common pitfalls

**`abstained: true` with `min_top_score` you don't remember setting.** The
default is no floor; abstention here means the corpus genuinely didn't
address the question. Either expand the corpus (index more files) or
relax `min_top_score` if you set one.

**`citations[]` shorter than the answer's claim count.** Some claims got
synthesized from the same chunk; that's normal. If you see *zero*
citations with a non-empty answer, that's the abstention contract — the
model declined.

**`weak: true` on an answer that looks fine.** Two-or-fewer chunks
matched the query. The answer might still be correct, but you're working
off a narrow base — spot-check before promoting.

**Corpus name has invalid characters.** Names must match
`[a-zA-Z0-9_-]+`. Spaces, slashes, dots all rejected at the schema level.

**`question` longer than 1000 chars.** Capped to keep the answer-from-
corpus contract intact. Beyond 1000 chars you're asking the model to
summarize the question itself, which defeats the grounding.

## Related tools

- [`ollama_corpus_index`](./) — build the corpus this tool answers from
- [`ollama_research`](./) — same idea, but pass file paths instead of a corpus name
- See [Abstention contract](../../README.md#abstention-contract-new-in-v220)
  in the README for the v2.2.0 contract details
