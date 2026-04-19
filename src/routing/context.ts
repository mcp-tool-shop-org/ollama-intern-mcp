/**
 * Build a RoutingContext from the live decision surface.
 *
 * Sources, in order of reliability:
 *   1. input_shape from summarizeInputShape (privacy-safe, always available)
 *   2. loadSkills (approved + candidate; deprecated filtered out)
 *   3. loadIndex memory records filtered to candidate_proposal
 *   4. searchMemory similar to the input shape — optional, caller-gated
 *      (requires an Ollama client; context builder can skip cleanly)
 *
 * The builder is designed so that the router can run WITHOUT memory hits —
 * a cold-start intern should still propose skills/packs purely from input
 * shape. Memory support is a strength signal, not a precondition.
 */

import type { InputShape } from "../observability.js";
import { loadSkills, type SkillStoreOptions } from "../skills/store.js";
import { loadIndex, type StoreOptions } from "../memory/store.js";
import { searchMemory, type MemoryFilters } from "../memory/retrieval.js";
import type { OllamaClient } from "../ollama.js";
import type { MemoryRecord } from "../memory/types.js";
import type { RoutingContext } from "./types.js";
import { ROUTING_SCHEMA_VERSION } from "./types.js";

export interface BuildContextOptions {
  input_shape: InputShape;
  /** Optional natural-language one-liner describing the job. */
  job_hint?: string;
  /** Skill store overrides for test isolation. */
  skill_store?: SkillStoreOptions;
  /** Memory store overrides for test isolation. */
  memory_store?: StoreOptions;
  /**
   * When provided together, enable memory retrieval for the "similar past
   * work" signal. Without these, memory_hits comes back empty and the
   * router scores purely from shape + skills.
   */
  client?: OllamaClient;
  embed_model?: string;
  memory_filters?: MemoryFilters;
  memory_limit?: number;
}

/**
 * Keys that carry an IDENTIFIER, not a content blob. For these, any non-
 * empty string counts as present — `"corpus": "memory"` (6 chars) is a valid
 * corpus handle, not an empty input. For content-blob keys (log_text,
 * text, diff_text), a tiny bucket still indicates meaningful absence.
 */
const IDENTIFIER_KEYS = new Set(["corpus", "target_path", "path", "question", "skill_id"]);

/** Flatten an InputShape into boolean flags the router scores against. */
function deriveFlags(shape: InputShape): RoutingContext["input_flags"] {
  const present = (key: string): boolean => {
    const v = shape[key];
    if (!v) return false;
    if (v.kind === "absent") return false;
    if (v.kind === "string") {
      if (IDENTIFIER_KEYS.has(key)) return true;
      return v.bucket !== "tiny";
    }
    if (v.kind === "array") return v.length > 0;
    return true;
  };
  return {
    has_log_text: present("log_text"),
    has_source_paths: present("source_paths"),
    has_diff_text: present("diff_text"),
    has_corpus: present("corpus"),
    has_question: present("question"),
    has_text: present("text"),
    has_items_batch: present("items"),
  };
}

export async function buildRoutingContext(opts: BuildContextOptions): Promise<RoutingContext> {
  const { skills } = await loadSkills(opts.skill_store);
  const approvedOrCandidate = skills
    .filter((s) => s.skill.status !== "deprecated")
    .map((s) => s.skill);

  const index = await loadIndex(opts.memory_store);
  const candidate_proposals = index.records.filter((r) => r.kind === "candidate_proposal");

  let memory_hits: MemoryRecord[] = [];
  if (opts.client && opts.embed_model && opts.job_hint) {
    try {
      const result = await searchMemory(
        opts.job_hint,
        opts.memory_filters ?? {},
        {
          client: opts.client,
          embedModel: opts.embed_model,
          limit: opts.memory_limit ?? 8,
          ...(opts.memory_store ?? {}),
        },
      );
      memory_hits = result.hits.map((h) => h.record);
    } catch {
      // Memory retrieval is a strength signal, not a precondition.
      // A failed lookup reduces the router to shape+skill reasoning.
      memory_hits = [];
    }
  }

  return {
    schema_version: ROUTING_SCHEMA_VERSION,
    built_at: new Date().toISOString(),
    job_hint: opts.job_hint ?? null,
    input_shape: opts.input_shape,
    input_flags: deriveFlags(opts.input_shape),
    available_skills: approvedOrCandidate,
    memory_hits,
    candidate_proposals,
  };
}
