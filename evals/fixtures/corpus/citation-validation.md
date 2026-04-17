# Citation Validation

The research tool strips citations that reference paths not in the
input `source_paths` list. Unknown-path citations are a hallucination
signal; returning them unfiltered would let fabricated sources reach
the caller.

## How it works

After the model returns its answer and citations, the tool compares
each citation path against the input allowlist. Any citation whose
path is not in the allowlist is silently dropped.

This guard runs server-side, not in the prompt — a prompt rule would
be best-effort; a server-side filter is law.
