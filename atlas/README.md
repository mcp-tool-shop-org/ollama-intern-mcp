# ollama-intern-mcp: how it works

Mapped at 2026-09-24 from commit 5e48e36.

## What this is

11 parts, mostly TypeScript (196 files). Work enters through 8 doors; the busiest is CI, which reaches 4 parts. It publishes to npm and a container image. People run ollama-intern-mcp. People import ollama-intern-mcp.

## What changed since the last map

This is the first map.

## What comes in

1. **CI.** On a pull request touching 18 paths; on a push to main touching 18 paths; or by hand. Runs scripts/cloud-smoke-generate.mjs, scripts/gen-tool-docs.mjs, scripts/sync-doc-versions.mjs and 41 more; checks hermes.config.example.yaml, package-lock.json, package.json and 2 more.
2. **Release.** When a tag matching `v*.*.*` is pushed; or by hand. Runs tests/cli.test.ts, tests/cloudCheck.test.ts, tests/cloudClient.test.ts and 37 more; checks hermes.config.example.yaml, package-lock.json, package.json and 2 more.
3. **Doc Drift.** On a pull request touching 12 paths; on a push to main touching 12 paths; or by hand. Runs scripts/sync-doc-versions.mjs; checks HANDOFF.md, README.md and SHIP_GATE.md.
4. **Deploy site to GitHub Pages.** On a push to main touching 2 paths; or by hand. Runs site/astro.config.mjs and site/src/.
5. **CodeQL.** On a pull request; on a push to main; on a schedule (`0 9 * * 0`), Sunday at 09:00 UTC; or by hand. Runs no file this map can see.
6. **Dependency Review.** On a pull request. Runs no file this map can see.
7. **ollama-intern-mcp** (a command people run, from package.json). Runs src/index.ts.
8. **ollama-intern-mcp** (the package people import, from package.json). Loads src/index.ts.

## What happens through CI

1. The workflow runs scripts/cloud-smoke-generate.mjs, scripts/gen-tool-docs.mjs and scripts/sync-doc-versions.mjs in scripts, src/index.ts in src, and 98 files in tests; it checks 4 files in the repository root and src/ in src.
   1. Inside src/index.ts, main does, in order:
      1. profiles (3 steps)
      2. ollama (3 steps)
      3. timestamp
      4. run prewarm
      5. note prewarm in progress request
      6. mint run id
      7. with run context
      8. to error shape
      9. handle research
      10. handle corpus search
      11. handle corpus answer
      12. handle incident brief, and 8 more
   2. **Handle corpus search** runs, in order:
      1. resolve tier
      2. load corpus
      3. is empty query
      4. build envelope
      5. call event
      6. search corpus
      7. resolve tier
      8. resolve num ctx
      9. cloud may serve
      10. build envelope
      11. call event
   3. **Handle corpus answer** runs, in order:
      1. load corpus
      2. is empty query
      3. resolve tier
      4. build envelope
      5. call event
      6. resolve tier
      7. search corpus
      8. resolve tier
      9. build envelope
      10. call event
      11. resolve tier
      12. build envelope
   4. **Handle incident pack** runs, in order:
      1. get run context
      2. mint call id
      3. with call context
      4. assert cloud escalation configured
      5. build pack step event with correlation
      6. handle triage logs
      7. build pack step event with correlation
      8. normalize corpus query
      9. assemble evidence
      10. build pack step event with correlation
      11. synthesize incident brief
      12. build pack step event with correlation
   5. **Handle repo pack** runs, in order:
      1. get run context
      2. mint call id
      3. with call context
      4. assert cloud escalation configured
      5. build pack step event with correlation
      6. normalize corpus query
      7. assemble evidence
      8. build pack step event with correlation
      9. synthesize repo brief
      10. build pack step event with correlation
      11. load sources
      12. format sources block
   6. **Handle change pack** runs, in order:
      1. get run context
      2. mint call id
      3. with call context
      4. assert cloud escalation configured
      5. build pack step event with correlation
      6. normalize corpus query
      7. assemble evidence
      8. build pack step event with correlation
      9. handle triage logs
      10. build pack step event with correlation
      11. synthesize change brief
      12. build pack step event with correlation

## Who reads the results

CI writes nothing this map can see.

## The other doors

**Release** runs tests/cli.test.ts, tests/cloudCheck.test.ts, tests/cloudClient.test.ts and 37 more, checks hermes.config.example.yaml, package-lock.json, package.json and 2 more, publishes to npm and a container image, and creates a GitHub release.

**Doc Drift** runs scripts/sync-doc-versions.mjs and checks HANDOFF.md, README.md and SHIP_GATE.md.

**Deploy site to GitHub Pages** runs site/astro.config.mjs and site/src/, and deploys the site.

**CodeQL** runs no file this map can see.

**Dependency Review** runs no file this map can see.

**ollama-intern-mcp** (a command people run, from package.json) runs src/index.ts.

**ollama-intern-mcp** (the package people import, from package.json) loads src/index.ts.

## What breaks what

- **src** is imported by 2 parts (scripts, smoke), and by 1 more only from tests; it sits on the path of 4 doors.
- **the repository root** is imported by no other part and sits on the path of 3 doors.
- **scripts** is imported by no other part and sits on the path of 2 doors.
- **tests** is imported by no other part and sits on the path of 2 doors.

## What tends to change together

- **src/tools/changeBrief.ts** and **src/tools/repoBrief.ts** changed together in 7 of 9 commits, inside the src part.
- **src/tools/changeBrief.ts** and **src/tools/incidentBrief.ts** changed together in 7 of 10 commits, inside the src part.
- **src/tools/incidentBrief.ts** and **src/tools/repoBrief.ts** changed together in 7 of 10 commits, inside the src part.
- **src/tools/packs/changePack.ts** and **src/tools/packs/incidentPack.ts** changed together in 8 of 12 commits, inside the src part.
- **src/tools/packs/changePack.ts** and **src/tools/packs/repoPack.ts** changed together in 8 of 12 commits, inside the src part.

2 files changed together with their own tests, as expected.

Confidence is low: fewer than 20 source files reach 10 revisions in the window.

Window: 180 days; a pair counts from 3 shared commits, since 15 source files reach 10 revisions; the floor rises to 10 when 25 do.

## What no test touches

- **bench** is imported by no test.
- **examples** is imported by no test.
- **scripts** is imported by no test.

## Written but never read

No place this map can see is written, so none goes unread.

## Helpers that look duplicated

No two parts export a helper that looks alike.

## Generated, never hand-edited

Nothing in this repository writes to a tracked place this map can see.

## Hand-authored

People write .github/, docs/, evals/, the repository root and site/; 18 writes with paths built at run time may land here.

## Where to start

.github/workflows/ci.yml → src/index.ts

Read those in order to follow one pull request end to end.

## What this map cannot see

- 4 files use syntax the parser cannot read (scripts/gen-tool-docs.mjs, scripts/sync-doc-versions.mjs, tests/tools/artifactWrite.test.ts and 1 more), so what they import is not known: 2 in scripts (a NUL character inside a string), 2 in tests (`typeof import(…)` as a type argument).
- 18 writes and 23 reads use paths built at run time and are not named here.
- 1 write goes to places this repository does not track, so it is not listed as generated.
- 2 writes and 11 reads go to the directory the command is run in, the home directory or a path its caller passes, not to this repository.
- 7 commands are built at run time and not followed, 5 of them in tests.
- Statistics confidence is low: fewer than 20 source files reach 10 revisions in the window.

Regenerate with `npx --yes @dogfood-lab/atlas map`.
