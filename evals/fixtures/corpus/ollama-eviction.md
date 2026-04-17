# Ollama eviction — issue #13227

Ollama can silently evict models from VRAM even when RAM is free. The
bug is tracked as GitHub issue #13227. When `size_vram < size` in
`/api/ps`, the model is paged out and inference drops 5 to 10x.

## Guard

Every MCP call includes a residency check on the response envelope.
When the guard trips, the envelope carries `{in_vram: false,
evicted: true}` and the caller can decide whether to warn or retry.
