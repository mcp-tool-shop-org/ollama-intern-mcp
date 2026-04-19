/**
 * Memory record — the normalized surface of durable operational facts,
 * derived from the four real sources the intern produces:
 *
 *   1. skill_receipt     — <cwd>/artifacts/skill-receipts/*.json
 *   2. pack_artifact     — ~/.ollama-intern/artifacts/{incident,repo,change}/*.json
 *   3. approved_skill    — project + global skills/ trees
 *   4. candidate_proposal — new-skill proposals emitted by Phase 2.5
 *
 * The record IS the memory entry. Retrieval (Commit B) will index on these;
 * read/explain (Commit C) will join them with their source documents.
 *
 * Design invariants:
 *   - Stable, deterministic id. Re-indexing must not churn ids.
 *   - Every record carries provenance back to its source file/object.
 *   - `summary` is the only free text — short, retrieval-friendly, content-safe.
 *   - `facets` are typed filter fields so metadata filters in Commit B don't
 *     have to JSON-parse `raw` at query time.
 *   - `content_digest` makes "has this changed?" a hash compare, not a deep equal.
 */

import { z } from "zod";

export const MEMORY_SCHEMA_VERSION = 1 as const;

export const memoryKindSchema = z.enum([
  "skill_receipt",
  "pack_artifact",
  "approved_skill",
  "candidate_proposal",
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryProvenanceSchema = z.object({
  source_kind: memoryKindSchema,
  /**
   * Absolute path to the source file on disk when the record is
   * file-backed. For candidate_proposal (derived from NDJSON analysis at
   * refresh time) this points to the NDJSON log path that produced it.
   */
  source_path: z.string(),
  /**
   * Kind-specific identity hint so Commit C can join back to the source
   * cleanly: e.g. "{pack}:{slug}" for pack_artifact, skill.id for
   * approved_skill, the receipt's skill_id+started_at for skill_receipt,
   * the proposed signature for candidate_proposal.
   */
  ref: z.string(),
});
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  kind: memoryKindSchema,
  schema_version: z.literal(MEMORY_SCHEMA_VERSION),
  /**
   * When the underlying event happened — receipt.started_at,
   * artifact.created_at, skill.provenance.created_at, etc.
   */
  created_at: z.string(),
  /** When this memory record was last indexed. */
  indexed_at: z.string(),
  /** Short human-readable title — shown in listings. */
  title: z.string().min(1),
  /**
   * Short free-text summary for retrieval. Bounded in size by normalizers —
   * never a whole artifact. Content-safe (never raw log bodies).
   */
  summary: z.string().min(1),
  /** Coarse facets for filtering and grouping. */
  tags: z.array(z.string()).default([]),
  /** Typed filter fields. Keep small — this is not a document store. */
  facets: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** sha256 of (title + summary + sorted facets + tags) — freshness detection. */
  content_digest: z.string().length(64),
  provenance: memoryProvenanceSchema,
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const memoryIndexSchema = z.object({
  schema_version: z.literal(MEMORY_SCHEMA_VERSION),
  indexed_at: z.string(),
  records: z.array(memoryRecordSchema),
});
export type MemoryIndex = z.infer<typeof memoryIndexSchema>;
