import { defineConfig } from "vitest/config";

/**
 * Vitest config (FT-002 / Phase 7 — coverage enabled).
 *
 * Coverage provider: v8 (built into Node, faster than istanbul). Requires
 * `@vitest/coverage-v8` in devDependencies. The Phase 7 release adds it;
 * if you see "Coverage provider not found" run:
 *     npm i -D @vitest/coverage-v8
 *
 * COVERAGE IS GATED IN CI. The ubuntu/20 cell of ci.yml's verify job runs
 * `npm run test:coverage`, so the thresholds below fail that job. They are
 * the org's coverage ratchet: each one is the measured number rounded down,
 * raised as coverage rises, never lowered to turn a build green; the target
 * is 90. Measured on that cell 2026-10-15
 * (PR #81): lines 89.13, statements 86.7, branches 74.53, functions 89.91.
 * (An earlier version of this header, from 2026-09-11, said nothing in CI ran
 * coverage. That stopped being true when Phase 4b moved the cell's suite run
 * to `test:coverage`.)
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
        lines: 89,
        statements: 86,
        branches: 74,
        functions: 89,
      },
      // Include uncovered files in the report so we see drift before it bites.
      all: true,
    },
  },
});
