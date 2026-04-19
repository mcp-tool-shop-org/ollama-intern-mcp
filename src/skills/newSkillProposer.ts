/**
 * New-skill proposer — detects recurring ad-hoc workflows and proposes
 * candidate skills from them.
 *
 * Signal path:
 *   1. Reconstruct chains from the NDJSON log (chains.ts).
 *   2. Exclude chains whose signature already exists as a registered skill's
 *      pipeline — those are formalized, not ad-hoc.
 *   3. Exclude single-step chains (not a workflow, just a tool call).
 *   4. Group remaining chains by signature.
 *   5. Require minimum support (distinct sessions) and success floor.
 *   6. Require input-shape consistency across supporting chains so the
 *      proposal isn't a coincidental tool-name overlap.
 *   7. Emit a candidate skill draft — not written to disk, shown for
 *      operator review with evidence.
 *
 * Auto-promotion is NEVER done. Proposals are always operator-gated.
 */

import type { LoadedSkill } from "./types.js";
import type { Chain, ChainStep } from "./chains.js";
import type { InputShape, ValueShape } from "../observability.js";

export interface NewSkillThresholds {
  /** Minimum distinct chains sharing the signature. Default 3. */
  min_support: number;
  /** Success rate floor across supporting chains. Default 0.75. */
  min_success_rate: number;
  /** Fraction of supporting chains whose first-step input_shape must agree. Default 0.6. */
  min_shape_agreement: number;
  /** Drop signatures shorter than this many steps. Default 2 (only propose actual chains). */
  min_sequence_length: number;
}

export const DEFAULT_NEW_SKILL_THRESHOLDS: NewSkillThresholds = {
  min_support: 3,
  min_success_rate: 0.75,
  min_shape_agreement: 0.6,
  min_sequence_length: 2,
};

export interface NewSkillProposal {
  /** Proposed skill id slug, derived from the signature. */
  suggested_id: string;
  /** Inferred human-readable name. */
  suggested_name: string;
  /** One-line description of the detected workflow. */
  description: string;
  /** The tool sequence, in order. */
  pipeline_tools: string[];
  /**
   * Consensus input-shape fingerprint of the first step — what triggered this
   * workflow in the supporting chains. Useful for the operator to author a
   * matching trigger.keywords block.
   */
  first_step_shape: InputShape;
  /** Evidence aggregate so operators can verify before acting. */
  evidence: {
    support: number;
    success_rate: number;
    avg_duration_ms: number;
    shape_agreement: number;
    examples: Array<{ chain_id: string; started_at: string; ok: boolean; duration_ms: number }>;
  };
}

function signatureOfSkill(loaded: LoadedSkill): string {
  return loaded.skill.pipeline.map((p) => p.tool).join("→");
}

function sigToolsToId(signature: string): string {
  // "ollama_triage_logs→ollama_incident_brief" -> "triage-logs-then-incident-brief"
  const tools = signature.split("→").map((t) => t.replace(/^ollama_/, "").replace(/_/g, "-"));
  if (tools.length === 0) return "proposed-skill";
  if (tools.length === 1) return tools[0];
  return tools.slice(0, -1).join("-then-") + "-then-" + tools[tools.length - 1];
}

function sigToolsToName(signature: string): string {
  const tools = signature.split("→").map((t) => t.replace(/^ollama_/, "").replace(/_/g, " "));
  if (tools.length === 0) return "Proposed skill";
  if (tools.length === 1) return tools[0];
  return tools.slice(0, -1).join(", ") + ", then " + tools[tools.length - 1];
}

function valueShapeEq(a: ValueShape | undefined, b: ValueShape | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "string" && b.kind === "string") return a.bucket === b.bucket;
  if (a.kind === "array" && b.kind === "array") return a.length === b.length;
  if (a.kind === "object" && b.kind === "object") {
    if (a.keys.length !== b.keys.length) return false;
    return a.keys.every((k, i) => k === b.keys[i]);
  }
  if (a.kind === "boolean" && b.kind === "boolean") return a.value === b.value;
  return true; // number / other / absent compare by kind alone
}

function shapeSimilarity(a: InputShape, b: InputShape): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 1;
  let matches = 0;
  for (const k of keys) if (valueShapeEq(a[k], b[k])) matches++;
  return matches / keys.size;
}

/** Pick the most "popular" first-step shape as the proposal's fingerprint. */
function pickConsensusShape(chains: Chain[]): { shape: InputShape; agreement: number } {
  const candidates: InputShape[] = chains
    .map((c) => c.steps[0]?.input_shape)
    .filter((s): s is InputShape => s !== undefined);
  if (candidates.length === 0) return { shape: {}, agreement: 0 };
  let bestShape = candidates[0];
  let bestCount = 0;
  for (const candidate of candidates) {
    let count = 0;
    for (const other of candidates) if (shapeSimilarity(candidate, other) >= 0.75) count++;
    if (count > bestCount) {
      bestCount = count;
      bestShape = candidate;
    }
  }
  return { shape: bestShape, agreement: bestCount / candidates.length };
}

export function proposeNewSkills(
  chains: Chain[],
  existingSkills: LoadedSkill[],
  t: NewSkillThresholds = DEFAULT_NEW_SKILL_THRESHOLDS,
): NewSkillProposal[] {
  const formalizedSignatures = new Set(existingSkills.map(signatureOfSkill));
  const bySignature = new Map<string, Chain[]>();
  for (const chain of chains) {
    if (chain.steps.length < t.min_sequence_length) continue;
    if (formalizedSignatures.has(chain.signature)) continue;
    const list = bySignature.get(chain.signature) ?? [];
    list.push(chain);
    bySignature.set(chain.signature, list);
  }

  const proposals: NewSkillProposal[] = [];
  for (const [signature, supporting] of bySignature) {
    if (supporting.length < t.min_support) continue;
    const okCount = supporting.filter((c) => c.ok_count === c.steps.length).length;
    const successRate = okCount / supporting.length;
    if (successRate < t.min_success_rate) continue;

    const { shape, agreement } = pickConsensusShape(supporting);
    if (agreement < t.min_shape_agreement) continue;

    const avgDuration = Math.round(
      supporting.reduce((acc, c) => acc + c.duration_ms, 0) / supporting.length,
    );
    const examples = supporting
      .slice(-5)
      .map((c) => ({
        chain_id: c.chain_id,
        started_at: c.started_at,
        ok: c.ok_count === c.steps.length,
        duration_ms: c.duration_ms,
      }));

    proposals.push({
      suggested_id: sigToolsToId(signature),
      suggested_name: sigToolsToName(signature),
      description: `Detected ${supporting.length} recurring runs of this ad-hoc workflow. Promote to a skill if you want it formalized, named, and revisable.`,
      pipeline_tools: signature.split("→"),
      first_step_shape: shape,
      evidence: {
        support: supporting.length,
        success_rate: successRate,
        avg_duration_ms: avgDuration,
        shape_agreement: agreement,
        examples,
      },
    });
  }

  proposals.sort((a, b) => {
    if (b.evidence.support !== a.evidence.support) return b.evidence.support - a.evidence.support;
    return a.suggested_id < b.suggested_id ? -1 : 1;
  });
  return proposals;
}

// Silence unused-import warnings for types used only in parameters.
export type { ChainStep };
