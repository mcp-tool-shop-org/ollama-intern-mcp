/**
 * Pack-specific snippet tools.
 *
 * Three MCP handlers, one per pack, each rendering a compact
 * markdown fragment from an existing artifact. No model calls,
 * no re-packaging — pure derivation from stored JSON.
 *
 * Separate tools because the whole value is pack-shaped — a single
 * generic snippet tool would flatten distinct useful fragments into
 * lowest-common-denominator mush.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { InternError } from "../errors.js";
import {
  resolveArtifactByIdentity,
  readArtifactAtPath,
  type ArtifactMetadata,
} from "./artifacts/scan.js";
import {
  renderIncidentNote,
  renderOnboardingSection,
  renderReleaseNote,
} from "./artifacts/snippets.js";
import type { IncidentPackArtifact } from "./packs/incidentPack.js";
import type { RepoPackArtifact } from "./packs/repoPack.js";
import type { ChangePackArtifact } from "./packs/changePack.js";

// ── Shared ─────────────────────────────────────────────────

export interface SnippetResult {
  rendered: string;
  metadata: ArtifactMetadata;
}

const baseSnippetSchema = {
  slug: z.string().min(1).describe("Slug of the source artifact (from artifact_list)."),
  extra_artifact_dirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Extra read-only search dirs (same as artifact_read)."),
} as const;

// ── incident_note_snippet ──────────────────────────────────

export const artifactIncidentNoteSnippetSchema = z.object(baseSnippetSchema);
export type ArtifactIncidentNoteSnippetInput = z.infer<typeof artifactIncidentNoteSnippetSchema>;

export async function handleArtifactIncidentNoteSnippet(
  input: ArtifactIncidentNoteSnippetInput,
  ctx: RunContext,
): Promise<Envelope<SnippetResult>> {
  const startedAt = Date.now();
  const extraDirs = input.extra_artifact_dirs ?? [];
  const metadata = await resolveArtifactByIdentity("incident_pack", input.slug, { extra_artifact_dirs: extraDirs });
  const artifact = await readArtifactAtPath(metadata.json_path, { extra_artifact_dirs: extraDirs });
  if (artifact.pack !== "incident_pack") {
    throw new InternError(
      "SCHEMA_INVALID",
      `Artifact at ${metadata.json_path} is not an incident_pack artifact (found ${artifact.pack}).`,
      "Pick a slug that belongs to an incident_pack artifact. Use artifact_list to browse.",
      false,
    );
  }
  const rendered = renderIncidentNote(artifact as IncidentPackArtifact);
  const envelope = buildEnvelope<SnippetResult>({
    result: { rendered, metadata },
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_artifact_incident_note_snippet", envelope, input));
  return envelope;
}

// ── onboarding_section_snippet ─────────────────────────────

export const artifactOnboardingSectionSnippetSchema = z.object(baseSnippetSchema);
export type ArtifactOnboardingSectionSnippetInput = z.infer<typeof artifactOnboardingSectionSnippetSchema>;

export async function handleArtifactOnboardingSectionSnippet(
  input: ArtifactOnboardingSectionSnippetInput,
  ctx: RunContext,
): Promise<Envelope<SnippetResult>> {
  const startedAt = Date.now();
  const extraDirs = input.extra_artifact_dirs ?? [];
  const metadata = await resolveArtifactByIdentity("repo_pack", input.slug, { extra_artifact_dirs: extraDirs });
  const artifact = await readArtifactAtPath(metadata.json_path, { extra_artifact_dirs: extraDirs });
  if (artifact.pack !== "repo_pack") {
    throw new InternError(
      "SCHEMA_INVALID",
      `Artifact at ${metadata.json_path} is not a repo_pack artifact (found ${artifact.pack}).`,
      "Pick a slug that belongs to a repo_pack artifact. Use artifact_list to browse.",
      false,
    );
  }
  const rendered = renderOnboardingSection(artifact as RepoPackArtifact);
  const envelope = buildEnvelope<SnippetResult>({
    result: { rendered, metadata },
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_artifact_onboarding_section_snippet", envelope, input));
  return envelope;
}

// ── release_note_snippet ───────────────────────────────────

export const artifactReleaseNoteSnippetSchema = z.object(baseSnippetSchema);
export type ArtifactReleaseNoteSnippetInput = z.infer<typeof artifactReleaseNoteSnippetSchema>;

export async function handleArtifactReleaseNoteSnippet(
  input: ArtifactReleaseNoteSnippetInput,
  ctx: RunContext,
): Promise<Envelope<SnippetResult>> {
  const startedAt = Date.now();
  const extraDirs = input.extra_artifact_dirs ?? [];
  const metadata = await resolveArtifactByIdentity("change_pack", input.slug, { extra_artifact_dirs: extraDirs });
  const artifact = await readArtifactAtPath(metadata.json_path, { extra_artifact_dirs: extraDirs });
  if (artifact.pack !== "change_pack") {
    throw new InternError(
      "SCHEMA_INVALID",
      `Artifact at ${metadata.json_path} is not a change_pack artifact (found ${artifact.pack}).`,
      "Pick a slug that belongs to a change_pack artifact. Use artifact_list to browse.",
      false,
    );
  }
  const rendered = renderReleaseNote(artifact as ChangePackArtifact);
  const envelope = buildEnvelope<SnippetResult>({
    result: { rendered, metadata },
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_artifact_release_note_snippet", envelope, input));
  return envelope;
}
