/**
 * Deterministic memory ids + content digests.
 *
 * Ids are SHA256 of a kind-specific identity string, truncated to 16 chars
 * and prefixed with kind. Truncation is fine here: 16 hex chars = 64 bits
 * of entropy, collision-resistant for a lifetime operational memory of
 * thousands-not-billions of records, and the prefix makes grep-by-kind
 * trivial.
 *
 * Content digest is a full 64-char sha256 of normalized (title + summary +
 * tags + facets) — changes in any of those flips the digest and the
 * refresh path marks the record updated.
 */

import { createHash } from "node:crypto";
import type { MemoryKind, MemoryRecord } from "./types.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function memoryId(kind: MemoryKind, identity: string): string {
  const hash = sha256(`${kind}:${identity}`).slice(0, 16);
  return `${kind}:${hash}`;
}

export function contentDigest(input: {
  title: string;
  summary: string;
  tags: string[];
  facets: MemoryRecord["facets"];
}): string {
  // Deterministic stringification: sort keys, sort tags.
  const sortedTags = [...input.tags].sort();
  const sortedFacets: Record<string, unknown> = {};
  for (const k of Object.keys(input.facets).sort()) sortedFacets[k] = input.facets[k];
  const payload = JSON.stringify({
    title: input.title,
    summary: input.summary,
    tags: sortedTags,
    facets: sortedFacets,
  });
  return sha256(payload);
}
