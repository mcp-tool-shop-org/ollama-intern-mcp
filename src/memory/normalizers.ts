/**
 * Normalizers — turn each of the four source kinds into a MemoryRecord.
 *
 * Every normalizer is a pure function over an already-loaded source object;
 * the refresh orchestrator (refresh.ts) handles filesystem scan + reconcile.
 * Keeping normalizers pure lets us unit-test every kind without touching
 * disk, and lets Commit B re-use them if we ever need to re-normalize from
 * in-memory data.
 *
 * Each normalizer is opinionated about what belongs in summary/tags/facets:
 *   - summary: 1–2 sentences max, content-safe (never raw user text)
 *   - tags: tool names, pack kind, status, hw profile, coarse outcomes
 *   - facets: typed fields for Commit B filters (ok, skill_id, hw, etc.)
 */

import type { ArtifactMetadata } from "../tools/artifacts/scan.js";
import type { LoadedSkill } from "../skills/types.js";
import type { SkillReceipt } from "../skills/types.js";
import type { NewSkillProposal } from "../skills/newSkillProposer.js";
import { memoryId, contentDigest } from "./ids.js";
import { MEMORY_SCHEMA_VERSION, type MemoryRecord } from "./types.js";

const SUMMARY_MAX = 300;

function truncate(s: string, max = SUMMARY_MAX): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function assemble(partial: Omit<MemoryRecord, "schema_version" | "indexed_at" | "content_digest" | "id">, now: string): MemoryRecord {
  const digest = contentDigest({
    title: partial.title,
    summary: partial.summary,
    tags: partial.tags,
    facets: partial.facets,
  });
  // Identity depends on kind — computed upstream in the specific normalizer.
  const id = partial.provenance.ref
    ? memoryId(partial.kind, `${partial.provenance.source_kind}|${partial.provenance.ref}`)
    : memoryId(partial.kind, partial.provenance.source_path);
  return {
    ...partial,
    id,
    schema_version: MEMORY_SCHEMA_VERSION,
    indexed_at: now,
    content_digest: digest,
  };
}

// ── skill_receipt ─────────────────────────────────────────────

export function normalizeSkillReceipt(
  receipt: SkillReceipt,
  now: string,
  fileFallback?: string,
): MemoryRecord {
  const toolSequence = receipt.steps.map((s) => s.tool);
  const tokensIn = receipt.steps.reduce((a, s) => {
    const e = s.envelope as { tokens_in?: number } | undefined;
    return a + (e?.tokens_in ?? 0);
  }, 0);
  const tokensOut = receipt.steps.reduce((a, s) => {
    const e = s.envelope as { tokens_out?: number } | undefined;
    return a + (e?.tokens_out ?? 0);
  }, 0);
  const failedStep = receipt.steps.find((s) => !s.ok && !s.skipped);
  const failSuffix = failedStep ? ` — failed at ${failedStep.step_id} (${failedStep.error?.code ?? "UNKNOWN"})` : "";
  const title = `Skill run: ${receipt.skill_id} v${receipt.skill_version}` + (receipt.ok ? " (ok)" : " (failed)");
  const summary = truncate(
    `Executed ${toolSequence.join(" → ")} over ${receipt.elapsed_ms}ms on ${receipt.hardware_profile}. ${receipt.ok ? "All steps ok." : "Pipeline aborted"}${failSuffix}.`,
  );
  const tags = [
    `skill:${receipt.skill_id}`,
    `hw:${receipt.hardware_profile}`,
    receipt.ok ? "outcome:ok" : "outcome:failed",
    ...toolSequence.map((t) => `tool:${t}`),
  ];
  const facets: MemoryRecord["facets"] = {
    skill_id: receipt.skill_id,
    skill_version: receipt.skill_version,
    ok: receipt.ok,
    elapsed_ms: receipt.elapsed_ms,
    step_count: receipt.steps.length,
    tokens_in_total: tokensIn,
    tokens_out_total: tokensOut,
    hardware_profile: receipt.hardware_profile,
  };
  return assemble(
    {
      kind: "skill_receipt",
      created_at: receipt.started_at,
      title,
      summary,
      tags,
      facets,
      provenance: {
        source_kind: "skill_receipt",
        // Prefer the file we actually scanned from; fall back to the self-
        // reported receipt_path if the caller didn't pass a path. Old
        // receipts written before 2026-04-18 have empty receipt_path —
        // this fallback keeps them usable in the memory surface.
        source_path: fileFallback ?? receipt.receipt_path,
        ref: `${receipt.skill_id}|${receipt.started_at}`,
      },
    },
    now,
  );
}

// ── pack_artifact ─────────────────────────────────────────────

export function normalizePackArtifact(meta: ArtifactMetadata, now: string): MemoryRecord {
  const weakSuffix = meta.weak ? " (weak)" : "";
  const corpusPart = meta.corpus_used ? ` • corpus ${meta.corpus_used.name} (${meta.corpus_used.chunks_used} chunks)` : "";
  const sectionCounts = Object.entries(meta.section_counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const summary = truncate(
    `${meta.title}. ${meta.evidence_count} evidence items${corpusPart}. Sections: ${sectionCounts}.`,
  );
  const tags = [
    `pack:${meta.pack}`,
    meta.weak ? "evidence:weak" : "evidence:strong",
    ...(meta.corpus_used ? [`corpus:${meta.corpus_used.name}`] : []),
  ];
  const facets: MemoryRecord["facets"] = {
    pack: meta.pack,
    slug: meta.slug,
    weak: meta.weak,
    evidence_count: meta.evidence_count,
    corpus_used: meta.corpus_used?.name ?? null,
  };
  return assemble(
    {
      kind: "pack_artifact",
      created_at: meta.created_at,
      title: `${meta.pack}: ${meta.title}${weakSuffix}`,
      summary,
      tags,
      facets,
      provenance: {
        source_kind: "pack_artifact",
        source_path: meta.json_path,
        ref: `${meta.pack}:${meta.slug}`,
      },
    },
    now,
  );
}

// ── approved_skill (any status, not just "approved") ──────────

export function normalizeSkill(loaded: LoadedSkill, now: string): MemoryRecord {
  const skill = loaded.skill;
  const toolSeq = skill.pipeline.map((p) => p.tool).join(" → ");
  const summary = truncate(`${skill.description} Pipeline: ${toolSeq}. Status: ${skill.status}.`);
  const tags = [
    `scope:${loaded.scope}`,
    `status:${skill.status}`,
    `source:${skill.provenance.source}`,
    ...skill.trigger.keywords.map((k) => `keyword:${k}`),
    ...skill.pipeline.map((p) => `tool:${p.tool}`),
  ];
  const facets: MemoryRecord["facets"] = {
    skill_id: skill.id,
    status: skill.status,
    version: skill.version,
    scope: loaded.scope,
    runs: skill.provenance.runs,
    promotion_count: skill.provenance.promotion_history?.length ?? 0,
  };
  return assemble(
    {
      kind: "approved_skill",
      created_at: skill.provenance.created_at,
      title: `Skill: ${skill.name} (${skill.status})`,
      summary,
      tags,
      facets,
      provenance: {
        source_kind: "approved_skill",
        source_path: loaded.source_path,
        ref: skill.id,
      },
    },
    now,
  );
}

// ── candidate_proposal ────────────────────────────────────────

export function normalizeCandidateProposal(
  proposal: NewSkillProposal,
  logPath: string,
  now: string,
): MemoryRecord {
  const pipeline = proposal.pipeline_tools.join(" → ");
  const summary = truncate(
    `Candidate new skill detected in ad-hoc chains: ${pipeline}. Support ${proposal.evidence.support} runs at ${(proposal.evidence.success_rate * 100).toFixed(0)}% success; shape agreement ${(proposal.evidence.shape_agreement * 100).toFixed(0)}%.`,
  );
  const tags = [
    "candidate",
    `support:${proposal.evidence.support}`,
    ...proposal.pipeline_tools.map((t) => `tool:${t}`),
  ];
  const facets: MemoryRecord["facets"] = {
    suggested_id: proposal.suggested_id,
    pipeline_length: proposal.pipeline_tools.length,
    support: proposal.evidence.support,
    success_rate: proposal.evidence.success_rate,
    shape_agreement: proposal.evidence.shape_agreement,
    avg_duration_ms: proposal.evidence.avg_duration_ms,
  };
  return assemble(
    {
      kind: "candidate_proposal",
      // No created_at on a proposal — use indexed-at as the anchor.
      created_at: now,
      title: `Candidate skill: ${proposal.suggested_name}`,
      summary,
      tags,
      facets,
      provenance: {
        source_kind: "candidate_proposal",
        source_path: logPath,
        ref: proposal.pipeline_tools.join("→"),
      },
    },
    now,
  );
}
