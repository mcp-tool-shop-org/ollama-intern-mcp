/**
 * Artifact markdown export — narrow handoff move, not a generic writer.
 *
 * Laws:
 *   - Reads the artifact's EXISTING markdown file. No re-render, no
 *     model call.
 *   - Prepends a provenance header (HTML comment) so exported files
 *     keep identity and point back at the source JSON.
 *   - Path safety is strict:
 *       - target_path must be absolute
 *       - no '..' segments in the input path (checked before normalize)
 *       - must end in .md
 *       - must live under one of the caller-supplied allowed_roots —
 *         no global default. The caller declares where export may
 *         write; the tool never guesses.
 *   - Overwrite is opt-in. Default refuses when target exists so
 *     re-runs never clobber a hand-edited copy silently.
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, normalize, sep } from "node:path";
import { InternError } from "../../errors.js";
import type { PackArtifact } from "./scan.js";

export interface ExportOptions {
  target_path: string;
  allowed_roots: string[];
  overwrite?: boolean;
}

export interface ExportResult {
  target_path: string;
  bytes_written: number;
  overwrote: boolean;
  provenance: {
    pack: string;
    slug: string;
    created_at: string;
    source_json_path: string;
  };
  exported_at: string;
}

function safeNormalize(p: string, fieldName: string): string {
  if (!isAbsolute(p)) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${fieldName} must be absolute: ${p}`,
      "Pass absolute paths only — export never resolves against a working directory.",
      false,
    );
  }
  const rawSegments = p.split(/[/\\]/);
  if (rawSegments.includes("..")) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${fieldName} contains parent traversal: ${p}`,
      "Paths must resolve cleanly without '..' segments, even if they would collapse to a safe location.",
      false,
    );
  }
  return normalize(p);
}

function assertUnderAllowedRoots(target: string, allowed: string[]): void {
  if (allowed.length === 0) {
    throw new InternError(
      "SCHEMA_INVALID",
      "export refused: allowed_roots is empty.",
      "The caller must declare at least one allowed_root (an absolute directory the export may write into). This tool never writes without an explicit allowlist.",
      false,
    );
  }
  const underOne = allowed.some((root) => {
    const withSep = root.endsWith(sep) ? root : root + sep;
    return target === root || target.startsWith(withSep);
  });
  if (!underOne) {
    throw new InternError(
      "SCHEMA_INVALID",
      `target_path is not under any allowed_root: ${target}`,
      `Allowed roots: ${allowed.join(", ")}. Add the target's parent directory to allowed_roots, or pick a different target_path.`,
      false,
    );
  }
}

function renderProvenance(art: PackArtifact, exportedAt: string): string {
  return [
    `<!--`,
    `Exported from ollama-intern artifact`,
    `  pack:         ${art.pack}`,
    `  slug:         ${art.slug}`,
    `  title:        ${art.title}`,
    `  generated_at: ${art.generated_at}`,
    `  source_json:  ${art.artifact.json_path}`,
    `  exported_at:  ${exportedAt}`,
    `-->`,
    "",
  ].join("\n");
}

/**
 * Execute the export. Takes the resolved artifact + target details
 * and writes the artifact's existing markdown (with a provenance
 * header prepended) to target_path.
 */
export async function exportArtifactMarkdown(
  artifact: PackArtifact,
  opts: ExportOptions,
): Promise<ExportResult> {
  // Validate target_path.
  const normalizedTarget = safeNormalize(opts.target_path, "target_path");
  if (!normalizedTarget.endsWith(".md")) {
    throw new InternError(
      "SCHEMA_INVALID",
      `target_path must end in .md: ${opts.target_path}`,
      "Export writes markdown only. Pick a target filename ending in .md.",
      false,
    );
  }

  // Validate and assert allowed_roots.
  const normalizedRoots = opts.allowed_roots.map((r) => safeNormalize(r, "allowed_roots entry"));
  assertUnderAllowedRoots(normalizedTarget, normalizedRoots);

  // Check overwrite policy.
  const exists = existsSync(normalizedTarget);
  if (exists && !opts.overwrite) {
    throw new InternError(
      "SCHEMA_INVALID",
      `target_path exists and overwrite=false: ${normalizedTarget}`,
      "Pass overwrite: true to replace the file, or pick a different target_path. Export never clobbers by default.",
      false,
    );
  }

  // Confirm the existing file isn't a directory before we try to write.
  if (exists) {
    const st = await stat(normalizedTarget);
    if (st.isDirectory()) {
      throw new InternError(
        "SCHEMA_INVALID",
        `target_path is a directory, not a file: ${normalizedTarget}`,
        "Pick a target_path that names a .md file, not a directory.",
        false,
      );
    }
  }

  // Read the artifact's existing markdown — this is a handoff, not a re-render.
  const sourceMdPath = artifact.artifact.markdown_path;
  let sourceMd: string;
  try {
    sourceMd = await readFile(sourceMdPath, "utf8");
  } catch (err) {
    throw new InternError(
      "SOURCE_PATH_NOT_FOUND",
      `Artifact markdown file not readable: ${sourceMdPath} — ${err instanceof Error ? err.message : String(err)}`,
      "The source .md file may have been moved or deleted. Re-run the pack that produced this artifact.",
      false,
    );
  }

  // Prepend provenance.
  const exportedAt = new Date().toISOString();
  const body = renderProvenance(artifact, exportedAt) + sourceMd;

  // Write.
  await mkdir(dirname(normalizedTarget), { recursive: true });
  await writeFile(normalizedTarget, body, "utf8");

  return {
    target_path: normalizedTarget,
    bytes_written: Buffer.byteLength(body, "utf8"),
    overwrote: exists,
    provenance: {
      pack: artifact.pack,
      slug: artifact.slug,
      created_at: artifact.generated_at,
      source_json_path: artifact.artifact.json_path,
    },
    exported_at: exportedAt,
  };
}
