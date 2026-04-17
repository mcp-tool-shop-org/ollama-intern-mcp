# How to pull Qwen Coder locally

The dev-rtx5080 profile uses qwen2.5-coder:7b as the Workhorse model.
To pull it on a fresh install:

```bash
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
```

Once pulled, the model is available via the MCP server without any
further config. Ollama keeps it warm as long as `OLLAMA_KEEP_ALIVE`
is set.
