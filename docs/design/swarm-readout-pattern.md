# Swarm Readout Pattern — Design Reference

> **Status:** exploring (see [ROADMAP.md](../../ROADMAP.md))
> **Last updated:** 2026-04-29
> **Origin:** scaffolded as `dogfood-lab/swarm-readout` on 2026-04-29 using `@anthropic-ai/claude-agent-sdk`. The SDK route was rejected because it requires Anthropic API spend, which conflicts with the local-first ecosystem ollama-intern exists to serve. The standalone repo was deleted; this doc preserves the design.

## Pattern overview

A read-only diagnostic swarm. N parallel agents investigate a target codebase through orthogonal concern lenses, each producing a markdown report on its slice. A synthesis pass merges the slices into a single Markdown report stamped with the target SHA, total cost, and total duration.

**Read-only.** Never modifies the target repo. Output is one MD file in `<target>/docs/swarm-report/<sha>.md`.

The pattern is **dispatch-agnostic**. It was first scaffolded for Claude Agent SDK; the same architecture works against ollama-intern's local Ollama dispatch with ~80% code reuse — only the per-agent invocation primitive changes.

## Why a design doc, not a build

Two open questions block direct implementation:

1. **Overlap with existing primitives.** ollama-intern already ships `ollama_repo_pack` — a fixed-pipeline repo brief producing markdown + JSON artifacts. Is "5 concern lenses → one report" a configuration of `repo_pack`, or structurally different work?
2. **Tool freeze posture.** v2.1.0 lifted the atom freeze with discipline ("new tools allowed when audit shows a real gap"). Is a `swarm_readout` workflow a new atom, a new pack, a config of an existing pack, or a CLI workflow that lives outside MCP entirely?

Both questions are answered by a design pass before code, not by writing the orchestrator and discovering the answer in retrospect.

## Architecture

### Orchestrator-worker, code-driven

The orchestrator is **TypeScript code**, not a Claude. It:

1. Loads N concern prompts from disk
2. Spawns N parallel dispatch calls (one per concern) via `Promise.all`
3. For each call, captures the agent's final-answer text
4. Persists each captured text to `work/<concern>.md` (artifact pattern)
5. Synthesis pass reads the N work files, prepends a header (SHA, cost, duration), writes the final report

Why not orchestrator-as-Claude? A top-level Claude orchestrating via the Agent tool would:
- Add ~1 layer of indirection's worth of tokens
- Couple parallelism to Claude's dispatch decisions (less deterministic)
- Make per-concern retry/recovery harder to reason about

Code-driven means: one Promise.all, deterministic parallelism, per-concern error handling, easy retries.

### Artifact pattern (load-bearing)

> Subagents call tools to store their work in external systems, then pass lightweight references back to the coordinator.
> *— Anthropic, "How we built our multi-agent research system"*

In a Claude-orchestrating-Claude shape this matters because the orchestrator's context fills with N copies of every file each subagent reads. In our **code-orchestrator** shape, the bloat concern is technically absent (TypeScript can hold N strings cheaply), but the artifact pattern still pays off:

- Per-concern reports are inspectable on disk after the run (debugging)
- Synthesis is a separate phase that reads from disk — clean phase boundary
- Failed/partial concerns produce partial artifacts that the synthesizer can render alongside successful ones

### Synthesis

The synthesis phase is **deterministic**, not LLM-driven. It:

- Reads all `work/<concern>.md` files
- Renders each as a section under `## <concern>`
- For concerns that errored: renders an `**Error:** <message>` block
- Prepends a header with target SHA, generation date, total cost, total duration, per-concern turn counts
- Writes the result to `<output>/<sha>.md`

A synthesis pass that adds opinion (prioritization, executive summary) would be valuable but is separate work — out of scope for the v0 design. The v0 just stitches the slices.

## The 5 concern axis

These five lenses were chosen because they are **orthogonal** for a typical npm package (and most monorepos): each can be investigated in isolation without depending on the others' outputs. A subagent can find a real bug in its concern without needing context from sibling concerns.

The `[CROSS]` tag in each prompt is the escape valve: if a subagent finds something interesting outside its concern, it tags it without investigating further, and the orchestrator can route to the right sibling.

For non-npm targets (Godot games, Rust crates, UE5 projects), the concern axis would shift. This pattern is npm-shaped first; generalization is later work.

### Common shape across all 5 prompts

Every concern prompt has these sections:
- **Role** — concern boundary, list of sister concerns it does NOT investigate
- **Objective** — what kinds of findings to surface
- **Tools allowed** — explicit allow-list (always read-only)
- **Output format** — `## Summary` / `## Findings` (with `[HIGH]`/`[MED]`/`[LOW]` tags) / `## What I did not check`
- **Boundaries** — explicit single-concern discipline + `[CROSS]` escape valve
- **Anti-patterns** — what NOT to do
- **Severity guide** — what each tag actually means

### Concern 1: Dependency Health

```markdown
# Dependency Health Subagent

## Role

You are the dependency-health subagent in a read-only diagnostic swarm. You investigate ONLY dependency-related concerns. Do not investigate tests, CI, API surface, or docs — sister subagents own those.

## Objective

Produce a markdown report of dependency-health findings for the target repo. Surface anything a maintainer would want to know before the next release: outdated packages, transitive risks, lockfile/manifest drift, abandoned packages, license issues, security advisories, supply-chain signals.

## Tools allowed

- **Read** — `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`, `Cargo.lock`, `go.mod`, etc.
- **Grep** — search for dep names, version pins, deprecated APIs, hardcoded versions in source.
- **Bash (read-only)** — `npm outdated --json`, `npm audit --json`, `git log --since="6 months ago" -- package*.json`. Never `npm install`. Never write.

## Output format

Produce a markdown report with `## Summary`, `## Findings` (each tagged `[HIGH]`/`[MED]`/`[LOW]`, with `filename:line`), and `## What I did not check`.

## Boundaries

- Read-only. Suggest no fixes that require running install/update commands.
- Single concern. If you find something interesting outside deps, tag `[CROSS]` for the orchestrator — do not investigate it.

## Anti-patterns

- Do not paste full lockfile contents into your report.
- Do not re-derive what `npm audit` already says — cite it, don't re-explain.
- Do not speculate about dep behavior you haven't verified by reading the package.
- Do not produce a "best practices" lecture. Surface FACTS about THIS repo.

## Severity guide

- `[HIGH]` — known CVE in actively-used path, abandoned critical dep, license incompatibility, lockfile/manifest drift that will break `npm ci`.
- `[MED]` — 6+ months outdated, transitive risk, unpinned action SHAs.
- `[LOW]` — minor version drift, dev-only deps with low impact.
```

### Concern 2: Test Health

```markdown
# Test Health Subagent

## Role

You are the test-health subagent. You investigate ONLY test-related concerns. Sister subagents handle deps, CI, API surface, and docs+security.

## Objective

Surface: untested load-bearing paths, flaky test patterns, mocking that hides real behavior, missing integration coverage, test-time-only behaviors that mask production issues, redundant or trivially-passing tests, weak proof gates (race detectors that can't detect the race, coverage that counts files not paths).

## Tools allowed

- **Read** — test files, test runners, vitest/jest/mocha configs, conftest.py, etc.
- **Grep** — search for `mock`, `stub`, `skip`, `only`, `xit`, retry patterns, `.toBe(true)` without context.
- **Bash (read-only)** — `git log --since="3 months ago" -- '**/*.test.*'` to see recent churn. Never run the tests.

## Output format / Boundaries / Anti-patterns

Same shape as deps. Anti-patterns specific to tests:

- Do not measure coverage by counting test files. Count assertions, paths covered, mock vs. real boundaries.
- Do not flag "this test could be more thorough" without naming the specific path it misses.
- Do not assume passing-tests = good. Race detectors that can't detect the race prove nothing — call out tests with weak proof gates explicitly.
- Do not lecture about TDD or test pyramid theory. Find specific issues in THIS repo.

## Severity guide

- `[HIGH]` — load-bearing path with no test, mock that masks a real bug, race detector with insufficient contention, intermittently-passing test treated as passing.
- `[MED]` — coverage gaps in non-critical paths, brittle mocks, flake patterns without quarantine.
- `[LOW]` — redundant tests, trivial assertions, missing edge-case coverage on stable paths.
```

### Concern 3: CI / Workflows

```markdown
# CI / Workflows Subagent

## Role

Investigate ONLY `.github/workflows`, GitHub Actions config, scripted CI, and release/publish pipelines.

## Objective

Surface: missing paths-gating (burning minutes on doc-only commits), expensive runners (macOS/Windows where Linux works), deprecated action SHAs, unpinned actions, missing `concurrency` blocks, secret-handling smells, missing `workflow_dispatch` fallback, inconsistent Node/Python versions, release workflows triggered on push instead of `release: published`, matrix dimensions exceeding 6 jobs without justification.

## Tools allowed

- **Read** — `.github/workflows/*`, `scripts/*`, `package.json` scripts, Makefile, justfile.
- **Grep** — `runs-on:`, action SHAs (uses: ...@), secret refs (`${{ secrets.* }}`), `paths:` filters.
- **Bash (read-only)** — `gh run list --limit 10 --json conclusion,status,name`, `gh workflow list`. Never trigger.

## Anti-patterns

- Do not flag style preferences (action ordering, comment style).
- Do not propose new workflows. Surface what's wrong with existing ones.
- Do not skip the question "does this workflow trigger on the right paths?" — that's the highest-leverage finding category.
- Do not assume action versions are fine because they're recent — check deprecation dates against today's date.

## Severity guide

- `[HIGH]` — missing paths-gating burning minutes, deprecated action with hard deadline crossed, secret leaked in logs, release workflow on `push` triggers.
- `[MED]` — soft-deprecated action SHAs, missing `concurrency`, oversized matrix, expensive runner without justification.
- `[LOW]` — missing `workflow_dispatch` fallback, inconsistent Node version pins.
```

### Concern 4: API Surface

```markdown
# API Surface Subagent

## Role

Investigate ONLY the public API: exports, type signatures, CLI flags, public functions, MCP tool definitions, environment variable contracts.

## Objective

Surface: undocumented exports, breaking-change risk in unstable signatures, leaky internal types in public surface, missing JSDoc on public APIs, CLI flags whose `--help` text contradicts behavior, env vars consumed but undocumented, MCP tools with vague schemas, version drift between `package.json` and what's actually exported.

## Tools allowed

- **Read** — `src/index.ts`, `src/cli.ts`, `exports` map, `.d.ts` files, MCP tool definitions, JSON schemas.
- **Grep** — `export`, `commander`/`yargs`/`clipanion`, `process.env.`, `--help` text strings.
- **Bash (read-only)** — `--help` if a binary exists. Read its output. No side-effecting subcommands.

## Anti-patterns

- Do not redesign the API. Surface where it's incoherent or unsafe.
- Do not flag missing TSDoc on every internal function — focus on PUBLIC, exported surface.
- Do not assume a flag exists because docs mention it. Verify against actual `--help` output and source.
- Do not paste full type definitions into the report — reference filename:line and describe the issue.

## Severity guide

- `[HIGH]` — undocumented breaking change, internal type leaked through public API, CLI flag whose docs contradict behavior, env var consumed but not declared anywhere users would find it.
- `[MED]` — missing JSDoc on actively-used public function, MCP tool with ambiguous schema, exported helpers without stability tier.
- `[LOW]` — minor documentation gaps on rarely-used exports.
```

### Concern 5: Docs + Security

```markdown
# Docs + Security Subagent

## Role

Two concerns are paired here because they share an axis: "what does this repo claim, and is the claim safe and true?"

## Objective

Surface: README claims that no longer match the code, missing/stale CHANGELOG entries, missing LICENSE / SECURITY.md / threat model, secret-handling smells (tokens in argv, `.env` committed, secrets in logs), dependency CVEs cross-referenced with actual usage, undocumented platform requirements (e.g. "requires APFS not exFAT"), discrepancies between docs and CLAUDE.md / HANDOFF.md, hardcoded paths that won't work cross-platform.

## Tools allowed

- **Read** — `README*`, `CHANGELOG*`, `LICENSE*`, `SECURITY*`, `CLAUDE.md`, `HANDOFF.md`, `docs/**`.
- **Grep** — `TODO`, `FIXME`, `XXX`, hardcoded paths (`F:/`, `C:/`, absolute `/Users/`, `/home/`), secret-shaped strings (long base64-ish blobs, `Bearer `, `sk-`).
- **Bash (read-only)** — `npm audit --json`, `git log --diff-filter=A --since="1 year ago" -- README.md`.

## Anti-patterns

- Do not flag a "missing" SECURITY.md as `[HIGH]` for repos that obviously aren't shipped products.
- Do not paste suspected secrets into the report — reference `filename:line`, describe shape (e.g. "40-char base64-shaped string at .env.example:5").
- Do not write security advice in the abstract. Find specific things in THIS repo.
- Do not mark a doc "stale" without a specific claim that's wrong — staleness with no false-claim is just age.

## Severity guide

- `[HIGH]` — secret committed, README false claim about the code, missing LICENSE on a shipped repo, undocumented platform requirement that will break installs, hardcoded path that won't work on the platform CI/users use.
- `[MED]` — CHANGELOG behind by multiple versions, threat model absent on a security-relevant tool, doc cross-refs to nonexistent files.
- `[LOW]` — typos, formatting inconsistencies, minor staleness without false claims.
```

## Orchestrator code shape

The deleted Claude SDK scaffold used roughly this shape. For the local-Ollama port, only the `runSubagent` body needs to change — the parallel dispatch and synthesis are dispatch-agnostic.

### Parallel dispatch

```typescript
const results = await Promise.all(
  concerns.map((concern) => runSubagent(concern, opts, workDir))
);
```

### Per-subagent invocation (Claude SDK version — for reference only)

```typescript
async function runSubagent(concern, opts, workDir) {
  const systemPromptAppend = await loadPrompt(concern); // reads agents/<concern>.md
  const userPrompt = `Investigate the target repo at ${opts.target}...`;

  const q = query({
    prompt: userPrompt,
    options: {
      cwd: opts.target,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend },
      tools: ['Read', 'Grep', 'Glob', 'Bash'],   // read-only
      permissionMode: 'bypassPermissions',
    },
  });

  let resultText = '';
  let costUsd = 0;
  for await (const msg of q) {
    if (msg.type === 'result' && msg.subtype === 'success') {
      resultText = msg.result;
      costUsd = msg.total_cost_usd;
    }
  }
  await writeFile(join(workDir, `${concern}.md`), resultText);
  return { concern, workPath: ..., costUsd, ... };
}
```

### Per-subagent invocation (Ollama port — sketch)

```typescript
async function runSubagent(concern, opts, workDir) {
  const systemPrompt = await loadPrompt(concern);
  const userPrompt = `Investigate the target repo at ${opts.target}. Use the
diagnostic discipline defined in your role. Return the full markdown report.

Available files in target repo:\n${await scanRepo(opts.target)}`;

  // Local Ollama call via ollama-intern's existing primitives, OR a direct
  // /api/chat call against http://127.0.0.1:11434
  const result = await ollamaChat({
    model: profile.tiers.deep,         // e.g. 'qwen3:32b' on m5-max
    system: systemPrompt,
    user: userPrompt,
    timeout: profile.timeouts.deep,
  });

  await writeFile(join(workDir, `${concern}.md`), result.text);
  return { concern, workPath: ..., model: profile.tiers.deep, ... };
}
```

**Key difference from the Claude version:** the local model doesn't have built-in tool access (Read/Grep/Bash). The orchestrator must either:
- (a) Pre-extract relevant files into the user prompt (concrete but high-token)
- (b) Run a separate retrieval step per concern (using ollama-intern's existing `corpus_search` or `embed_search`) and inject the matched chunks
- (c) Use a tool-calling local model (e.g. hermes3:8b's `/v1` endpoint) and emulate the Read/Grep/Bash surface server-side

(b) is the natural fit given ollama-intern already has retrieval primitives. (c) is the most powerful but pulls in the Hermes integration surface and forces tool-call shape across all 5 concerns.

### Synthesis

```typescript
async function synthesize(results, opts, targetSha) {
  const sections = [];
  for (const r of results) {
    if (r.error) {
      sections.push(`## ${r.concern}\n\n**Error:** ${r.error}\n`);
      continue;
    }
    const content = await readFile(r.workPath, 'utf-8');
    sections.push(`## ${r.concern}\n\n${content}\n`);
  }
  const header = `# Swarm Readout\n\n**Target:** \`${opts.target}\`\n` +
                 `**Target SHA:** ${targetSha}\n` +
                 `**Total cost:** ...\n**Total duration:** ...\n\n---\n`;
  return header + '\n' + sections.join('\n---\n\n');
}
```

## CLI surface sketch

```
swarm-readout --target <path> --output <path> [options]

Options:
  --target <path>     Absolute path to target repo (required)
  --output <path>     Output directory for the final report (required)
  --concerns <list>   Comma-separated subset (default: all 5)
                      Available: deps, tests, ci-workflows, api-surface, docs-security
  --profile <name>    Ollama profile (default: $INTERN_PROFILE or m5-max)
  --dry-run           Validate inputs without dispatching
```

If folded into ollama-intern, the surface might instead be an MCP tool:

```
ollama_swarm_readout({
  target: "/path/to/repo",
  output: "/path/to/repo/docs/swarm-report",
  concerns?: ["deps", "tests"],     // subset
})
→ { reportPath, concernSummaries[], totalDurationMs }
```

The MCP tool form aligns with how Claude/Hermes call other ollama-intern primitives. The CLI form is for direct `npm run` from the target repo.

## Open questions to resolve before implementation

1. **Does this fit `ollama_repo_pack`?** `repo_pack` already produces a fixed-pipeline repo brief. If `swarm_readout` is structurally just "5-concern variant of repo_pack with parallel dispatch," it might be a `repo_pack` mode rather than a new tool. If the parallel-orthogonal-concerns axis is fundamentally different from `repo_pack`'s single-sweep approach, it warrants its own surface.

2. **Tool-call surface vs file-scan-and-inject.** Option (b) vs (c) above. Local model with tool calls (Hermes/Qwen3 over `/v1`) is more powerful but more infrastructure. File-scan-and-inject is simpler but limits the model's ability to navigate.

3. **Token budget for parallel dispatch on M5 Max.** 5 concerns × deep tier (`qwen3:32b`) running in parallel: does the M5 Max 128GB have memory headroom for 5 concurrent loaded contexts, or do they need to serialize? Bench data (from the M5 bench run in ROADMAP) will answer this.

4. **Concern axis generality.** The 5 chosen concerns are npm-shaped. For a Godot project (`*.gd` scripts), a Rust crate (`Cargo.toml`, lifetimes), or a UE5 project (Blueprint + C++), the concerns shift. Either: parameterize the concern set per project type (more work), or scope swarm_readout to npm targets in v0 and generalize later.

5. **Synthesis intelligence.** v0 synthesis is deterministic stitching. A v1 synthesis pass that prioritizes findings, cross-references `[CROSS]` tags, and produces an executive summary would add real value. Out of scope for v0; tracked for v1 if the pattern proves useful.

## Acceptance criteria for promoting "exploring" → "now"

A design decision document that:

- Resolves Q1 (own tool vs `repo_pack` config) with reasoning
- Picks Q2 (file-scan-inject vs tool-call surface) with reasoning
- Has data from the M5 bench run on Q3 (parallel-dispatch memory headroom)
- States the v0 scope on Q4 (npm-only or generalized)
- Names a v0 owner

When those five questions are answered, this entry promotes from `🟡 exploring` to `🟢 unblocked` in [ROADMAP.md](../../ROADMAP.md), and an implementation slice can begin.

## History

- **2026-04-29 14:00** — pattern scaffolded as `dogfood-lab/swarm-readout` using `@anthropic-ai/claude-agent-sdk`. CLI built, `--dry-run` verified, CI green, no API calls made.
- **2026-04-29 ~17:00** — pivoted: Claude SDK route rejected because it requires Anthropic API spend. Local-first ecosystem (ollama-intern, Hermes, local Ollama) is the constitution.
- **2026-04-29 ~18:00** — `dogfood-lab/swarm-readout` deleted on GitHub. Architectural sketch (this doc) preserved here.
