/**
 * ollama_artifact_read — typed read of a pack artifact.
 *
 * Primary entry = {pack, slug}. Keeps reads anchored to job identity,
 * not file paths. Collisions within (pack, slug) fail loud.
 *
 * Secondary entry = {json_path}. Strict path safety: must be absolute,
 * must normalize cleanly, must end in .json, must live under a
 * recognized artifact dir (canonical roots + extra_artifact_dirs).
 *
 * Return shape is a discriminated union on `pack` — incident/repo/
 * change payloads stay distinct. Metadata is also surfaced so callers
 * can do weak-checks / section-counts without parsing the full
 * artifact themselves.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { InternError } from "../errors.js";
import {
  KNOWN_PACKS,
  resolveArtifactByIdentity,
  readArtifactAtPath,
  metadataFromArtifact,
  type ArtifactMetadata,
  type PackArtifact,
  type PackName,
} from "./artifacts/scan.js";

export const artifactReadSchema = z.object({
  pack: z
    .enum(KNOWN_PACKS as unknown as [PackName, ...PackName[]])
    .optional()
    .describe("Pack identity. Pass WITH slug for the primary identity-based read."),
  slug: z.string().min(1).optional().describe("Artifact slug (filename stem). Pass WITH pack."),
  json_path: z
    .string()
    .min(1)
    .optional()
    .describe("Absolute path to the artifact JSON file. Secondary escape hatch — must live under a recognized artifact dir; path-safety guarded."),
  extra_artifact_dirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Extra read-only search dirs (same as artifact_list). Applied to both identity resolution and path safety."),
});

export type ArtifactReadInput = z.infer<typeof artifactReadSchema>;

export interface ArtifactReadResult {
  metadata: ArtifactMetadata;
  /** The full artifact payload, typed by pack. */
  artifact: PackArtifact;
}

function assertExactlyOneEntry(input: ArtifactReadInput): void {
  const hasIdentity = Boolean(input.pack) && Boolean(input.slug);
  const hasPath = Boolean(input.json_path);
  const partialIdentity = Boolean(input.pack) !== Boolean(input.slug);
  if (partialIdentity) {
    throw new InternError(
      "SCHEMA_INVALID",
      "artifact_read: pack and slug must be provided together.",
      "Use {pack, slug} as the primary identity-based entry, or {json_path} as the secondary escape hatch.",
      false,
    );
  }
  const count = (hasIdentity ? 1 : 0) + (hasPath ? 1 : 0);
  if (count !== 1) {
    throw new InternError(
      "SCHEMA_INVALID",
      `artifact_read: provide exactly one of {pack, slug} or {json_path} (given ${count}).`,
      "The {pack, slug} form is preferred — it keeps reads anchored to job identity. json_path is a secondary escape hatch.",
      false,
    );
  }
}

export async function handleArtifactRead(
  input: ArtifactReadInput,
  ctx: RunContext,
): Promise<Envelope<ArtifactReadResult>> {
  assertExactlyOneEntry(input);
  const startedAt = Date.now();
  const extraDirs = input.extra_artifact_dirs ?? [];

  let metadata: ArtifactMetadata;
  let artifact: PackArtifact;

  if (input.pack && input.slug) {
    // Primary entry: identity-based.
    metadata = await resolveArtifactByIdentity(input.pack, input.slug, { extra_artifact_dirs: extraDirs });
    artifact = await readArtifactAtPath(metadata.json_path, { extra_artifact_dirs: extraDirs });
  } else {
    // Secondary entry: path-based.
    artifact = await readArtifactAtPath(input.json_path as string, { extra_artifact_dirs: extraDirs });
    const meta = metadataFromArtifact(artifact, input.json_path as string);
    if (!meta) {
      throw new InternError(
        "SCHEMA_INVALID",
        `Artifact at ${input.json_path} has an unrecognized shape.`,
        "Only pack-produced artifacts (incident_pack, repo_pack, change_pack) are readable through this tool.",
        false,
      );
    }
    metadata = meta;
  }

  const result: ArtifactReadResult = { metadata, artifact };
  const envelope = buildEnvelope<ArtifactReadResult>({
    result,
    tier: "instant", // no model call; just file I/O
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_artifact_read", envelope));
  return envelope;
}
