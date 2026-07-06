/**
 * H8-res (2026-07 health pass) — the H8 fix gated the GHCR docker push on the
 * npm job (which holds the ONLY verify + tag-vs-package.json guard) via
 * `needs: npm`. That gate shipped with no test, so a future edit dropping it
 * would go unnoticed until a broken/untested image shipped to :latest. This
 * CI-lint parses release.yml and asserts the dependency structurally — deleting
 * `needs: npm` from the docker job turns it RED.
 *
 * No YAML dependency (deps are deliberately minimal); we scope to the
 * 2-space-indented job block so the check can't false-match a `needs:` in
 * another job.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

/** Extract a top-level (2-space-indented) job's block from a workflow YAML. */
function jobBlock(yaml: string, name: string): string {
  const header = new RegExp(`^  ${name}:\\s*$`, "m").exec(yaml);
  if (!header) return "";
  const rest = yaml.slice(header.index + header[0].length);
  // The block ends at the next 2-space-indented job key, or EOF.
  const nextJob = /^  [A-Za-z_][\w-]*:/m.exec(rest);
  return nextJob ? rest.slice(0, nextJob.index) : rest;
}

describe("release.yml — GHCR push is gated on the npm verify job (H8-res)", () => {
  it("the docker job declares `needs: npm`, and the npm job holds the verify gate", async () => {
    const src = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const npm = jobBlock(src, "npm");
    const docker = jobBlock(src, "docker");

    // Both jobs must exist.
    expect(npm, "release.yml must define an npm job").not.toBe("");
    expect(docker, "release.yml must define a docker job").not.toBe("");

    // The load-bearing verify (typecheck+build+test) lives in the npm job, so
    // gating docker on it is meaningful.
    expect(npm, "the npm job must run `npm run verify`").toMatch(/npm run verify/);

    // The GHCR push job MUST depend on npm so a failing verify / tag-mismatch
    // skips the push. Anchor `needs:` to line-start (after indent) so a
    // COMMENTED-OUT `# needs: npm` doesn't false-match. Accept scalar or inline
    // list; the current file uses the scalar form.
    expect(
      docker,
      "docker job must `needs: npm` (a broken tree must never reach GHCR :latest)",
    ).toMatch(/^\s*needs:\s*(?:npm\b|\[[^\]]*\bnpm\b[^\]]*\])/m);
  });
});
