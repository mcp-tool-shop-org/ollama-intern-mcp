# Evals — Truth Spine (Phase 2)

Quality evaluation, not just performance. One gold pack per tool. Paired with
the benchmark harness in `bench/` so every tok/s number is answered by a
quality number.

## Gold packs (`evals/gold/`)

| Tool | Quality metric | File | State |
|---|---|---|---|
| `ollama_classify` | accuracy vs. `expected` label | `gold/classify.jsonl` | live seed |
| `ollama_triage_logs` | precision/recall on error list, usefulness of root cause | `gold/triageLogs.jsonl` | live seed |
| `ollama_summarize_fast` | factuality (no fabricated entities) vs. `source_facts` | `gold/summarizeFast.jsonl` | live seed |
| `ollama_summarize_deep` | factuality + focus adherence | `gold/summarizeDeep.jsonl` | ⚠ **placeholder** |
| `ollama_draft` | compile rate + usefulness (human scored 1–5) | `gold/draft.jsonl` | live seed |
| `ollama_extract` | schema conformance + field accuracy | `gold/extract.jsonl` | live seed |
| `ollama_research` | citation validity + answer factuality against sources | `gold/research.jsonl` | live seed |
| `ollama_embed` | retrieval recall@k on seeded queries | `gold/embed.jsonl` | live seed |
| `ollama_corpus_search` (retrieval rails) | precision@1 / precision@3 per mode × query class | `gold/retrieval.jsonl` | live — 20 cases, wired to a runner |

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

**"live seed" vs "placeholder".** A live seed is one *real* case with real
expectations — small, but scoreable today. `gold/summarizeDeep.jsonl` is not
that: its single record is a stub whose `text` reads `PLACEHOLDER — Phase 2
seeds…` and whose `required_facts` / `forbidden_fabrications` are literally
`["TODO"]`. It carries `"status": "placeholder"` so the state is visible from
the file itself, not just from this table. **The runner below must skip or
hard-fail on `status: placeholder` rather than score it** — scoring a summary
against the string `TODO` yields a pass/fail number that means nothing. Filling
it in needs a 20k+ char real excerpt whose facts span early/mid/late sections
(that is the point of the pack: does the digest preserve breadth), which is why
it is still a stub.

## Running evals

Runner TBD (Phase 2). Will live at `evals/run.py` and emit a Markdown scorecard
next to the bench harness output so quality and performance truth land side by
side.

## Anti-drift laws these evals protect

- **Speed worship** — a model that's fast but fabricates fails the summary/research gold
- **Unsafe trust** — citation validity is a measured metric, not a vibe
- **Generic chat drift** — there is no `gold/chat.jsonl` on purpose; chat is last-resort and not a measured product surface
