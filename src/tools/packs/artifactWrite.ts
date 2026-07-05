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
import { access, mkdir } from "node:fs/promises";
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
  const candidate = (slug: string): ArtifactPaths => ({
    slug,
    mdPath: join(artifactDir, `${slug}.md`),
    jsonPath: join(artifactDir, `${slug}.json`),
  });
  const isFree = async (c: ArtifactPaths): Promise<boolean> =>
    !(await pathExists(c.mdPath)) && !(await pathExists(c.jsonPath));

  let c = candidate(baseSlug);
  if (await isFree(c)) return c;
  for (let n = 2; n <= 999; n++) {
    c = candidate(`${baseSlug}-${n}`);
    if (await isFree(c)) return c;
  }
  // Pathological: ~1000 same-slug artifacts already exist. Use a unique
  // millisecond suffix instead of overwriting or looping forever.
  return candidate(`${baseSlug}-${Date.now()}`);
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
