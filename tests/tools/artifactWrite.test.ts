/**
 * Shared pack artifact-write helpers (H6).
 *
 * Two guarantees the plain writeFile('w') path lacked:
 *   - collision-safe slugs (never silently overwrite an existing pair)
 *   - atomic, torn-pair-free writes (.json is the last commit marker)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveUniqueArtifactPaths,
  writeArtifactPair,
} from "../../src/tools/packs/artifactWrite.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "intern-artifactwrite-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveUniqueArtifactPaths (H6)", () => {
  it("returns the base slug + paths when nothing collides", async () => {
    const r = await resolveUniqueArtifactPaths(dir, "2026-07-05-1830-auth");
    expect(r.slug).toBe("2026-07-05-1830-auth");
    expect(r.mdPath).toBe(join(dir, "2026-07-05-1830-auth.md"));
    expect(r.jsonPath).toBe(join(dir, "2026-07-05-1830-auth.json"));
  });

  it("uniquifies to -2 when the base .json already exists (never clobbers)", async () => {
    await writeFile(join(dir, "s.json"), "{}", "utf8");
    const r = await resolveUniqueArtifactPaths(dir, "s");
    expect(r.slug).toBe("s-2");
    expect(r.jsonPath).toBe(join(dir, "s-2.json"));
  });

  it("treats a lone .md as a collision too (torn-pair safety)", async () => {
    await writeFile(join(dir, "s.md"), "x", "utf8");
    const r = await resolveUniqueArtifactPaths(dir, "s");
    expect(r.slug).toBe("s-2");
  });

  it("keeps incrementing past multiple existing pairs", async () => {
    await writeFile(join(dir, "s.json"), "{}", "utf8");
    await writeFile(join(dir, "s-2.json"), "{}", "utf8");
    await writeFile(join(dir, "s-3.md"), "x", "utf8"); // .md-only collision on the -3 candidate
    const r = await resolveUniqueArtifactPaths(dir, "s");
    expect(r.slug).toBe("s-4");
  });
});

describe("writeArtifactPair (H6)", () => {
  it("writes both files atomically, .json parseable, no leftover .tmp", async () => {
    const { mdPath, jsonPath } = await resolveUniqueArtifactPaths(dir, "s");
    await writeArtifactPair(dir, mdPath, "# hi", jsonPath, JSON.stringify({ pack: "incident_pack" }));
    expect(await readFile(mdPath, "utf8")).toBe("# hi");
    expect(JSON.parse(await readFile(jsonPath, "utf8")).pack).toBe("incident_pack");
    // atomicWriteFile cleans up its tmp files — none should linger.
    const entries = await readdir(dir);
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("creates the artifact dir when it does not yet exist", async () => {
    const nested = join(dir, "incident");
    const { mdPath, jsonPath } = await resolveUniqueArtifactPaths(nested, "s");
    await writeArtifactPair(nested, mdPath, "# hi", jsonPath, "{}");
    expect(await readFile(mdPath, "utf8")).toBe("# hi");
  });
});
