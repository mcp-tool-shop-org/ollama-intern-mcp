// Tarball contract test.
//
// Runs `npm pack --dry-run --json` and asserts the published tarball contains
// exactly the artifacts we want to ship — no accidental src/, tests/, site/,
// CI config, or loose tarballs — and stays within a reasonable size / file
// count envelope. This is the last line of defense against a files/.npmignore
// regression silently shipping private-looking content to npm.
//
// The test is skipped if `npm` is not on PATH (rare, but keeps this from
// turning red on a minimal sandbox). It never writes a tarball to disk — we
// rely on `--dry-run`, so repeated runs are idempotent.

import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * Size-regression floor for the published tarball.
 *
 * The "size" field in `npm pack --json` output is the COMPRESSED tarball size
 * in bytes. At v2.0.2 with the current dist/ output, this sits around
 * ~302 KB. We fail if a change pushes the compressed size more than 10%
 * above this baseline — an early signal that something accidentally got
 * added to `files`, dist/ swelled, or a sourcemap/asset leaked into the
 * tarball.
 *
 * Update process when the baseline moves legitimately (e.g. new shipped tool
 * or required asset): run `npm pack --dry-run --json | jq '.[0].size'` on a
 * clean build of main, and set BASELINE_PACKED_BYTES to that value. Keep the
 * tolerance at 10% unless you have a reason to widen it.
 */
export const BASELINE_PACKED_BYTES = 310_000;
export const BASELINE_TOLERANCE = 0.10;

type PackEntry = { path: string; size: number; mode: number };
type PackReport = {
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackEntry[];
};

function npmOnPath(): boolean {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["npm"], {
    encoding: "utf8",
  });
  return which.status === 0;
}

function runPackDryRun(): PackReport | null {
  if (!npmOnPath()) return null;
  // On Windows, `npm` resolves to npm.cmd — spawnSync needs shell:true so the
  // shim is found the same way the user's terminal finds it.
  // --ignore-scripts: our prepack runs `clean && build`, which races the
  // mcpGolden subprocess test by wiping dist/ mid-spawn. Skipping scripts
  // here is safe: the suite runs after `npm run build` (see beforeAll in
  // mcpGolden.test.ts and the `verify` / `ship` scripts), so dist/ is already
  // present and current. The tarball listing does NOT require prepack to run.
  const res = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    // Give npm enough time on cold caches; still bounded so a hung child
    // fails the suite instead of hanging CI.
    timeout: 60_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `npm pack --dry-run --json exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  // npm emits some stderr notices even on success; stdout is the JSON array.
  const parsed = JSON.parse(res.stdout) as PackReport[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`npm pack --json returned no report: ${res.stdout}`);
  }
  return parsed[0];
}

describe("tarball contract (npm pack --dry-run)", () => {
  let report: PackReport | null = null;

  beforeAll(() => {
    report = runPackDryRun();
  });

  it.skipIf(!npmOnPath())("includes required top-level files", () => {
    expect(report).not.toBeNull();
    const paths = report!.files.map((f) => f.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("SECURITY.md");
    expect(paths).toContain("package.json");
    // dist/ is the actual shipped code — at least the entrypoint must be there.
    expect(paths.some((p) => p === "dist/index.js")).toBe(true);
    expect(paths.some((p) => p.startsWith("dist/") && p.endsWith(".js"))).toBe(true);
    expect(paths.some((p) => p.startsWith("dist/") && p.endsWith(".d.ts"))).toBe(true);
  });

  it.skipIf(!npmOnPath())("excludes source, tests, site, CI config, and loose tarballs", () => {
    expect(report).not.toBeNull();
    const paths = report!.files.map((f) => f.path);

    // Hard denylist — if any of these match, something leaked.
    const forbiddenPrefixes = ["src/", "tests/", "site/", ".github/", "bench/", "evals/"];
    for (const prefix of forbiddenPrefixes) {
      const leaks = paths.filter((p) => p.startsWith(prefix));
      expect(leaks, `forbidden prefix leaked into tarball: ${prefix}`).toEqual([]);
    }

    // Pattern denylist — test files and any stray tarballs.
    const forbiddenPatterns: Array<[RegExp, string]> = [
      [/\.test\.(ts|js|mjs|cjs)$/, "test file"],
      [/\.spec\.(ts|js|mjs|cjs)$/, "spec file"],
      [/\.tgz$/, "nested tarball"],
      [/(^|\/)tsconfig(\..+)?\.json$/, "tsconfig"],
      [/(^|\/)vitest\.config\.(ts|js|mjs|cjs)$/, "vitest config"],
    ];
    for (const [pattern, label] of forbiddenPatterns) {
      const leaks = paths.filter((p) => pattern.test(p));
      expect(leaks, `${label} leaked into tarball`).toEqual([]);
    }
  });

  it.skipIf(!npmOnPath())("keeps file count and unpacked size within the expected envelope", () => {
    expect(report).not.toBeNull();
    // Current tarball ships ~275 files. This envelope catches both sudden
    // explosions (leaked directory) and unexpected shrinkage (missing dist
    // build). Widen deliberately when the real count moves.
    expect(report!.entryCount).toBeGreaterThanOrEqual(200);
    expect(report!.entryCount).toBeLessThanOrEqual(400);

    // Hard ceiling: 2MB unpacked. Currently ~1.0 MB. If we ever approach this,
    // it's almost certainly a mistake worth investigating before release.
    const TWO_MB = 2 * 1024 * 1024;
    expect(report!.unpackedSize).toBeLessThan(TWO_MB);
  });

  it.skipIf(!npmOnPath())("ships the package under the expected name", () => {
    expect(report).not.toBeNull();
    expect(report!.name).toBe("ollama-intern-mcp");
  });

  it.skipIf(!npmOnPath())("stays under the packed-size regression baseline (+10%)", () => {
    // Fails loudly when a commit grows the COMPRESSED tarball more than 10%
    // above BASELINE_PACKED_BYTES. Sitting at ~302 KB as of v2.0.2 — the
    // ceiling is 341 KB. When the baseline legitimately moves, update
    // BASELINE_PACKED_BYTES per the comment above (not the tolerance).
    expect(report).not.toBeNull();
    const ceiling = Math.floor(BASELINE_PACKED_BYTES * (1 + BASELINE_TOLERANCE));
    expect(
      report!.size,
      `packed size ${report!.size} bytes exceeds baseline ceiling ${ceiling} bytes ` +
        `(baseline ${BASELINE_PACKED_BYTES} + ${BASELINE_TOLERANCE * 100}% tolerance). ` +
        `If this growth is intentional, bump BASELINE_PACKED_BYTES in tests/pack.test.ts.`,
    ).toBeLessThanOrEqual(ceiling);
  });
});
