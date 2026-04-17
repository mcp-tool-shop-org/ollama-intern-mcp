# RRF Fusion

Reciprocal Rank Fusion combines multiple ranked lists into one using
ranks only — no score calibration required. Score for document d is:

  sum over input lists i: weight_i / (K + rank_i(d))

## Constants

- K = 60 (Cormack et al. 2009 default)
- Equal weights by default
- Ties broken deterministically by (path asc, chunk_index asc)

## When used

Hybrid and fact modes fuse the dense cosine list and the lexical BM25
list with this formula.
