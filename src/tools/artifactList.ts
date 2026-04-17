/**
 * ollama_artifact_list — metadata-only index of pack artifacts on disk.
 *
 * Artifact tier, not an atom, not a pack. Turns pack outputs into a
 * reusable working surface: what exists, when it was made, is it weak,
 * which pack produced it, which corpus (if any) grounded it.
 *
 * Returns ONE metadata record per artifact. Full payloads belong to
 * artifact_read — listing stays cheap and scan-friendly.
 *
 * Identity is (pack, slug). Collisions across dirs surface as warnings
 * in the response, but every colliding record still appears so the
 * operator can see the duplication and resolve it.
 *
 * Default sort: newest first by created_at, then pack, then slug.
 * Filter → sort → limit, in that order.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import type { RunContext } from "../runContext.js";
import { InternError } from "../errors.js";
import {
  KNOWN_PACKS,
  scanAllArtifacts,
  type ArtifactMetadata,
  type PackName,
} from "./artifacts/scan.js";

export const artifactListSchema = z.object({
  pack: z
    .enum(KNOWN_PACKS as unknown as [PackName, ...PackName[]])
    .optional()
    .describe("Filter to a single pack. Omit to include all three."),
  date_after: z.string().optional().describe("ISO timestamp. Include only artifacts with created_at >= date_after."),
  date_before: z.string().optional().describe("ISO timestamp. Include only artifacts with created_at <= date_before."),
  weak_only: z.boolean().optional().describe("If true, keep only artifacts where the brief flagged weak=true."),
  strong_only: z.boolean().optional().describe("If true, keep only artifacts where weak=false. Mutually exclusive with weak_only."),
  limit: z.number().int().min(1).max(500).optional().describe("Cap on entries returned after sorting (default 50). Apply after filters."),
  extra_artifact_dirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Additional read-only search dirs. Canonical identity is still (pack, slug) — extras don't shift precedence."),
});

export type ArtifactListInput = z.infer<typeof artifactListSchema>;

export interface ArtifactListResult {
  items: ArtifactMetadata[];
  /** (pack, slug) pairs present in more than one location. Surfaces so the operator can resolve. */
  duplicates: Array<{ pack: PackName; slug: string; paths: string[] }>;
  /** Total matches BEFORE limit was applied. */
  total_matches: number;
}

function parseIso(s: string | undefined, fieldName: string): Date | null {
  if (s === undefined) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new InternError(
      "SCHEMA_INVALID",
      `Invalid ISO timestamp on ${fieldName}: ${s}`,
      "Pass an ISO-8601 string like 2026-04-17T00:00:00Z.",
      false,
    );
  }
  return d;
}

function assertMutex(input: ArtifactListInput): void {
  if (input.weak_only && input.strong_only) {
    throw new InternError(
      "SCHEMA_INVALID",
      "weak_only and strong_only are mutually exclusive.",
      "Pick one — weak_only keeps weak artifacts, strong_only keeps non-weak.",
      false,
    );
  }
}

function sortAndLimit(items: ArtifactMetadata[], limit: number): ArtifactMetadata[] {
  // Deterministic sort: created_at desc, then pack asc, then slug asc.
  const sorted = items.slice().sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    if (a.pack !== b.pack) return a.pack < b.pack ? -1 : 1;
    if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
    // Fall back to json_path if everything else ties — still deterministic.
    return a.json_path < b.json_path ? -1 : a.json_path > b.json_path ? 1 : 0;
  });
  return sorted.slice(0, limit);
}

export async function handleArtifactList(
  input: ArtifactListInput,
  ctx: RunContext,
): Promise<Envelope<ArtifactListResult>> {
  assertMutex(input);
  const startedAt = Date.now();
  const after = parseIso(input.date_after, "date_after");
  const before = parseIso(input.date_before, "date_before");
  const limit = input.limit ?? 50;

  const scan = await scanAllArtifacts({ extra_artifact_dirs: input.extra_artifact_dirs });
  let filtered = scan.all;
  if (input.pack) filtered = filtered.filter((m) => m.pack === input.pack);
  if (after) filtered = filtered.filter((m) => new Date(m.created_at).getTime() >= after.getTime());
  if (before) filtered = filtered.filter((m) => new Date(m.created_at).getTime() <= before.getTime());
  if (input.weak_only) filtered = filtered.filter((m) => m.weak === true);
  if (input.strong_only) filtered = filtered.filter((m) => m.weak === false);

  const total_matches = filtered.length;
  const items = sortAndLimit(filtered, limit);

  const result: ArtifactListResult = {
    items,
    duplicates: scan.duplicates,
    total_matches,
  };

  const envelope = buildEnvelope<ArtifactListResult>({
    result,
    tier: "instant", // no model call; "instant" is the cheapest tier we report
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    ...(scan.duplicates.length > 0
      ? { warnings: [`Found ${scan.duplicates.length} slug collision(s) across artifact dirs — see result.duplicates.`] }
      : {}),
  });
  await ctx.logger.log(callEvent("ollama_artifact_list", envelope));
  return envelope;
}
