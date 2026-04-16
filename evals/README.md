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
