<!--
Thanks for opening a PR. Please skim CONTRIBUTING.md first.

For security fixes, do NOT mention the vulnerability in a public PR until the
advisory is published. See SECURITY.md.
-->

## What

One or two sentences. What changes, which tool(s) or doc(s), what's the net
effect on callers.

## Why

The audit-driven gap or bug this closes. Link the issue if there is one.

## Shape of the change

- [ ] Bug fix (no behavior change for the documented contract)
- [ ] Behavior change (existing tool — note migration in CHANGELOG)
- [ ] New atom (audit-justified gap — needs tests + handbook page + CHANGELOG entry)
- [ ] New hardware profile
- [ ] Docs / internals / refactor (no shipped surface change)
- [ ] Pack/artifact tier change (these are FROZEN — expect this PR to be closed unless prior coordination happened)

## Verification

- [ ] `npm run verify` passes locally (typecheck + build + tests)
- [ ] New behavior has a test (canonical small example: `tests/tools/classify.test.ts`)
- [ ] CHANGELOG.md has an entry under `[Unreleased]` (or the next minor heading)
- [ ] Handbook updated if user-visible (`site/src/content/docs/handbook/…`)
- [ ] `npm run sync-docs` if version / tool count / test count moved

## Envelope impact

If this changes the envelope shape (`tier_used`, `model`, `model_requested`,
`num_ctx_used`, residency, fallback fields, etc.), describe:

- Field added / removed / renamed
- Whether absence is a meaningful signal (e.g. `model_requested` is only present
  when override was supplied — same shape contract here?)
- Whether existing callers continue working unchanged

## Notes

Anything reviewers should look at first. Tradeoffs you made. Open questions.
