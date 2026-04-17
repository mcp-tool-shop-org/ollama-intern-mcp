/**
 * Shared source-file loader used by tools that accept `source_paths[]`.
 *
 * The point of a path-based tool input is context preservation — Claude does
 * not pre-read the file, the server does. Keep this module fast and boring.
 */

import { readFile, stat } from "node:fs/promises";
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
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        throw new InternError(
          "SOURCE_PATH_NOT_FOUND",
          `Not a file: ${p}`,
          "Pass file paths only, not directories.",
          false,
        );
      }
      const raw = await readFile(abs, "utf8");
      loaded.push({ path: p, body: raw.slice(0, perFileMax) });
    } catch (err) {
      if (err instanceof InternError) throw err;
      throw new InternError(
        "SOURCE_PATH_NOT_FOUND",
        `Cannot read source path: ${p} — ${(err as Error).message}`,
        "Check the path exists and is readable.",
        false,
      );
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
