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
  const res = spawnSync("npm", ["pack", "--dry-run", "--json"], {
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
});
