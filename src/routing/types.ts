/**
 * Phase 3D Commit A — routing types.
 *
 * The routing layer answers: given a live job, what route should the
 * intern have taken? Skills, packs, atom chains, or nothing. The output
 * is auditable — every candidate carries its reasons, matched signals,
 * missing signals, and provenance back to the memory/skill records that
 * supported it.
 *
 * Laws:
 *   - Shadow ONLY — this module never executes a route.
 *   - A ranked field, never a single guess.
 *   - Strong enough to disagree with the operator, honest enough to
 *     show why.
 *
 * This file is pure data. The brain lives in context.ts + candidates.ts +
 * scoring.ts + router.ts.
 */

import { z } from "zod";
import type { InputShape } from "../observability.js";
import type { MemoryRecord } from "../memory/types.js";
import type { Skill } from "../skills/types.js";

export const ROUTING_SCHEMA_VERSION = 1 as const;

// ── The thing the router decides about ───────────────────────

export type RouteKind = "skill" | "pack" | "atoms" | "no_suggestion";

/**
 * A concrete suggested route.
 *
 *   - skill: ref = skill_id, expected_tools = that skill's pipeline
 *   - pack:  ref = pack name (incident_pack | repo_pack | change_pack)
 *   - atoms: ref = tool sequence joined by "→"
 *   - no_suggestion: ref = "" (router abstains; see RoutingDecision.abstain_reason)
 */
export interface RouteTarget {
  kind: RouteKind;
  ref: string;
  /** The tool sequence this route would run, for comparison with actual operator invocation. */
  expected_tools: string[];
}

// ── Score bands & confidence ─────────────────────────────────

export type ConfidenceBand = "high" | "medium" | "low" | "abstain";

/** A single signal that contributed to (or against) a candidate. */
export interface RoutingSignal {
  /** Stable identifier for the signal kind — enables Phase 3C-style audits. */
  name:
    | "input_shape_match"
    | "skill_keyword_hit"
    | "skill_status_bump"
    | "memory_success_history"
    | "memory_similar_neighbor"
    | "candidate_proposal_support"
    | "corpus_available"
    | "pack_shape_fit"
    | "pack_supplementary_hit"
    | "deprecated_penalty"
    | "missing_required_input"
    | "weak_evidence";
  /** Per-signal score contribution (can be negative). */
  weight: number;
  /** One-line reason the signal fired, grounded in concrete matched fields. */
  reason: string;
}

// ── Candidate ────────────────────────────────────────────────

export interface RouteCandidate {
  target: RouteTarget;
  /** Sum of signal.weight — higher = better fit. */
  score: number;
  /** Banded read for operators; derived from score + evidence coverage. */
  band: ConfidenceBand;
  /** Signals that fired for this candidate, ordered by weight descending. */
  signals: RoutingSignal[];
  /** Signals the router would have wanted but didn't have. */
  missing_signals: string[];
  /**
   * Memory / skill / proposal records that supported the candidate.
   * Shown in the audit surface so operators can trace "why this won."
   */
  provenance: Array<{
    kind: "memory" | "skill" | "candidate_proposal";
    ref: string;
    detail?: string;
  }>;
}

// ── Routing context (the live decision surface) ──────────────

/** What the router knows about the job being considered. */
export interface RoutingContext {
  /** Stable schema version — bumped when the context shape changes. */
  schema_version: typeof ROUTING_SCHEMA_VERSION;
  /** ISO timestamp at which this context was built. */
  built_at: string;
  /** Caller-supplied one-liner describing the job, when available. */
  job_hint: string | null;
  /** Privacy-safe shape of the triggering input, built via summarizeInputShape. */
  input_shape: InputShape;
  /** Boolean flags derived from input_shape for quick signal matching. */
  input_flags: {
    has_log_text: boolean;
    has_source_paths: boolean;
    has_diff_text: boolean;
    has_corpus: boolean;
    has_question: boolean;
    has_text: boolean;
    has_items_batch: boolean;
  };
  /** Skills available for routing (approved + candidate, never deprecated). */
  available_skills: Skill[];
  /** Memory records retrieved as similar to this job. Optional — builder may skip. */
  memory_hits: MemoryRecord[];
  /** Candidate-proposal records currently in the memory index. */
  candidate_proposals: MemoryRecord[];
}

// ── The decision ─────────────────────────────────────────────

export interface RoutingDecision {
  schema_version: typeof ROUTING_SCHEMA_VERSION;
  decided_at: string;
  /** The full ranked field, deterministic order (score desc, ref asc). */
  candidates: RouteCandidate[];
  /** The top candidate, or null when the router abstains. */
  suggested: RouteTarget | null;
  /** Why the router abstained, or null when it did suggest. */
  abstain_reason: string | null;
  /** Full context snapshot — kept so audits are self-contained. */
  context: RoutingContext;
}

// ── Zod for serialization when Commit B persists decisions ──

export const routeTargetSchema = z.object({
  kind: z.enum(["skill", "pack", "atoms", "no_suggestion"]),
  ref: z.string(),
  expected_tools: z.array(z.string()),
});

export const routingSignalSchema = z.object({
  name: z.enum([
    "input_shape_match",
    "skill_keyword_hit",
    "skill_status_bump",
    "memory_success_history",
    "memory_similar_neighbor",
    "candidate_proposal_support",
    "corpus_available",
    "pack_shape_fit",
    "pack_supplementary_hit",
    "deprecated_penalty",
    "missing_required_input",
    "weak_evidence",
  ]),
  weight: z.number(),
  reason: z.string(),
});

export const routeCandidateSchema = z.object({
  target: routeTargetSchema,
  score: z.number(),
  band: z.enum(["high", "medium", "low", "abstain"]),
  signals: z.array(routingSignalSchema),
  missing_signals: z.array(z.string()),
  provenance: z.array(z.object({
    kind: z.enum(["memory", "skill", "candidate_proposal"]),
    ref: z.string(),
    detail: z.string().optional(),
  })),
});
