# Hybrid Mode

Fuses the dense cosine list and the lexical BM25 list via RRF. The
default corpus_search mode. Best for general queries where intent
could be semantic or literal.

## Why it's default

Lexical alone misses paraphrased queries; semantic alone misses
literal title and path queries. RRF combines ranks — no score
calibration needed — so both signals contribute without one
drowning the other.
