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
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteFile } from "../../corpus/atomicWrite.js";
import { InternError } from "../../errors.js";
import { assertWriteAllowed } from "../../guardrails/writeConfirm.js";

export interface ArtifactPaths {
  slug: string;
  mdPath: string;
  jsonPath: string;
}

/** Operator artifact cap — INTERN_ARTIFACT_DIR, else ~/.ollama-intern/artifacts. */
export function internArtifactRoot(): string {
  return process.env.INTERN_ARTIFACT_DIR ?? join(homedir(), ".ollama-intern", "artifacts");
}

function hasParentSegment(p: string): boolean {
  return p.split(/[/\\]/).includes("..");
}

function isUnderRoot(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (isAbsolute(rel)) return false;
  return rel.split(/[/\\]/)[0] !== "..";
}

/** Absolute, no `..` — same lexical gate as artifact export. */
function safeAbsDir(p: string, fieldName: string): string {
  if (!isAbsolute(p)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${fieldName} must be absolute: ${p}`,
      "Pass an absolute directory — pack artifact writes never resolve against a working directory.",
      false,
    );
  }
  if (hasParentSegment(p)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${fieldName} contains parent traversal: ${p}`,
      "Paths must resolve cleanly without '..' segments, even if they would collapse to a safe location.",
      false,
    );
  }
  return normalize(p);
}

/**
 * Resolve the directory a pack will mkdir/write into.
 *
 * When `artifact_dir` is omitted, the pack default (under the intern
 * artifact root) is used. When the caller supplies it, the path must be
 * absolute, must not contain `..`, and must sit under INTERN_ARTIFACT_DIR
 * (or ~/.ollama-intern/artifacts) OR a caller-declared allowed_roots list
 * — export's dual-declaration write law.
 */
export function resolvePackArtifactDir(opts: {
  artifact_dir: string | undefined;
  allowed_roots: string[] | undefined;
  defaultDir: string;
}): string {
  if (opts.artifact_dir === undefined) {
    return opts.defaultDir;
  }
  const dir = safeAbsDir(opts.artifact_dir, "artifact_dir");
  const internRoot = internArtifactRoot();
  if (isUnderRoot(dir, internRoot)) {
    return dir;
  }
  const roots = opts.allowed_roots ?? [];
  if (roots.length === 0) {
    throw new InternError(
      "SCHEMA_INVALID",
      `artifact_dir is not under INTERN_ARTIFACT_DIR (${internRoot}): ${dir}`,
      "Point artifact_dir inside INTERN_ARTIFACT_DIR (or ~/.ollama-intern/artifacts), or declare allowed_roots containing this directory — the same dual-declaration ollama_artifact_export_to_path requires.",
      false,
    );
  }
  const normalizedRoots = roots.map((r) => safeAbsDir(r, "allowed_roots entry"));
  if (!normalizedRoots.some((root) => isUnderRoot(dir, root))) {
    throw new InternError(
      "SCHEMA_INVALID",
      `artifact_dir is not under INTERN_ARTIFACT_DIR or any allowed_root: ${dir}`,
      `Intern root: ${internRoot}. Allowed roots: ${normalizedRoots.join(", ")}.`,
      false,
    );
  }
  return dir;
}

/** Draft confirm_write / protected-path gate on pack write targets. */
export function assertPackArtifactWriteAllowed(
  paths: string[],
  confirm_write: boolean | undefined,
): void {
  for (const target_path of paths) {
    assertWriteAllowed({ target_path, confirm_write });
  }
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
  // Pathological: ~1000 same-slug artifacts already exist. Fall back to a
  // RANDOM-salted suffix — still exclusive-create, so a returned slug is one
  // this call has atomically claimed and can never clobber a live pair. Bounded
  // retries; if even 64 random 48-bit salts all collide (astronomically
  // unlikely), throw loud rather than return an UNRESERVED slug a concurrent
  // run could clobber. The invariant is reserve-or-throw — the jury caught the
  // old code returning the unreserved ms-suffix candidate on a double-collision.
  for (let attempt = 0; attempt < 64; attempt++) {
    c = candidate(`${baseSlug}-${randomBytes(6).toString("hex")}`);
    if (await tryReserve(c)) return c;
  }
  throw new InternError(
    "INTERNAL",
    `Could not reserve a unique artifact slug for "${baseSlug}" after ~1064 attempts.`,
    "The artifact directory holds an extraordinary number of same-slug artifacts. Prune old artifacts with ollama_artifact_prune, or point INTERN_ARTIFACT_DIR at a fresh directory.",
    false,
  );
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
