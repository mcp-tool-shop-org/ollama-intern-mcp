# Evals — Truth Spine (Phase 2)

Quality evaluation, not just performance. One gold pack per tool. Paired with
the benchmark harness in `bench/` so every tok/s number is answered by a
quality number.

## Gold packs (`evals/gold/`)

| Tool | Quality metric | File |
|---|---|---|
| `ollama_classify` | accuracy vs. `expected` label | `gold/classify.jsonl` |
| `ollama_triage_logs` | precision/recall on error list, usefulness of root cause | `gold/triageLogs.jsonl` |
| `ollama_summarize_fast` | factuality (no fabricated entities) vs. `source_facts` | `gold/summarizeFast.jsonl` |
| `ollama_summarize_deep` | factuality + focus adherence | `gold/summarizeDeep.jsonl` |
| `ollama_draft` | compile rate + usefulness (human scored 1–5) | `gold/draft.jsonl` |
| `ollama_extract` | schema conformance + field accuracy | `gold/extract.jsonl` |
| `ollama_research` | citation validity + answer factuality against sources | `gold/research.jsonl` |
| `ollama_embed` | retrieval recall@k on seeded queries | `gold/embed.jsonl` |
| `ollama_corpus_search` (retrieval rails) | precision@1 / precision@3 per mode × query class | `gold/retrieval.jsonl` |

## Retrieval pack (`gold/retrieval.jsonl`)

The retrieval pack measures the Retrieval Truth Spine. It is run by
`tests/evals/retrieval.test.ts` and reports a per-mode × per-class
precision table next to hard floors.

- Four query classes: `semantic`, `fact`, `procedural`, `confusable`
- Five queries per class (20 total)
- Fixture corpus lives under `evals/fixtures/corpus/` (17 hand-crafted markdown docs with intentional confusables)
- The test runs an offline bag-of-tokens embed mock whose signal is
  deliberately different from BM25 (no stopword filter, no IDF) so
  hybrid fusion can differentiate when it matters
- Assertions are evidence-based floors set ~10 points below observed
  — regressions fire loudly; small variation does not flake
- Purely paraphrased semantic queries are known-unreachable under the
  offline mock; the test reports them instead of hiding them

Run just the retrieval pack:

```bash
npx vitest run tests/evals/retrieval.test.ts
```

Each gold file is JSONL. One seed case per tool ships now so the schema is
frozen; the rest fill in during Phase 2.

## Running evals

Runner TBD (Phase 2). Will live at `evals/run.py` and emit a Markdown scorecard
next to the bench harness output so quality and performance truth land side by
side.

## Anti-drift laws these evals protect

- **Speed worship** — a model that's fast but fabricates fails the summary/research gold
- **Unsafe trust** — citation validity is a measured metric, not a vibe
- **Generic chat drift** — there is no `gold/chat.jsonl` on purpose; chat is last-resort and not a measured product surface
