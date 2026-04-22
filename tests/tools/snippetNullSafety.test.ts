/**
 * Stage B+C — snippet renderer null-safety.
 *
 * A minimal/empty artifact should still produce valid markdown — never
 * "undefined" sections and never thrown TypeErrors. Locks the defensive
 * guards in src/tools/artifacts/snippets.ts.
 */

import { describe, it, expect } from "vitest";
import {
  renderIncidentNote,
  renderOnboardingSection,
  renderReleaseNote,
} from "../../src/tools/artifacts/snippets.js";
import type { IncidentPackArtifact } from "../../src/tools/packs/incidentPack.js";
import type { RepoPackArtifact } from "../../src/tools/packs/repoPack.js";
import type { ChangePackArtifact } from "../../src/tools/packs/changePack.js";

const COMMON_STEM = {
  schema_version: 1 as const,
  generated_at: "2026-04-17T10:00:00Z",
  hardware_profile: "dev-rtx5080",
  title: "empty",
  slug: "empty",
  artifact: { markdown_path: "/tmp/empty.md", json_path: "/tmp/empty.json" },
  steps: [],
};

describe("renderIncidentNote — null-safety", () => {
  it("renders a valid note when the brief has empty arrays", () => {
    const artifact: IncidentPackArtifact = {
      ...COMMON_STEM,
      pack: "incident_pack",
      input: { has_log_text: false, source_paths: [], corpus: null, corpus_query: null },
      triage: null,
      brief: {
        root_cause_hypotheses: [],
        affected_surfaces: [],
        timeline_clues: [],
        next_checks: [],
        evidence: [],
        weak: true,
        coverage_notes: [],
        corpus_used: null,
      },
    };
    const md = renderIncidentNote(artifact);
    expect(md).not.toContain("undefined");
    expect(md).toContain("# Incident: empty");
    expect(md).toContain("_No hypotheses were produced._");
    expect(md).toContain("_None identified._");
    expect(md).toContain("_No next checks proposed._");
  });

  it("does not throw on partially-missing brief fields (runtime-corrupt artifact)", () => {
    // Deliberately malformed to simulate a disk-level corruption the
    // renderer must survive — it's a derivation step, never a gatekeeper.
    const malformed = {
      ...COMMON_STEM,
      pack: "incident_pack",
      input: { has_log_text: false, source_paths: [], corpus: null, corpus_query: null },
      triage: null,
      brief: { weak: false } as unknown,
    } as unknown as IncidentPackArtifact;
    const md = renderIncidentNote(malformed);
    expect(md).not.toContain("undefined");
    expect(md).toContain("_No hypotheses were produced._");
  });
});

describe("renderOnboardingSection — null-safety", () => {
  it("renders a valid section when the brief has null thesis and no surfaces", () => {
    const artifact: RepoPackArtifact = {
      ...COMMON_STEM,
      pack: "repo_pack",
      input: { source_paths: [], corpus: null, corpus_query: null },
      brief: {
        repo_thesis: "",
        key_surfaces: [],
        architecture_shape: "",
        risk_areas: [],
        read_next: [],
        coverage_notes: [],
        evidence: [],
        weak: true,
        corpus_used: null,
      },
      extracted_facts: null,
    };
    const md = renderOnboardingSection(artifact);
    expect(md).not.toContain("undefined");
    expect(md).toContain("## What this repo is");
    expect(md).toContain("_The brief produced no thesis._");
    expect(md).toContain("_None identified._");
    expect(md).toContain("_No read-next recommendations._");
    // Runtime section only renders when hints exist
    expect(md).not.toContain("### Runtime");
  });

  it("does not explode when extracted_facts contains only null/missing fields", () => {
    const artifact = {
      ...COMMON_STEM,
      pack: "repo_pack" as const,
      input: { source_paths: [], corpus: null, corpus_query: null },
      brief: {
        repo_thesis: "A thing.",
        key_surfaces: [],
        architecture_shape: "",
        risk_areas: [],
        read_next: [],
        coverage_notes: [],
        evidence: [],
        weak: false,
        corpus_used: null,
      },
      extracted_facts: { runtime_hints: null } as unknown,
    } as unknown as RepoPackArtifact;
    const md = renderOnboardingSection(artifact);
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("### Runtime");
  });
});

describe("renderReleaseNote — null-safety", () => {
  it("renders placeholder copy when release_note_draft is empty string", () => {
    const artifact: ChangePackArtifact = {
      ...COMMON_STEM,
      pack: "change_pack",
      input: { has_diff_text: false, has_log_text: false, source_paths: [], corpus: null, corpus_query: null },
      triage: null,
      brief: {
        change_summary: "",
        affected_surfaces: [],
        why_it_matters: "",
        likely_breakpoints: [],
        validation_checks: [],
        release_note_draft: "",
        coverage_notes: [],
        evidence: [],
        weak: false,
        corpus_used: null,
      },
      extracted_facts: null,
    };
    const md = renderReleaseNote(artifact);
    expect(md).not.toContain("undefined");
    expect(md).toContain("_No release note draft was produced for this change._");
  });

  it("does not throw when the brief is missing release_note_draft entirely", () => {
    const malformed = {
      ...COMMON_STEM,
      pack: "change_pack" as const,
      input: { has_diff_text: false, has_log_text: false, source_paths: [], corpus: null, corpus_query: null },
      triage: null,
      brief: {} as unknown,
      extracted_facts: null,
    } as unknown as ChangePackArtifact;
    const md = renderReleaseNote(malformed);
    expect(md).not.toContain("undefined");
    expect(md).toContain("_No release note draft was produced for this change._");
  });
});
