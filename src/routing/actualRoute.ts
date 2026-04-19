/**
 * Canonical actual-route identity for shadow-runtime receipts.
 *
 * Law 3: the actual invoked route must be explicit, never inferred after
 * the fact. The tool name is the ground truth. Atoms and flagships become
 * `atom:<tool>`; packs become `pack:<tool>`. Skill-layer tools never reach
 * this function (they're excluded at the shadow-runtime entry).
 */

const PACK_TOOLS = new Set([
  "ollama_incident_pack",
  "ollama_repo_pack",
  "ollama_change_pack",
]);

export function canonicalActualRoute(tool: string): string {
  if (PACK_TOOLS.has(tool)) return `pack:${tool}`;
  return `atom:${tool}`;
}

export function isShadowTargetTool(tool: string): boolean {
  return PACK_TOOLS.has(tool) || SHADOW_TARGET_ATOMS.has(tool);
}

/**
 * Tools the shadow runtime observes. Kept as an explicit list so a new atom
 * is an intentional addition, not a silent one. Skill-layer + memory-layer +
 * artifact + corpus-management + embed-primitive tools stay out.
 */
export const SHADOW_TARGET_ATOMS = new Set([
  // atoms that do real cognitive work
  "ollama_classify",
  "ollama_triage_logs",
  "ollama_summarize_fast",
  "ollama_summarize_deep",
  "ollama_draft",
  "ollama_extract",
  "ollama_chat",
  // flagship atoms (structured jobs)
  "ollama_research",
  "ollama_corpus_search",
  "ollama_corpus_answer",
  "ollama_incident_brief",
  "ollama_repo_brief",
  "ollama_change_brief",
  "ollama_embed_search",
]);
