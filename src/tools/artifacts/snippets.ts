/**
 * Pack-shaped snippet renderers.
 *
 * Each render function takes a full artifact (JSON-parsed) and returns
 * a compact markdown FRAGMENT suited to a specific handoff context:
 *
 *   renderIncidentNote       → operator note you'd paste into an
 *                              incident channel, runbook, or postmortem
 *   renderOnboardingSection  → "what this repo is" block for handbook
 *                              / onboarding docs
 *   renderReleaseNote        → release note draft fragment (blockquote
 *                              + DRAFT caveat preserved)
 *
 * Laws:
 *   - No model calls. Pure rendering from existing artifact content.
 *   - Pack-shaped, not flattened. Each fragment has a distinct shape.
 *   - Deterministic — same input, same output, stable line order.
 *   - Operator tone preserved: evidence-aware for incident, investigative
 *     for onboarding, visibly draft-like for release notes.
 */

import type { IncidentPackArtifact } from "../packs/incidentPack.js";
import type { RepoPackArtifact } from "../packs/repoPack.js";
import type { ChangePackArtifact } from "../packs/changePack.js";

// Top-N defaults keep snippets compact. Full artifact is always available
// via artifact_read for callers who want the whole thing.
const MAX_HYPOTHESES = 3;
const MAX_SURFACES = 5;
const MAX_CHECKS = 5;
const MAX_READ_NEXT = 5;
const MAX_KEY_SURFACES = 5;

function sourceLine(pack: string, slug: string, createdAt: string): string {
  return `_Source: ${pack} artifact \`${slug}\` (generated ${createdAt})._`;
}

/**
 * Incident note fragment — designed to be pasted into a postmortem or
 * incident channel. Evidence-aware: every hypothesis / surface / check
 * keeps the operator tone from the brief.
 */
export function renderIncidentNote(artifact: IncidentPackArtifact): string {
  const b = artifact.brief ?? ({} as IncidentPackArtifact["brief"]);
  const hypotheses = Array.isArray(b.root_cause_hypotheses) ? b.root_cause_hypotheses : [];
  const surfaces = Array.isArray(b.affected_surfaces) ? b.affected_surfaces : [];
  const nextChecks = Array.isArray(b.next_checks) ? b.next_checks : [];
  const title = artifact.title ?? "(untitled incident)";
  const jsonPath = artifact.artifact?.json_path ?? "(unknown path)";
  const lines: string[] = [];

  lines.push(`# Incident: ${title}`);
  lines.push("");

  if (b.weak) {
    lines.push(`> ⚠ Weak brief — coverage is thin. Full artifact at \`${jsonPath}\`.`);
    lines.push("");
  }

  // Root cause — top 3 hypotheses.
  lines.push(`**Root cause (likely)**`);
  if (hypotheses.length === 0) {
    lines.push(`- _No hypotheses were produced._`);
  } else {
    for (const h of hypotheses.slice(0, MAX_HYPOTHESES)) {
      const conf = h?.confidence ?? "low";
      const text = h?.hypothesis ?? "(no hypothesis text)";
      lines.push(`- [${conf}] ${text}`);
    }
  }
  lines.push("");

  // Affected surfaces.
  lines.push(`**Affected**`);
  if (surfaces.length === 0) {
    lines.push(`- _None identified._`);
  } else {
    for (const s of surfaces.slice(0, MAX_SURFACES)) {
      lines.push(`- ${s?.surface ?? "(unnamed surface)"}`);
    }
  }
  lines.push("");

  // Next checks — investigative, numbered.
  lines.push(`**Next checks**`);
  if (nextChecks.length === 0) {
    lines.push(`- _No next checks proposed._`);
  } else {
    nextChecks.slice(0, MAX_CHECKS).forEach((c, i) => {
      const why = typeof c?.why === "string" && c.why.trim().length > 0 ? ` — _${c.why.trim()}_` : "";
      const check = c?.check ?? "(no check text)";
      lines.push(`${i + 1}. ${check}${why}`);
    });
  }
  lines.push("");

  lines.push(sourceLine("incident_pack", artifact.slug ?? "(unknown slug)", artifact.generated_at ?? "(unknown time)"));
  return lines.join("\n");
}

/**
 * Onboarding section fragment — shaped for handbook / onboarding docs.
 * Tight, concrete, investigative. Read-next items are always labeled as
 * things to LOOK AT, never prescriptive fixes.
 */
export function renderOnboardingSection(artifact: RepoPackArtifact): string {
  const b = artifact.brief ?? ({} as RepoPackArtifact["brief"]);
  const facts = artifact.extracted_facts;
  const keySurfaces = Array.isArray(b.key_surfaces) ? b.key_surfaces : [];
  const readNext = Array.isArray(b.read_next) ? b.read_next : [];
  const thesis = typeof b.repo_thesis === "string" ? b.repo_thesis.trim() : "";
  const jsonPath = artifact.artifact?.json_path ?? "(unknown path)";
  const lines: string[] = [];

  lines.push(`## What this repo is`);
  lines.push("");

  if (thesis.length > 0) {
    lines.push(thesis);
  } else {
    lines.push(`_The brief produced no thesis._`);
  }

  if (b.weak) {
    lines.push("");
    lines.push(`> ⚠ Weak brief — this section reflects thin coverage. Full artifact at \`${jsonPath}\`.`);
  }
  lines.push("");

  // Key surfaces (compact, with why).
  lines.push(`### Key surfaces`);
  lines.push("");
  if (keySurfaces.length === 0) {
    lines.push(`_None identified._`);
  } else {
    for (const s of keySurfaces.slice(0, MAX_KEY_SURFACES)) {
      const surface = s?.surface ?? "(unnamed surface)";
      const why = typeof s?.why === "string" && s.why.trim().length > 0 ? ` — ${s.why.trim()}` : "";
      lines.push(`- **${surface}**${why}`);
    }
  }
  lines.push("");

  // Read next — files/sections to look at, never prescriptive.
  lines.push(`### Read next`);
  lines.push("");
  if (readNext.length === 0) {
    lines.push(`_No read-next recommendations._`);
  } else {
    readNext.slice(0, MAX_READ_NEXT).forEach((r, i) => {
      const why = typeof r?.why === "string" && r.why.trim().length > 0 ? ` — _${r.why.trim()}_` : "";
      const file = r?.file ?? "(unnamed file)";
      lines.push(`${i + 1}. \`${file}\`${why}`);
    });
  }
  lines.push("");

  // Runtime hints from extracted_facts when available — concrete, concise.
  const runtimeHints = Array.isArray(facts?.runtime_hints) ? facts?.runtime_hints.filter((h): h is string => typeof h === "string" && h.length > 0) : [];
  if (runtimeHints && runtimeHints.length > 0) {
    lines.push(`### Runtime`);
    lines.push("");
    for (const hint of runtimeHints) {
      lines.push(`- ${hint}`);
    }
    lines.push("");
  }

  lines.push(sourceLine("repo_pack", artifact.slug ?? "(unknown slug)", artifact.generated_at ?? "(unknown time)"));
  return lines.join("\n");
}

/**
 * Release note snippet — blockquote-wrapped DRAFT exactly as the
 * change_pack artifact ships it. Visibly draft-like; no polishing,
 * no marketing lift, no model re-run.
 */
export function renderReleaseNote(artifact: ChangePackArtifact): string {
  const rawDraft = artifact.brief?.release_note_draft;
  const draft = typeof rawDraft === "string" ? rawDraft.trim() : "";
  const slug = artifact.slug ?? "(unknown slug)";
  const when = artifact.generated_at ?? "(unknown time)";
  const lines: string[] = [];
  if (draft.length === 0) {
    lines.push(`_No release note draft was produced for this change._`);
    lines.push("");
    lines.push(sourceLine("change_pack", slug, when));
    return lines.join("\n");
  }
  for (const l of draft.split(/\r?\n/)) {
    lines.push(`> ${l}`);
  }
  lines.push("");
  lines.push(`_Draft — the operator reviews before publishing._`);
  lines.push("");
  lines.push(sourceLine("change_pack", slug, when));
  return lines.join("\n");
}
