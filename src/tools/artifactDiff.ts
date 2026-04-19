/**
 * ollama_artifact_diff — structured same-pack comparison.
 *
 * Identity-first: both sides come in as {pack, slug}. No path-based
 * escape hatch in this slice — artifact_read already covers that
 * surface for callers who need it.
 *
 * Cross-pack diffs throw SCHEMA_INVALID. Pack payloads stay distinct
 * by design; a flattened "generic" diff would defeat the job-shape
 * discipline the rest of the product enforces.
 *
 * Weak flip is surfaced at the result top level, not buried inside the
 * field diff — a brief going from strong to weak (or vice versa) is
 * the single most important review signal.
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
  type PackName,
} from "./artifacts/scan.js";
import { diffArtifacts, type ArtifactDiffResult } from "./artifacts/diff.js";

const identitySchema = z.object({
  pack: z.enum(KNOWN_PACKS as unknown as [PackName, ...PackName[]]).describe("Pack identity."),
  slug: z.string().min(1).describe("Artifact slug (filename stem)."),
});

export const artifactDiffSchema = z.object({
  a: identitySchema.describe("First artifact identity."),
  b: identitySchema.describe("Second artifact identity. Must share a.pack — cross-pack diffs are refused."),
  extra_artifact_dirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Extra read-only search dirs (same as artifact_list / artifact_read). Canonical identity is still (pack, slug)."),
});

export type ArtifactDiffInput = z.infer<typeof artifactDiffSchema>;

export async function handleArtifactDiff(
  input: ArtifactDiffInput,
  ctx: RunContext,
): Promise<Envelope<ArtifactDiffResult>> {
  const startedAt = Date.now();

  // Enforce same-pack at the input level too — gives a clearer error
  // than waiting for the payload-level check after both files load.
  if (input.a.pack !== input.b.pack) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Cross-pack diff refused: a.pack="${input.a.pack}" vs b.pack="${input.b.pack}"`,
      "artifact_diff compares within a single pack only. Pick two artifacts of the same pack.",
      false,
    );
  }

  const extraDirs = input.extra_artifact_dirs ?? [];

  // Resolve both sides by identity in parallel — each resolution fails
  // loud on ambiguity or absence, per the Artifact Spine A contract.
  const [metaA, metaB] = await Promise.all([
    resolveArtifactByIdentity(input.a.pack, input.a.slug, { extra_artifact_dirs: extraDirs }),
    resolveArtifactByIdentity(input.b.pack, input.b.slug, { extra_artifact_dirs: extraDirs }),
  ]);

  const [artA, artB] = await Promise.all([
    readArtifactAtPath(metaA.json_path, { extra_artifact_dirs: extraDirs }),
    readArtifactAtPath(metaB.json_path, { extra_artifact_dirs: extraDirs }),
  ]);

  const result = diffArtifacts(artA, artB);

  const envelope = buildEnvelope<ArtifactDiffResult>({
    result,
    tier: "instant", // pure file I/O + in-memory diff; no model call
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_artifact_diff", envelope));
  return envelope;
}
