# Scorecard

> Score a repo before remediation. Fill this out first, then use SHIP_GATE.md to fix.

**Repo:** ollama-intern-mcp
**Date:** 2026-04-18 (refreshed for v1.1.0 — skill / memory / shadow routing / calibration layers)
**Type tags:** [all] [npm] [mcp]

## Pre-Remediation Assessment

| Category | Score | Notes |
|----------|-------|-------|
| A. Security | 6/10 | Structured errors and path safety landed during Workflow + Artifact spines. Threat model lived only in SECURITY.md, not README. |
| B. Error Handling | 9/10 | `InternError` shape enforced everywhere; graceful degradation for weak briefs; no stack leakage. |
| C. Operator Docs | 5/10 | README described 8 tools — product now has 28. CHANGELOG template untouched. |
| D. Shipping Hygiene | 5/10 | verify script + lockfile + engines.node clean. No CI, no dep scan, no Dependabot. |
| E. Identity (soft) | 2/10 | No logo, no translations, no landing page, no GitHub metadata. |
| **Overall** | **27/50** | |

## Key Gaps

1. README out of date — describes the 8-tool Phase-1 surface; product now has 28 tools across 4 tiers (atoms, briefs, packs, artifact tier).
2. No CI pipeline — no automated verify, no dependency scanning, no Dependabot.
3. CHANGELOG is an empty template — four spines shipped this cycle with no recorded history.
4. README missing explicit threat-model paragraph (info exists only in SECURITY.md).
5. Soft gate untouched — no logo, translations, landing page, or repo metadata.

## Remediation Priority

| Priority | Item | Estimated effort |
|----------|------|-----------------|
| 1 | Add threat model + no-telemetry statement to README; fill CHANGELOG; add CI with dep scanning; add Dependabot | ~45 min |
| 2 | README rewrite for 28-tool surface (after marketing research) | ~60 min |
| 3 | Landing page + Starlight handbook + GitHub metadata + repo-knowledge DB entry | ~90 min |

## Post-Remediation

| Category | Before | After |
|----------|--------|-------|
| A. Security | 6/10 | 10/10 |
| B. Error Handling | 9/10 | 10/10 |
| C. Operator Docs | 5/10 | 9/10 |
| D. Shipping Hygiene | 5/10 | 10/10 |
| E. Identity (soft) | 2/10 | 9/10 (pending Treatment phases 1–4) |
| **Overall** | 27/50 | 48/50 (projected after Treatment) |
