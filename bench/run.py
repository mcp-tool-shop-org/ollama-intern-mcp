"""
Day-1 benchmark harness skeleton — to be completed when the M5 Max arrives.

Produces JSON + Markdown records for each (model, context_length, prompt_shape)
cell. Also runs a concurrency test to probe Ollama's eviction behavior.

Not runnable today — placeholder imports and TODOs mark the fill-in points.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# TODO(m5-day-1): `pip install ollama psutil rich tqdm`
try:
    import ollama  # type: ignore
    import psutil  # type: ignore
except ImportError:
    ollama = None  # type: ignore
    psutil = None  # type: ignore


MODELS = [
    "qwen2.5:14b-instruct-q4_K_M",
    "qwen2.5-coder:32b-instruct-q4_K_M",
    "qwen2.5-coder:32b-instruct-q5_K_M",
    "qwen2.5-coder:32b-instruct-q8_0",
    "llama3.3:70b-instruct-q4_K_M",
    "llama3.3:70b-instruct-q5_K_M",
    "llama3.3:70b-instruct-q8_0",
]

EMBED_MODEL = "nomic-embed-text"

CONTEXT_LENGTHS = [2_000, 32_000, 128_000]
PROMPT_SHAPES = ["summarize", "code", "classify"]
TRIALS = 3


@dataclass
class Record:
    model: str
    context_length: int
    prompt_shape: str
    trial: int
    tok_per_sec_gen: float
    prompt_eval_rate: float
    peak_rss_mb: float
    kv_growth_mb: float
    cold_load_ms: float | None
    size_vram: int
    size_total: int
    evicted: bool
    wall_ms: float


def run_cell(model: str, ctx_len: int, shape: str, trial: int) -> Record:
    """TODO(m5-day-1): real implementation.

    Plan:
      1. Load a prompt from bench/prompts/<shape>.jsonl — pad/truncate to ctx_len.
      2. Snapshot RSS, call ollama.generate(model, prompt), poll RSS every 500ms.
      3. Compute tok_per_sec_gen from eval_count / eval_duration.
      4. Poll /api/ps — record size, size_vram, expires_at.
      5. Return Record.
    """
    raise NotImplementedError("Fill in when M5 Max arrives — see docstring plan.")


def run_concurrency_test() -> dict[str, Any]:
    """TODO(m5-day-1): preload 70B + 32B with keep_alive=-1, alternate 20 queries,
    then add 14B mid-run. Watch for Ollama issue #13227 (premature eviction).
    Return a dict of observations.
    """
    raise NotImplementedError("Fill in when M5 Max arrives.")


def main() -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(__file__).parent / "results"
    out_dir.mkdir(exist_ok=True)

    records: list[Record] = []
    for model in MODELS:
        for ctx in CONTEXT_LENGTHS:
            for shape in PROMPT_SHAPES:
                for trial in range(TRIALS):
                    try:
                        records.append(run_cell(model, ctx, shape, trial))
                    except NotImplementedError:
                        print("run_cell not yet implemented — exiting scaffold.")
                        return

    concurrency = run_concurrency_test()

    (out_dir / f"{stamp}.json").write_text(
        json.dumps({"records": [asdict(r) for r in records], "concurrency": concurrency}, indent=2),
        encoding="utf8",
    )
    print(f"Wrote {out_dir}/{stamp}.json")


if __name__ == "__main__":
    main()
