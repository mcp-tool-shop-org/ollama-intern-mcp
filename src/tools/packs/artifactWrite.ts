/**
 * Shared artifact-write helpers for the incident / repo / change packs.
 *
 * Two guarantees the plain `writeFile(path, ..., { flag: 'w' })` path
 * lacked (H6):
 *
 *   1. Collision-safe slugs. Pack slugs are minute-resolution (buildSlug),
 *      so a retry after a timed-out MCP response — or two same-minute runs
 *      with the same title — computes an identical slug. The old write
 *      silently overwrote the first artifact pair.
 *      `resolveUniqueArtifactPaths` never returns a slug whose `.md` OR
 *      `.json` already exists: it appends `-2`, `-3`, … so the second run
 *      writes a NEW pair beside the first instead of clobbering it.
 *
 *   2. Atomic, torn-pair-free writes. `writeArtifactPair` writes each file
 *      via `atomicWriteFile` (tmp + fsync + rename — never a truncated
 *      file on a crash) and writes the `.json` LAST as the commit marker.
 *      artifact_list / scan enumerate the `.json`, so any *listed* artifact
 *      is guaranteed to already have a complete `.md` on disk. A crash can
 *      leave at most a stray (unlisted, harmless) `.md`, never a `.json`
 *      that points at a missing or torn `.md`.
 */
import { access, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../corpus/atomicWrite.js";

export interface ArtifactPaths {
  slug: string;
  mdPath: string;
  jsonPath: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a collision-free slug + its `.md`/`.json` paths under
 * `artifactDir`. The base slug wins when free; otherwise `-2`, `-3`, …
 * until neither the `.md` nor the `.json` exists. Bounded so a
 * pathological directory can't loop forever — after 998 collisions it
 * falls back to a high-resolution millisecond suffix rather than clobber.
 */
export async function resolveUniqueArtifactPaths(
  artifactDir: string,
  baseSlug: string,
): Promise<ArtifactPaths> {
  await mkdir(artifactDir, { recursive: true });
  const candidate = (slug: string): ArtifactPaths => ({
    slug,
    mdPath: join(artifactDir, `${slug}.md`),
    jsonPath: join(artifactDir, `${slug}.json`),
  });
  // H6-res: RESERVE the slug atomically instead of the old check-then-act
  // (access() now, a separate write later) which let two genuinely-concurrent
  // same-slug runs both see the slug free and clobber. Exclusive-create ('wx')
  // of the `.md` IS the atomic claim: the loser gets EEXIST and uniquifies. The
  // empty reservation is overwritten by writeArtifactPair's atomic `.md` write;
  // a reservation left by an aborted run is an unlisted, harmless `.md` (scan
  // enumerates `.json`). We also skip any slug whose `.json` already exists (a
  // prior COMPLETE artifact) so a finished pair is never reserved over.
  const tryReserve = async (c: ArtifactPaths): Promise<boolean> => {
    if (await pathExists(c.jsonPath)) return false;
    try {
      const fh = await open(c.mdPath, "wx"); // exclusive create — throws EEXIST if taken
      await fh.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  let c = candidate(baseSlug);
  if (await tryReserve(c)) return c;
  for (let n = 2; n <= 999; n++) {
    c = candidate(`${baseSlug}-${n}`);
    if (await tryReserve(c)) return c;
  }
  // Pathological: ~1000 same-slug artifacts already exist. A millisecond suffix
  // — still exclusive-create so even this fallback never clobbers a live pair.
  c = candidate(`${baseSlug}-${Date.now()}`);
  if (await tryReserve(c)) return c;
  // Astronomically unlikely double-collision on the ms suffix — return it and
  // let writeArtifactPair's atomic (salted-tmp, torn-free) write land, rather
  // than loop forever.
  return c;
}

/**
 * Write the artifact pair atomically, `.json` LAST as the commit marker.
 * Callers pass FINAL paths (already de-collided via
 * resolveUniqueArtifactPaths). Throws on any filesystem failure — the pack
 * handlers catch it and record the artifact as not-written.
 */
export async function writeArtifactPair(
  artifactDir: string,
  mdPath: string,
  markdown: string,
  jsonPath: string,
  jsonPayload: string,
): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  // `.md` first (atomic), then `.json` LAST — the `.json` is what
  // artifact_list enumerates, so it becoming visible means the whole
  // artifact is durably on disk.
  await atomicWriteFile(mdPath, markdown);
  await atomicWriteFile(jsonPath, jsonPayload);
}
