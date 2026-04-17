# How to pull Llama 3.1 locally

The dev-rtx5080-llama profile uses llama3.1:8b-instruct-q4_K_M as the
Deep tier parity rail. To pull it on a fresh install:

```bash
ollama pull llama3.1:8b-instruct-q4_K_M
```

You do not need this model unless you are explicitly running the
llama parity profile — the primary dev profile uses the Qwen ladder.
