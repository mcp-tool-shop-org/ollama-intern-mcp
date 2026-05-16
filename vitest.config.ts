import { defineConfig } from "vitest/config";

/**
 * Vitest config (FT-002 / Phase 7 — coverage enabled).
 *
 * Coverage provider: v8 (built into Node, faster than istanbul). Requires
 * `@vitest/coverage-v8` in devDependencies. The Phase 7 release adds it;
 * if you see "Coverage provider not found" run:
 *     npm i -D @vitest/coverage-v8
 *
 * Thresholds are deliberately conservative for the baseline pass; raise
 * them in a follow-up wave once the new helpers / new tests land and the
 * baseline number is known.
 *
 * Report formats:
 *   - text: human-readable summary in CI logs
 *   - html: drillable browseable report in ./coverage/
 *   - lcov: machine-readable for Codecov / Coveralls / GitHub Code Scanning
 *   - json-summary: stable shape for the ci-docs doc-drift workflow to grep
 *
 * Run via `npm run test:coverage` (added in package.json by ci-docs/backend-core).
 *
 * ── ci-docs doc-drift marker ────────────────────────────────────
 * COVERAGE-WORKFLOW-MARKER-v1: ci-docs greps this file for the literal
 * string `COVERAGE-WORKFLOW-MARKER` to detect that the coverage block is
 * in place before wiring the doc-drift workflow into the CI run. Do not
 * remove this marker without updating the ci-docs side in lockstep.
 *
 * Expected on-disk artifacts after `npm run test:coverage`:
 *   - coverage/coverage-summary.json  (machine-readable; doc-drift parses)
 *   - coverage/index.html             (human-readable; CI uploads as artifact)
 *   - coverage/lcov.info              (for Codecov / GitHub Code Scanning)
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
