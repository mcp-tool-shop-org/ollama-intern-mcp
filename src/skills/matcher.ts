/**
 * Skill matcher v0 — keyword-overlap scoring against a task description.
 *
 * Deliberately simple. v0 goal is "does the substrate work end-to-end," not
 * "perfect skill retrieval." Phase 2 will add embedding-based similarity
 * (using ollama_embed + persistent index) and outcome-weighted scoring.
 */

import type { LoadedSkill, SkillMatch } from "./types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "in", "on", "at",
  "with", "from", "by", "is", "are", "was", "were", "be", "been", "it",
  "this", "that", "these", "those", "i", "you", "we", "they", "my", "our",
  "your", "me", "do", "did", "does", "can", "could", "should", "would",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

export function scoreSkill(loaded: LoadedSkill, taskTokens: Set<string>): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const { skill } = loaded;
  const kwTokens = uniq(skill.trigger.keywords.flatMap((k) => tokenize(k)));
  const descTokens = uniq([...tokenize(skill.name), ...tokenize(skill.description)]);

  let score = 0;

  let kwHits = 0;
  for (const t of kwTokens) if (taskTokens.has(t)) kwHits++;
  if (kwTokens.length > 0 && kwHits > 0) {
    const sub = (kwHits / kwTokens.length) * 2.0;
    score += sub;
    reasons.push(`keywords: ${kwHits}/${kwTokens.length} matched (+${sub.toFixed(2)})`);
  }

  let descHits = 0;
  for (const t of descTokens) if (taskTokens.has(t)) descHits++;
  if (descTokens.length > 0 && descHits > 0) {
    const sub = (descHits / descTokens.length) * 0.5;
    score += sub;
    reasons.push(`name+desc: ${descHits}/${descTokens.length} matched (+${sub.toFixed(2)})`);
  }

  // Status nudge — approved > candidate > draft; deprecated is penalized.
  const statusBump: Record<string, number> = {
    approved: 0.3,
    candidate: 0.1,
    draft: 0,
    deprecated: -1.0,
  };
  const bump = statusBump[skill.status] ?? 0;
  if (bump !== 0) {
    score += bump;
    reasons.push(`status=${skill.status} (${bump >= 0 ? "+" : ""}${bump.toFixed(2)})`);
  }

  // Project-scope nudge — repo-local skills are usually more relevant than global.
  if (loaded.scope === "project") {
    score += 0.2;
    reasons.push("scope=project (+0.20)");
  }

  return { score, reasons };
}

export function matchSkills(skills: LoadedSkill[], task: string, limit = 5): SkillMatch[] {
  const taskTokens = new Set(tokenize(task));
  const ranked: SkillMatch[] = [];
  for (const loaded of skills) {
    if (loaded.skill.status === "deprecated") continue;
    const { score, reasons } = scoreSkill(loaded, taskTokens);
    if (score <= 0) continue;
    ranked.push({
      id: loaded.skill.id,
      name: loaded.skill.name,
      description: loaded.skill.description,
      status: loaded.skill.status,
      scope: loaded.scope,
      score,
      reasons,
    });
  }
  ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return ranked.slice(0, limit);
}
