/**
 * Shared source-file loader used by tools that accept `source_paths[]`.
 *
 * The point of a path-based tool input is context preservation — Claude does
 * not pre-read the file, the server does. Keep this module fast and boring.
 */

import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { InternError } from "./errors.js";

export interface LoadedSource {
  path: string;
  body: string;
}

/**
 * Read each path, slice to `perFileMax` chars per file, return in input order.
 * Throws SOURCE_PATH_NOT_FOUND on the first missing/unreadable path so the
 * caller fails loud instead of getting a partial answer.
 */
export async function loadSources(
  paths: string[],
  perFileMax: number,
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
