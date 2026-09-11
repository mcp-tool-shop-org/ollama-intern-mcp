import { defineConfig } from "vitest/config";

/**
 * Vitest config (FT-002 / Phase 7 — coverage enabled).
 *
 * Coverage provider: v8 (built into Node, faster than istanbul). Requires
 * `@vitest/coverage-v8` in devDependencies. The Phase 7 release adds it;
 * if you see "Coverage provider not found" run:
 *     npm i -D @vitest/coverage-v8
 *
 * ⚠ COVERAGE IS NOT GATED IN CI (measured 2026-09-11, wave 9 / F-67bfe1fa).
 * Nothing under .github/workflows runs `npm run test:coverage`; the only
 * reference to it in the whole repo is its own line in package.json. The
 * thresholds below therefore fail exactly one thing — a developer who runs
 * `npm run test:coverage` by hand — and gate nothing on a push, a PR or a
 * release. Treat them as a local smoke floor, not a contract.
 *
 * This header used to claim otherwise, in two ways that cost a reader time:
 *   - a coverage-workflow marker paragraph asserting that a ci-docs job greps
 *     this file for a magic literal and that the literal must not be removed
 *     "without updating the ci-docs side in lockstep". That string occurred
 *     exactly twice in the repo, both inside the comment describing itself.
 *     Nothing grepped it. Deleted, literal included — so a grep for it now
 *     correctly returns nothing.
 *   - "coverage/coverage-summary.json (machine-readable; doc-drift parses)".
 *     doc-drift.yml parses a TEST_COUNT marker in HANDOFF.md, never coverage.
 *     Deleted.
 *
 * To make the thresholds real: add a coverage leg to the existing ubuntu/20
 * job in ci.yml (`npm run test:coverage`) and set each threshold to the
 * measured number minus a few points — the evidence-based-floor discipline
 * evals/README.md already documents for the retrieval pack. Until someone
 * does that, the numbers below are unmeasured against CI and the honest thing
 * is to say so rather than to keep promising a follow-up wave (this comment
 * promised one for eight waves).
 *
 * Report formats, produced under ./coverage/ by `npm run test:coverage`:
 *   - text: human-readable summary in the terminal
 *   - html: drillable browseable report (coverage/index.html)
 *   - lcov: machine-readable (coverage/lcov.info), if a service is ever wired
 *   - json-summary: stable shape (coverage/coverage-summary.json) for a future
 *     consumer; no consumer exists today
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Per-file test timeout — 30s default. The integration suite
    // (tests/integration/**) spawns dist/index.js as a subprocess; each
    // individual test sets its own 30_000 explicitly. The global bump
    // here covers any slow corpus-disk or process-spawn case.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "tests/**",
        // src/index.ts is the MCP entrypoint (registers 41 tools, then
        // spawns the stdio server). Excluded from coverage because it
        // can only be exercised by spawning a subprocess — the new
        // mcp.integration.test.ts suite does that and provides the
        // real-world cover; counting it as "uncovered" would punish
        // the ratio without adding signal.
        "src/index.ts",
      ],
      thresholds: {
        lines: 70,
        statements: 70,
        branches: 60,
        functions: 70,
      },
      // Include uncovered files in the report so we see drift before it bites.
      all: true,
    },
  },
});
