/**
 * Shared pack artifact-write helpers (H6).
 *
 * Two guarantees the plain writeFile('w') path lacked:
 *   - collision-safe slugs (never silently overwrite an existing pair)
 *   - atomic, torn-pair-free writes (.json is the last commit marker)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Surgical seam for the reserve-or-throw test: real fs everywhere, but when
// `forceOpenEexist.on` is set, node:fs/promises `open` rejects with EEXIST so
// every exclusive-create reservation collides (the astronomical corner).
const { forceOpenEexist } = vi.hoisted(() => ({ forceOpenEexist: { on: false } }));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: (...args: unknown[]) =>
      forceOpenEexist.on
        ? Promise.reject(Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" }))
        : (actual.open as (...a: unknown[]) => unknown)(...args),
  };
});

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

  it("throws (reserve-or-throw) rather than returning an UNRESERVED slug when every reservation collides — advisor-jury-surfaced", async () => {
    // Two cross-family jurors converged: the old fallback returned the
    // ms-suffix candidate WITHOUT a held reservation on a double-collision, so
    // two concurrent runs could clobber. Force every exclusive-create to EEXIST
    // and assert the resolver THROWS instead of returning an unclaimed slug.
    forceOpenEexist.on = true;
    try {
      await expect(resolveUniqueArtifactPaths(dir, "collide")).rejects.toThrow(
        /Could not reserve a unique artifact slug/,
      );
    } finally {
      forceOpenEexist.on = false;
    }
  });

  it("keeps incrementing past multiple existing pairs", async () => {
    await writeFile(join(dir, "s.json"), "{}", "utf8");
    await writeFile(join(dir, "s-2.json"), "{}", "utf8");
    await writeFile(join(dir, "s-3.md"), "x", "utf8"); // .md-only collision on the -3 candidate
    const r = await resolveUniqueArtifactPaths(dir, "s");
    expect(r.slug).toBe("s-4");
  });

  it("two genuinely-concurrent resolves for the same slug get DIFFERENT slugs (H6-res)", async () => {
    // The old check-then-act (access() then, later, write) let two concurrent
    // runs both see the base slug free and clobber. The exclusive-create
    // reservation makes the claim atomic: one wins the base slug, the other
    // gets EEXIST and uniquifies.
    const [a, b] = await Promise.all([
      resolveUniqueArtifactPaths(dir, "concurrent"),
      resolveUniqueArtifactPaths(dir, "concurrent"),
    ]);
    expect(a.slug).not.toBe(b.slug);
    expect(new Set([a.slug, b.slug])).toEqual(new Set(["concurrent", "concurrent-2"]));
  });
});

describe("writeArtifactPair — concurrency (H6-res)", () => {
  it("two concurrent same-title pack writes both survive on disk — neither clobbers", async () => {
    const run = async (): Promise<string> => {
      const p = await resolveUniqueArtifactPaths(dir, "boom");
      await writeArtifactPair(
        dir,
        p.mdPath,
        `# ${p.slug}`,
        p.jsonPath,
        JSON.stringify({ pack: "incident_pack", slug: p.slug }),
      );
      return p.slug;
    };
    const [s1, s2] = await Promise.all([run(), run()]);
    expect(s1).not.toBe(s2);
    // Both complete artifact pairs exist — one uniquified, neither clobbered.
    const jsons = (await readdir(dir)).filter((e) => e.endsWith(".json")).sort();
    expect(jsons).toEqual(["boom-2.json", "boom.json"].sort());
    // No leftover reservation / tmp cruft.
    expect((await readdir(dir)).some((e) => e.endsWith(".tmp"))).toBe(false);
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
