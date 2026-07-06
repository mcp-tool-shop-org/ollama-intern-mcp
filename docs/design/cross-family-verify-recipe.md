# The cross-family verify loop — local review → cloud adjudication → durable artifact

**Status:** shipped with `ollama_verify_claims` (v2.9 line). This is the
worked recipe for the advisor-loop pattern the tool productizes; the fuller
publication pass (F8) is tracked in the roadmap's Phase 3b.

## The pattern

Any orchestrator that lets a model verify its own output inherits
self-preference bias — a model rates its own family's work higher, and the
effect is mechanistic, not fixable by prompting (arXiv:2404.13076,
arXiv:2410.21819). The EXTERNAL_VERIFIER standard (workflow standard #6)
therefore requires a different model family with the generator's reasoning
hidden. Before `ollama_verify_claims`, wiring that up meant hand-rolling
jury prompts over `ollama_chat`: no verdict enum, no panel management, no
served-model check, no reference passing. Now it is one call.

## The three-step loop

```
1. GENERATE (local, free)      ollama_code_review
   └─ diff + source_paths → structured findings

2. ADJUDICATE (cloud, bounded) ollama_verify_claims
   └─ findings restated as falsifiable claims
      + the same source_paths as shared evidence
      + reference = the test/lint output you already have
   └─ cross-family flagship panel votes; lone dissent never decides

3. PERSIST (local, durable)    ollama_change_pack
   └─ the change + the surviving findings → a durable artifact
      with the jury verdicts recorded in the summary
```

Step 1 costs nothing (local model). Step 2 is three cloud calls per batch
of ≤20 claims — spend them on the findings that would change your plan,
not on style nits. Step 3 makes the outcome auditable next week.

## Worked example

```jsonc
// Step 2, concretely — adjudicate two review findings:
{
  "tool": "ollama_verify_claims",
  "arguments": {
    "claims": [
      { "id": "r1", "statement": "The retry loop in src/ollama.ts re-sleeps after the final attempt, adding dead latency to every exhausted-retry failure." },
      { "id": "r2", "statement": "postOnce leaks the AbortController timer when the payload guard throws." }
    ],
    "source_paths": ["src/ollama.ts"],
    "reference": "vitest run tests/ollamaRetry.test.ts: 14 passed."
  }
}
```

Read the result like an operator, not a believer:

- `REFUTED` with ≥2 specific rationales → drop the finding, note why.
- `CONFIRMED` (confidence high) → act on it; it's still *evidence*, not proof.
- `NEEDS_REVIEW` or `weak: true` → the panel couldn't settle it; a human
  (or a deterministic check) owns the call.
- Always check `result.panel` — a verdict from a 1/3-served panel is a
  different object than a 3/3 unanimous one.

## The role-os tie

role-os's `verify-citations` step already externalizes citation checking
(prism). `ollama_verify_claims` gives role-os the same externalized muscle
for **arbitrary claims and findings**: call it from the EXTERNAL_VERIFIER
step with the mission's claims, pass the mission's own receipts as
`reference`, and gate progression on the aggregate verdicts + the `weak`
flag. The envelope's `backend` / `panel[].served_model` provenance makes a
degraded jury drift-detectable from the receipts alone — the same
served-model discipline role-os already applies to its cloud seats.

Wiring on the role-os side (its own repo, `E:/AI/role-os`) is a follow-on;
nothing in this tool blocks on it.

## Rules of engagement (learned, not theoretical)

- **Deterministic checks first.** Never spend jury calls on what
  `batch_proof_check` (tsc/eslint/pytest) can settle for free.
- **Claims, not questions.** The tool adjudicates falsifiable statements;
  a question-shaped input comes back UNCERTAIN.
- **Reasoning stays home.** The schema rejects extra claim fields by
  design — don't smuggle the generator's argument into `statement`
  either; jurors judging an argument instead of evidence is the failure
  mode this exists to prevent.
- **The panel over-flags.** Cross-family jurors sometimes refute correct
  work from missing context (observed repeatedly in this studio's swarm
  history). A REFUTED verdict is a signal to re-read the code with the
  juror's rationale in hand — not an auto-revert.
