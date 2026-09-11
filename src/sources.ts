/**
 * Shared source-file loader used by tools that accept `source_paths[]`.
 *
 * The point of a path-based tool input is context preservation — Claude does
 * not pre-read the file, the server does. Keep this module fast and boring.
 */

import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { InternError } from "./errors.js";
import { formatBytes } from "./format.js";

export interface LoadedSource {
  path: string;
  body: string;
}

/**
 * Hard cap on a single source file's byte size — mirrors the indexer's
 * MAX_FILE_BYTES. loadSources only ever uses the first `perFileMax` CHARS, but
 * it read the WHOLE file into a JS string first: a multi-hundred-MB log (the
 * advertised incident_pack workload) OOM'd, and a file over V8's ~512MB string
 * limit threw ERR_STRING_TOO_LONG surfaced as a misleading SOURCE_PATH_NOT_FOUND.
 * We now reject over-cap files via the already-open handle's stat BEFORE any
 * read (never buffering the whole file), with a distinct SOURCE_FILE_TOO_LARGE
 * so callers can tell "too big" apart from "missing". (M7, 2026-07 health pass.)
 */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/**
 * Read each path, slice to `perFileMax` chars per file, return in input order.
 * Throws SOURCE_PATH_NOT_FOUND on the first missing/unreadable path, and
 * SOURCE_FILE_TOO_LARGE on the first file whose byte size exceeds `maxBytes`
 * (default MAX_SOURCE_BYTES) — either way failing loud instead of a partial
 * answer or an OOM. `maxBytes` is an override seam (tests / future per-caller
 * caps); production callers pass two args and get the default.
 */
export async function loadSources(
  paths: string[],
  perFileMax: number,
  maxBytes: number = MAX_SOURCE_BYTES,
): Promise<LoadedSource[]> {
  const loaded: LoadedSource[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    // Open once and operate on the handle: the is-file check and the read
    // then observe the same inode, so a path swapped between a stat() and a
    // path-based readFile() can't slip a different file through
    // (CodeQL js/file-system-race).
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(abs, "r");
      const st = await fh.stat();
      if (!st.isFile()) {
        throw new InternError(
          "SOURCE_PATH_NOT_FOUND",
          `Not a file: ${p}`,
          "Check that the path points at a regular file, not a directory. Tools that accept source_paths (research, summarize_deep, brief/pack tools) never recurse into directories — list each file explicitly, or run `ollama_corpus_index` first if you need to cover a whole tree.",
          false,
        );
      }
      // Size gate BEFORE reading — st.size reports the bytes we are about to
      // read off this exact handle, so an over-cap file never gets buffered.
      if (st.size > maxBytes) {
        throw new InternError(
          "SOURCE_FILE_TOO_LARGE",
          `Source file exceeds the ${formatBytes(maxBytes)} cap (${formatBytes(st.size)}): ${p}`,
          `This tool reads whole files into memory and only uses the first ${perFileMax.toLocaleString("en-US")} chars, so a huge file is wasteful and can OOM the server. Split the file, point at a smaller excerpt, or run 'ollama_corpus_index' to search a large corpus without loading it whole.`,
          false,
        );
      }
      const raw = await fh.readFile("utf8");
      loaded.push({ path: p, body: raw.slice(0, perFileMax) });
    } catch (err) {
      if (err instanceof InternError) throw err;
      throw new InternError(
        "SOURCE_PATH_NOT_FOUND",
        `Cannot read source path: ${p} — ${(err as Error).message}`,
        "Check the path exists and is readable.",
        false,
      );
    } finally {
      await fh?.close();
    }
  }
  return loaded;
}

/** Format loaded sources as a single prompt block with begin/end markers per file. */
export function formatSourcesBlock(sources: LoadedSource[]): string {
  return sources
    .map((s) => `=== BEGIN ${s.path} ===\n${s.body}\n=== END ${s.path} ===`)
    .join("\n\n");
}
