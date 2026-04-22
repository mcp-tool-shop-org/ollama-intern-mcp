/**
 * ollama_hypothesis_drill — Deep tier.
 *
 * Drill into ONE hypothesis from an existing incident_pack artifact, without
 * re-running the whole pack. Loads the artifact by slug, extracts the
 * targeted hypothesis + its linked evidence, and asks the Deep tier for a
 * focused sub-brief.
 *
 * This is the "zoom in" primitive over an already-landed incident — you get
 * the artifact once, then drill into whichever hypothesis mattered without
 * paying for triage_logs + corpus_search again.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { parseJsonObject, readArray, normalizeConfidence } from "./briefs/common.js";
import {
  resolveArtifactByIdentity,
  readArtifactAtPath,
  type ScanOptions,
} from "./artifacts/scan.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";
import type { IncidentPackArtifact } from "./packs/incidentPack.js";
import type { EvidenceItem } from "./briefs/evidence.js";

export const hypothesisDrillSchema = z.object({
  artifact_slug: z
    .string()
    .min(1)
    .describe("Slug of an existing incident_pack artifact. See ollama_artifact_list for available slugs."),
  hypothesis_index: z
    .number()
    .int()
    .min(0)
    .describe("0-based index into the artifact's root_cause_hypotheses array."),
  extra_artifact_dirs: z
    .array(z.string().min(1))
    .optional()
    .describe("Extra read-only search dirs (same semantics as artifact_list / artifact_read)."),
});

export type HypothesisDrillInput = z.infer<typeof hypothesisDrillSchema>;

export interface DrilledEvidence {
  id: string;
  preview: string;
}

export interface DrilledHypothesis {
  statement: string;
  confidence: "low" | "medium" | "high";
  evidence_cited: DrilledEvidence[];
  supporting_reasoning: string;
  ruled_out_reasons?: string;
}

export interface OtherHypothesisSummary {
  index: number;
  summary: string;
}

export interface HypothesisDrillResult {
  parent_artifact_slug: string;
  drilled_hypothesis: DrilledHypothesis;
  other_hypotheses_summary: OtherHypothesisSummary[];
  weak: boolean;
}

async function loadIncidentArtifact(
  slug: string,
  scanOpts: ScanOptions,
): Promise<IncidentPackArtifact> {
  let metadata;
  try {
    metadata = await resolveArtifactByIdentity("incident_pack", slug, scanOpts);
  } catch (err) {
    // Re-map missing-artifact into our own code for cleaner caller ergonomics.
    if (err instanceof InternError && err.code === "SOURCE_PATH_NOT_FOUND") {
      throw new InternError(
        "ARTIFACT_NOT_FOUND",
        `No incident_pack artifact found for slug="${slug}".`,
        "Run ollama_artifact_list to see available incident_pack slugs, or pass extra_artifact_dirs if the artifact lives outside the canonical dirs.",
        false,
      );
    }
    throw err;
  }
  const artifact = await readArtifactAtPath(metadata.json_path, scanOpts);
  if (artifact.pack !== "incident_pack") {
    throw new InternError(
      "ARTIFACT_NOT_FOUND",
      `Artifact "${slug}" is not an incident_pack (pack=${artifact.pack}).`,
      "hypothesis_drill only supports incident_pack artifacts. Use ollama_artifact_list with pack_filter to find the right identity.",
      false,
    );
  }
  return artifact;
}

function buildPrompt(
  hypothesisText: string,
  confidence: string,
  cited: EvidenceItem[],
  question: string,
): string {
  const evidenceBlock = cited.length > 0
    ? cited.map((e) => `[${e.id}] kind=${e.kind} ref=${e.ref}\n${e.excerpt}`).join("\n\n")
    : "(no evidence was cited on this hypothesis — reason from the hypothesis statement alone)";
  return [
    `You are an incident analyst drilling into a single hypothesis from a prior brief.`,
    `You are NOT rewriting the brief. You are producing a focused sub-brief.`,
    ``,
    `Hypothesis: ${hypothesisText}`,
    `Original confidence: ${confidence}`,
    ``,
    `Evidence cited on this hypothesis:`,
    evidenceBlock,
    ``,
    `Drill question: ${question}`,
    ``,
    `Return JSON matching this shape EXACTLY:`,
    `{`,
    `  "supporting_reasoning": "<paragraph on why the evidence supports (or fails to support) the hypothesis>",`,
    `  "ruled_out_reasons": "<optional paragraph on what would rule it out, or reasons it might already be ruled out>",`,
    `  "confidence": "high" | "medium" | "low"`,
    `}`,
    ``,
    `Rules:`,
    `- Cite ONLY the evidence ids above. Do not invent new evidence.`,
    `- If the evidence is thin, say so plainly in supporting_reasoning and return a lower confidence than the original.`,
    `- No remediation. This is investigative reasoning only.`,
  ].join("\n");
}

export async function handleHypothesisDrill(
  input: HypothesisDrillInput,
  ctx: RunContext,
): Promise<Envelope<HypothesisDrillResult>> {
  const scanOpts: ScanOptions = {
    ...(input.extra_artifact_dirs ? { extra_artifact_dirs: input.extra_artifact_dirs } : {}),
  };
  const artifact = await loadIncidentArtifact(input.artifact_slug, scanOpts);
  const hypotheses = artifact.brief.root_cause_hypotheses;
  if (input.hypothesis_index < 0 || input.hypothesis_index >= hypotheses.length) {
    throw new InternError(
      "HYPOTHESIS_INDEX_INVALID",
      `hypothesis_index=${input.hypothesis_index} is out of range (artifact "${input.artifact_slug}" has ${hypotheses.length} hypotheses).`,
      `Use a 0-based index between 0 and ${Math.max(0, hypotheses.length - 1)}. Inspect the parent artifact with ollama_artifact_read to see the hypothesis list.`,
      false,
    );
  }

  const target = hypotheses[input.hypothesis_index];
  const evidenceById = new Map<string, EvidenceItem>(
    artifact.brief.evidence.map((e) => [e.id, e]),
  );
  const cited: EvidenceItem[] = target.evidence_refs
    .map((id) => evidenceById.get(id))
    .filter((e): e is EvidenceItem => Boolean(e));

  const otherSummaries: OtherHypothesisSummary[] = hypotheses
    .map((h, i) => ({ index: i, summary: h.hypothesis }))
    .filter((s) => s.index !== input.hypothesis_index);

  const validIds = new Set(cited.map((e) => e.id));
  const parseWarnings: string[] = [];

  return runTool<HypothesisDrillResult>({
    tool: "ollama_hypothesis_drill",
    tier: "deep",
    ctx,
    think: true,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(
        target.hypothesis,
        target.confidence,
        cited,
        `Drill in: what does the evidence actually say, what's missing, and should the confidence change?`,
      ),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 1200,
      },
    }),
    parse: (raw): HypothesisDrillResult => {
      const o = parseJsonObject(raw);
      const reasoning =
        typeof o.supporting_reasoning === "string" ? o.supporting_reasoning.trim() : "";
      const ruledOut =
        typeof o.ruled_out_reasons === "string" && o.ruled_out_reasons.trim().length > 0
          ? o.ruled_out_reasons.trim()
          : undefined;
      const confidence = normalizeConfidence(o.confidence);

      // Any `id` strings in the output are informational only — the server
      // already knows which evidence applies (cited[]). But keep the `id`
      // field in evidence_cited stable so callers can cross-reference the
      // parent artifact.
      void readArray(o, "evidence_ids"); // accept-and-ignore
      void validIds;

      const drilled: DrilledHypothesis = {
        statement: target.hypothesis,
        confidence,
        evidence_cited: cited.map((e) => ({
          id: e.id,
          preview: e.excerpt.length > 200 ? e.excerpt.slice(0, 200) + "..." : e.excerpt,
        })),
        supporting_reasoning: reasoning,
      };
      if (ruledOut) drilled.ruled_out_reasons = ruledOut;

      const weak =
        reasoning.length === 0 ||
        (cited.length === 0 && reasoning.length < 60);

      if (cited.length === 0) {
        parseWarnings.push(
          `Hypothesis index ${input.hypothesis_index} had no evidence_refs in the parent artifact; drill result is reasoning-only.`,
        );
      }

      const result: HypothesisDrillResult = {
        parent_artifact_slug: input.artifact_slug,
        drilled_hypothesis: drilled,
        other_hypotheses_summary: otherSummaries,
        weak,
      };
      return result;
    },
    warnings: parseWarnings,
  });
}
