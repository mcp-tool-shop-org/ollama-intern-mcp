# Bench — Day-1 Harness

Day-1 deliverable when the M5 Max arrives: produce *measured* numbers for the 8-tool surface instead of carrying projections.

## Goal

For each (model × context-length × prompt-shape) cell:
- `tok_per_sec_gen = eval_count / eval_duration`
- `prompt_eval_rate = prompt_eval_count / prompt_eval_duration`
- Peak RSS via `psutil` polling @ 500ms during request
- KV growth (RSS delta pre-prompt → post-gen)
- Cold-load wall time (time to first token for a just-loaded model)
- `/api/ps` snapshot (`size`, `size_vram`, `expires_at`) after each call

## Test matrix

4 models × 3 context lengths (2k / 32k / 128k — filler + real instruction at tail) × 3 prompt shapes (summarize / code-draft / classify) = 36 cells × 3 trials = **108 calls**. Plus embed throughput at batch 1 / 16 / 128.

## Concurrency test

Preload 70B + 32B with `keep_alive=-1`, alternate 20 queries, measure wall time + `/api/ps` after each. Then add 14B mid-run and watch for [Ollama issue #13227](https://github.com/ollama/ollama/issues/13227) (premature eviction).

## Output

- `results/<ISO-timestamp>.json` — raw records
- `results/<ISO-timestamp>.md` — readable summary grouped by model, with a cloud-vs-local callout contrasting measured numbers vs. Helicone H100 figures for honest context.

## Runtime budget

~60–90 min for the full matrix + ~15 min concurrency test. **Budget 2 hours.**

## Day-1 commands

```bash
brew install ollama && ollama serve &
ollama pull llama3.3:70b-instruct-q4_K_M
ollama pull llama3.3:70b-instruct-q5_K_M
ollama pull llama3.3:70b-instruct-q8_0
ollama pull qwen2.5-coder:32b-instruct-q4_K_M
ollama pull qwen2.5-coder:32b-instruct-q5_K_M
ollama pull qwen2.5-coder:32b-instruct-q8_0
ollama pull qwen2.5:14b-instruct-q4_K_M
ollama pull nomic-embed-text
pip install ollama psutil rich tqdm
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
python bench/run.py
```
