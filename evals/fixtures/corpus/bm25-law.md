# BM25 Law

Lexical ranking uses BM25 per field, with classic Robertson/Walker
constants and a BM25+ IDF variant to keep IDF non-negative for very
common terms.

## Constants

- k1 = 1.2
- b = 0.75
- IDF = ln((N - df + 0.5) / (df + 0.5) + 1)

## Field weights

- title = 3.0
- heading = 2.0
- path = 1.5
- body = 1.0

Metadata matches outweigh body because a term in the title almost
always means "this document is about that thing", while a body term
can be incidental.
