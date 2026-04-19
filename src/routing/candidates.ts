/**
 * Candidate generation — enumerate every route worth scoring.
 *
 * Three generators in deterministic order: skills, packs, then atom chains
 * harvested from candidate_proposals. Each candidate starts with zero score;
 * the scorer (scoring.ts) adds signal weight.
 *
 * We always include a `no_suggestion` candidate as a pseudo-route so the
 * router can legitimately abstain when evidence is thin — scoring.ts rewards
 * this route when no real candidate clears the floor.
 */

import type { Skill } from "../skills/types.js";
import type { RouteCandidate, RoutingContext } from "./types.js";

// Three fixed packs in the product surface.
export const KNOWN_PACKS = ["incident_pack", "repo_pack", "change_pack"] as const;
export type PackName = (typeof KNOWN_PACKS)[number];

// Rough tool fingerprints for each pack — used both to predict `expected_tools`
// and to score pack_shape_fit against the input.
const PACK_TOOL_FINGERPRINTS: Record<PackName, string[]> = {
  incident_pack: ["ollama_triage_logs", "ollama_incident_brief"],
  repo_pack: ["ollama_research", "ollama_repo_brief", "ollama_extract"],
  change_pack: ["ollama_research", "ollama_change_brief", "ollama_extract"],
};

function emptyCandidate(kind: RouteCandidate["target"]["kind"], ref: string, expected_tools: string[]): RouteCandidate {
  return {
    target: { kind, ref, expected_tools },
    score: 0,
    band: "low",
    signals: [],
    missing_signals: [],
    provenance: [],
  };
}

function skillCandidate(skill: Skill): RouteCandidate {
  return emptyCandidate(
    "skill",
    skill.id,
    skill.pipeline.map((p) => p.tool),
  );
}

function packCandidate(name: PackName): RouteCandidate {
  return emptyCandidate("pack", name, PACK_TOOL_FINGERPRINTS[name].slice());
}

function atomChainCandidate(signature: string): RouteCandidate {
  const tools = signature.split("→").filter((s) => s.length > 0);
  return emptyCandidate("atoms", signature, tools);
}

/**
 * Collect the unique set of candidate-proposal signatures from the routing
 * context. Each becomes an atom-chain candidate. Dedup by signature so
 * repeated proposals don't get scored twice.
 */
function atomChainRefsFromProposals(ctx: RoutingContext): string[] {
  const refs = new Set<string>();
  for (const r of ctx.candidate_proposals) {
    const sig = r.provenance.ref;
    if (sig && sig.includes("→")) refs.add(sig);
  }
  return Array.from(refs).sort();
}

export function generateCandidates(ctx: RoutingContext): RouteCandidate[] {
  const out: RouteCandidate[] = [];

  for (const skill of ctx.available_skills) {
    out.push(skillCandidate(skill));
  }
  for (const pack of KNOWN_PACKS) {
    out.push(packCandidate(pack));
  }
  for (const sig of atomChainRefsFromProposals(ctx)) {
    // Skip if an approved/candidate skill already encodes this exact sequence —
    // promoting it to a skill is the right move, not re-suggesting the raw chain.
    const dupOfSkill = ctx.available_skills.some(
      (s) => s.pipeline.map((p) => p.tool).join("→") === sig,
    );
    if (dupOfSkill) continue;
    out.push(atomChainCandidate(sig));
  }

  // The abstain slot is always present — scoring decides whether it wins.
  out.push(emptyCandidate("no_suggestion", "", []));

  return out;
}

export { PACK_TOOL_FINGERPRINTS };
