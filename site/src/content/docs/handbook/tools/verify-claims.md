---
title: ollama_verify_claims
description: Adjudicate claims with a cross-family Ollama Cloud flagship panel — lone-dissent-never-decides voting, served-model-checked jurors, honest confidence.
sidebar:
  order: 6
---

`ollama_verify_claims` is the counterpart to `ollama_code_review`: review
**generates** findings, this **adjudicates** claims. You hand it a list of
falsifiable statements (review findings, design assertions, "the fix handles
X" claims); a panel of **disjoint-family Ollama Cloud flagships** votes
CONFIRMED / REFUTED / UNCERTAIN on each, with a short rationale per vote,
and the server aggregates under a lone-dissent-never-decides rule.

**This is a cloud tool.** It refuses with `CLOUD_NOT_CONFIGURED` unless
`OLLAMA_API_KEY` is set (standby is enough — see
[Ollama Cloud](../ollama-cloud/)). It never substitutes a local panel: a
local 8B cannot adjudicate flagship-authored claims, and a silent
substitution would be worse than a refusal. Your claims, `source_paths`
contents, and `reference` **are sent to Ollama Cloud** — that is the tool's
purpose, and it is disclosed here and in
[SECURITY.md §13](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/SECURITY.md).

## Why cross-family

LLM judges over-rate their own family's output — a mechanistic
self-preference, not a prompt artifact (arXiv:2404.13076, arXiv:2410.21819).
A panel of disjoint-family judges is the strongest empirical mitigation
(PoLL, arXiv:2404.18796). The default panel is three flagships from three
vendors — `deepseek-v4-pro:cloud` / `kimi-k2.7-code:cloud` /
`glm-5.2:cloud` — so claims authored by *any* one family (including the
frontier model driving your session) get judged by outsiders.

## Tier — Deep (one escalated cloud call per juror)

Each juror runs one `backend:'cloud'` call with a per-juror `model`
override, `think` enabled, and the deep-tier cloud timeout (default 300s).
Three jurors ≈ three cloud calls per invocation.

## When to use it

- Adjudicating `ollama_code_review` findings before acting on them
- Cross-checking claims a frontier model made about its own work (the
  advisor-loop EXTERNAL_VERIFIER step — see the role-os tie below)
- Killing or confirming contested assertions with `reference` ground truth
  (test output, lint results, measured numbers) in hand

## When NOT to use it

- Deterministic checks — compile/lint/test verdicts belong to
  `ollama_batch_proof_check`, not a jury
- Questions ("is this design good?") — this tool verifies *claims*; ask
  `ollama_research` / `ollama_corpus_answer` questions instead
- Anything you can't state falsifiably — a vague claim comes back
  UNCERTAIN, honestly

## Schema

```ts
{
  claims: [{ id: string, statement: string }],  // 1–20, unique ids, STRICT:
                                                // extra fields rejected — the
                                                // author's reasoning cannot ride in
  source_paths?: string[],                      // ≤50, server-loaded shared evidence
  reference?: string,                           // ground truth: test/lint/measured output
  panel?: string[],                             // 1–5 cloud model ids (default trio above)
  min_refute_votes?: number                     // default 2
}
```

Full source: `src/tools/verifyClaims.ts`.

## Example call

```jsonc
{
  "tool": "ollama_verify_claims",
  "arguments": {
    "claims": [
      { "id": "f1", "statement": "handleRefresh deletes corpus chunks only on ENOENT, never on a transient read error." },
      { "id": "f2", "statement": "The semaphore releases its permit when a queued waiter is aborted." }
    ],
    "source_paths": ["src/corpus/refresh.ts", "src/semaphore.ts"],
    "reference": "vitest: 1101 passed. tests/corpus/refresh.test.ts and tests/semaphore.test.ts both green."
  }
}
```

## Result shape

```jsonc
{
  "claims": [
    {
      "id": "f1",
      "statement": "handleRefresh deletes corpus chunks only on ENOENT...",
      "verdict": "CONFIRMED",          // CONFIRMED | REFUTED | NEEDS_REVIEW
      "confidence": "high",            // high = unanimous ≥2 · medium = dissent · low = NEEDS_REVIEW
      "refute_votes": 0,
      "confirm_votes": 3,
      "uncertain_votes": 0,
      "jurors": [
        { "model": "deepseek-v4-pro:cloud", "verdict": "CONFIRMED", "severity": "medium",
          "rationale": "refresh.ts:114 gates deletion on code === 'ENOENT'; the reference test run confirms." }
      ]
    }
  ],
  "panel": [
    { "model": "deepseek-v4-pro:cloud", "served_model": "deepseek-v4-pro", "included": true, "verdicts_returned": 2 },
    { "model": "kimi-k2.7-code:cloud",  "served_model": "hermes3:8b",      "included": false,
      "exclude_reason": "local_fallback:cloud_timeout", "verdicts_returned": 0 }
  ],
  "summary": "2 confirmed, 0 refuted, 0 needs review across 2 claim(s); panel 2/3 cloud-served",
  "min_refute_votes": 2,
  "weak": false                        // true when <2 jurors were cloud-served
}
```

## The aggregation rules

- **REFUTED** needs ≥ `min_refute_votes` (default 2) — a lone dissent never
  kills a claim (single-judge panels top out at ~2 effective votes of
  diversity; arXiv:2605.29800).
- **CONFIRMED** needs ≥ 2 confirms — a solo juror can never mint a
  confirmation, whatever `min_refute_votes` says.
- Anything else is **NEEDS_REVIEW** — the honest "panel couldn't decide."

## The served-model check

Every juror envelope is verified before its votes count: the call must have
been **cloud-served** (`backend:'cloud'`) and the served-model echo must
match the requested juror after normalizing the two cloud tag forms
(`glm-5.2:cloud` → `glm-5.2`, `gpt-oss:120b-cloud` → `gpt-oss:120b` — the
`/[-:]cloud$/` strip). A juror that timed out to local fallback, or was
substituted server-side, is **excluded and flagged** in `result.panel` —
silently counting a local 8B's vote would defeat the entire cross-family
design.

## The honest ceiling

A panel CONFIRMED is **supporting evidence, not proof** — especially on
claims authored by a frontier model. Verifier scale reliably catches *gross*
errors and is measurably weaker on a strong generator's *subtle* ones
(arXiv:2509.17995). Treat verdicts accordingly: `confidence` reflects juror
agreement, `weak: true` means the panel thinned below quorum, and a
REFUTED with specific rationales is a stronger signal than a CONFIRMED
with generic ones. Supply `reference` ground truth whenever you have it —
it is the single biggest reliability lever (arXiv:2510.09738).

## Common pitfalls

**`CLOUD_NOT_CONFIGURED`.** No `OLLAMA_API_KEY` in the server's env. Standby
is sufficient — you do not need `OLLAMA_CLOUD_PRIMARY` for this tool.

**A juror keeps landing `served_model_mismatch` or `call_failed:OLLAMA_MODEL_MISSING`.**
Cloud ids rotate server-side. Check
[ollama.com/search?c=cloud](https://ollama.com/search?c=cloud) and pass a
current trio via `panel`.

**Everything comes back NEEDS_REVIEW with `weak: true`.** Fewer than 2
jurors were cloud-served — look at `panel[].exclude_reason` (usually
timeouts or retired ids), fix the seats, re-run.

**A juror excluded `no_valid_verdicts`.** The seat carries a bounded
`raw_sample` (first ~200 chars of the raw reply) — read it to tell prose
from wrong-schema from an empty `verdicts` array. Large multi-file
payloads are the usual trigger (the model summarizes instead of voting);
shrink `source_paths` or split the claim set.

**Claims phrased as questions.** "Does the semaphore leak?" is not
falsifiable — phrase the assertion: "The semaphore releases its permit
when a queued waiter aborts."

## The role-os tie

This tool is the job-shaped **verify muscle** for external orchestrators:
role-os's `EXTERNAL_VERIFIER` step (no model verifies its own output; the
verifier is a different family with the generator's reasoning hidden) can
call it directly instead of hand-rolling juries over `ollama_chat`. The
worked advisor-loop recipe — local `code_review` → cloud `verify_claims`
→ durable `change_pack` — lives in
[docs/design/cross-family-verify-recipe.md](https://github.com/mcp-tool-shop-org/ollama-intern-mcp/blob/main/docs/design/cross-family-verify-recipe.md).

## Related tools

- [`ollama_code_review`](../tools/) — generates the findings this tool adjudicates
- `ollama_batch_proof_check` — deterministic verification (compile/lint/test); use it BEFORE burning jury calls on claims a compiler can settle
- [Ollama Cloud](../ollama-cloud/) — standby mode, per-call escalation, egress disclosure
