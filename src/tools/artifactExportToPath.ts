/**
 * ollama_artifact_export_to_path — handoff move, not a writer framework.
 *
 * Reads the artifact's existing markdown (no re-render, no model call),
 * prepends a provenance header so exported files keep identity, and
 * writes to a caller-supplied absolute path under caller-supplied
 * allowed_roots. Overwrite is opt-in by design.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import {
  KNOWN_PACKS,
  resolveArtifactByIdentity,
  readArtifactAtPath,
  type PackName,
} from "./artifacts/scan.js";
import { exportArtifactMarkdown, type ExportResult } from "./artifacts/export.js";

export const artifactExportToPathSchema = z.object({
  pack: z.enum(KNOWN_PACKS as unknown as [PackName, ...PackName[]]).describe("Pack identity of the source artifact."),
  slug: z.string().min(1).describe("Source artifact slug."),
  target_path: z.string().min(1).describe("Absolute target path. Must end in .md, must live under one of allowed_roots, no '..' segments."),
  allowed_roots: z
    .array(z.string().min(1))
    .min(1)
    .describe("Absolute directories the export may write into. REQUIRED — the caller declares intent; the tool never guesses a default. Empty list is refused."),
  overwrite: z.boolean().optional().describe("If true, replace an existing file at target_path. Default false; existing files refuse the export so re-runs never clobber hand-edits."),
  extra_artifact_dirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Extra read-only search dirs for locating the source artifact (same as artifact_read)."),
});

export type ArtifactExportToPathInput = z.infer<typeof artifactExportToPathSchema>;

export async function handleArtifactExportToPath(
  input: ArtifactExportToPathInput,
  ctx: RunContext,
): Promise<Envelope<ExportResult>> {
  const startedAt = Date.now();
  const extraDirs = input.extra_artifact_dirs ?? [];

  const metadata = await resolveArtifactByIdentity(input.pack, input.slug, { extra_artifact_dirs: extraDirs });
  const artifact = await readArtifactAtPath(metadata.json_path, { extra_artifact_dirs: extraDirs });

  const result = await exportArtifactMarkdown(artifact, {
    target_path: input.target_path,
    allowed_roots: input.allowed_roots,
    overwrite: input.overwrite,
  });

  const envelope = buildEnvelope<ExportResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_artifact_export_to_path", envelope, input));
  return envelope;
}
