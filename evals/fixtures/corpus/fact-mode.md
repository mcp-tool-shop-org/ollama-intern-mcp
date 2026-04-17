# Fact Mode

Hybrid plus exact-substring boost and short-chunk preference.
Designed for specific-fact lookups where the user remembers the
phrase.

## Boost law

- exact-substring match: dominant multiplier (2.5x)
- short-chunk preference: secondary multiplier (up to 1.15x, decays
  to 1.0 over 200 to 1600 chars)
- non-matches keep their fused score — the mode never collapses to
  empty on a near-miss query
