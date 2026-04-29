# Bench — Day-1 Harness

Day-1 deliverable now that the M5 Max is active (2026-04-24+): produce *measured* numbers for the v2.1.0 41-tool surface instead of carrying projections.

The model list below tracks the `m5-max` profile in [`src/profiles.ts`](../src/profiles.ts). When the profile changes, this file changes.

## Goal

For each (model × context-length × prompt-shape) cell:
- `tok_per_sec_gen = eval_count / eval_duration`
- `prompt_eval_rate = prompt_eval_count / prompt_eval_duration`
- Peak RSS via `psutil` polling @ 500ms during request
- KV growth (RSS delta pre-prompt → post-gen)
- Cold-load wall time (time to first token for a just-loaded model)
- `/api/ps` snapshot (`size`, `size_vram`, `expires_at`) after each call

## Test matrix

3 models × 3 context lengths (2k / 32k / 128k — filler + real instruction at tail) × 3 prompt shapes (summarize / code-draft / classify) = 27 cells × 3 trials = **81 calls**. Plus embed throughput at batch 1 / 16 / 128.

Models tested: the active `m5-max` profile ladder (`qwen3:14b` for instant + workhorse, `qwen3:32b` for deep, `nomic-embed-text` for embed). If the profile expands (e.g. adds `qwen3:8b` for instant comparison or `qwen3:72b` for deep), update this matrix.

## Concurrency test

Preload `qwen3:32b` (deep) + `qwen3:14b` (workhorse) with `keep_alive=-1`, alternate 20 queries between them, measure wall time + `/api/ps` after each. Then add a third model mid-run and watch for [Ollama issue #13227](https://github.com/ollama/ollama/issues/13227) (premature eviction).

## Output

- `results/<ISO-timestamp>.json` — raw records
- `results/<ISO-timestamp>.md` — readable summary grouped by model, with a cloud-vs-local callout contrasting measured numbers vs. Helicone H100 figures for honest context.

## Runtime budget

~45–75 min for the full matrix + ~15 min concurrency test. **Budget 90 min** (down from 2 hours; smaller matrix since the qwen3 ladder is 3 models, not 4).

## Day-1 commands

```bash
brew install ollama && ollama serve &
# m5-max profile ladder
ollama pull qwen3:14b
ollama pull qwen3:32b
ollama pull nomic-embed-text
# Optional: pull qwen3:8b if benchmarking an instant-tier alternative
# ollama pull qwen3:8b
pip install ollama psutil rich tqdm
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1
python bench/run.py
```

## Acceptance

Bench run is "done" when `results/<timestamp>.md` is committed under `results/` and `src/profiles.ts` `m5-max` profile values cite the run timestamp. Until then, the profile values are best-guess. See [ROADMAP.md](../ROADMAP.md) "M5 Max profile tuning" entry.
