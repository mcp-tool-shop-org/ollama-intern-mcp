/**
 * ollama_research — FLAGSHIP TOOL.
 *
 * Takes file *paths*, not raw text. Reads and chunks locally, returns a
 * digest with validated citations. This is context preservation as a
 * product feature — exactly the bulk work Claude should not burn
 * premium context on.
 *
 * Tier: Deep.
 *
 * Guardrails:
 * - All paths in source_paths must exist (SOURCE_PATH_NOT_FOUND otherwise)
 * - Citations returned by the model are validated against source_paths;
 *   any path not in the input is stripped and a warning added to the envelope.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import {
  parseCitations,
  validateCitations,
  buildCitationStripEventDetails,
  type ValidatedCitation,
  type CitationValidationResult,
} from "../guardrails/citations.js";
import { loadSources, formatSourcesBlock, type LoadedSource } from "../sources.js";
import { detectCoverage } from "../coverage.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { normalizePath } from "../protectedPaths.js";
import type { RunContext } from "../runContext.js";
import { buildGuardrailEventWithCorrelation } from "./_runContext.js";

export const researchSchema = z.object({
  question: z.string().min(1).describe("The question to answer."),
  source_paths: strictStringArray({ min: 1, fieldName: "source_paths" }).describe("Files the answer must be grounded in. Nothing outside this list is allowed as a source."),
  max_words: z.number().int().min(20).max(1500).optional().describe("Target answer length in words (default 300)."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars to read per file (default 40k)."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Optional per-call model override. When provided, overrides the " +
        "tool's tier-resolved model for this call. The tier's timeout " +
        "(TIER_TIMEOUT_MS) still applies. On timeout, fallback uses the " +
        "tier-resolved model, NOT the override. Use for receipt-backed " +
        "orchestration that requires explicit model identity (e.g., " +
        "research-os reviewer profiles).",
    ),
});

export type ResearchInput = z.infer<typeof researchSchema>;

export interface ResearchResult {
  answer: string;
  citations: ValidatedCitation[];
  covered_sources?: string[];
  omitted_sources?: string[];
  coverage_notes?: string[];
  /**
   * The model produced a non-empty answer but every cited path was
   * stripped (or it cited nothing at all). The answer is likely
   * ungrounded — treat it as a hint, not a fact.
   */
  weak?: boolean;
  /**
   * The model explicitly declined to answer (matched the abstention
   * regex). Citations are cleared; the answer text contains the
   * abstention statement.
   */
  abstained?: boolean;
  /**
   * Tri-state: true when sources appear to address the question (citations
   * survived validation), false when the model abstained or produced an
   * answer with no validated citations, null when we don't know.
   */
  sources_address_question?: boolean | null;
}

// Abstention regex — case-insensitive. Matches the phrases the
// research prompt steers the model toward when grounding is missing.
// Anchored loosely so it catches "the sources don't contain", "the source
// does not address", "insufficient information", "cannot answer",
// "unable to determine/answer". Tight enough to avoid matching ordinary
// answers that happen to use the words "sources" and "contain".
const ABSTENTION_RX = /(?:the sources?\s+(?:do not|don't|does not|doesn't)\s+(?:contain|address|cover)|insufficient\s+(?:information|evidence)|cannot\s+answer|unable\s+to\s+(?:determine|answer))/i;

function buildPrompt(input: ResearchInput, sources: LoadedSource[]): string {
  const maxWords = input.max_words ?? 300;
  const blocks = formatSourcesBlock(sources);
  return [
    `You are a grounded research assistant. Answer ONLY from the source files below.`,
    `Never invent facts. If the sources do not contain the answer, say so.`,
    ``,
    `Write your answer in at most ${maxWords} words, then a "Sources:" block listing`,
    `the files you used, one per line as: <path>:<line_range> (line_range optional).`,
    `Do not cite any file not in the provided source list.`,
    ``,
    `Question: ${input.question}`,
    ``,
    `Sources:`,
    blocks,
  ].join("\n");
}

function splitAnswerAndSources(raw: string): { answer: string; sources: string } {
  const idx = raw.search(/\n\s*Sources?:\s*/i);
  if (idx === -1) return { answer: raw.trim(), sources: "" };
  return { answer: raw.slice(0, idx).trim(), sources: raw.slice(idx) };
}

export async function handleResearch(
  input: ResearchInput,
  ctx: RunContext,
): Promise<Envelope<ResearchResult>> {
  const perFileMax = input.per_file_max_chars ?? 40_000;
  const sources = await loadSources(input.source_paths, perFileMax);
  const warnings: string[] = [];

  // Build the line-count map for bounds-checking model-emitted line
  // ranges. Keyed by the normalized path so it matches whatever the model
  // wrote (./foo or backslash variants both normalize to the same key).
  const linesByPath = new Map<string, number>();
  for (const s of sources) {
    // body was already sliced to perFileMax — count the lines the model
    // actually had access to, not the file on disk. If a model cites a
    // line beyond what we fed it, that's still out-of-bounds for the
    // grounded answer.
    const lineCount = s.body.split(/\r?\n/).length;
    linesByPath.set(normalizePath(s.path), lineCount);
  }

  // Capture the most-recent citation validation result so we can emit
  // per-strip event details after the runner returns. The parse closure
  // runs once per attempt (re-runs on fallback retry use the same
  // closure), and the final attempt's result is what the caller sees —
  // so a single `let` mirror is enough. Initialized to an empty result
  // so the post-runner block is safe even when the call short-circuits
  // before parse ever runs.
  let citationResult: CitationValidationResult = {
    valid: [],
    stripped: [],
    out_of_bounds_ranges: [],
  };

  const envelope = await runTool<ResearchResult>({
    tool: "ollama_research",
    tier: "deep",
    ctx,
    think: true,
    modelOverride: input.model,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input, sources),
      options: { temperature: TEMPERATURE_BY_SHAPE.research, num_predict: Math.ceil((input.max_words ?? 300) * 2.5) },
    }),
    parse: (raw): ResearchResult => {
      const { answer, sources: sourcesBlock } = splitAnswerAndSources(raw);
      const parsed = parseCitations(sourcesBlock);
      const validation = validateCitations(parsed, input.source_paths, linesByPath);
      const { valid, stripped, out_of_bounds_ranges } = validation;
      citationResult = validation;
      if (stripped.length > 0) {
        warnings.push(
          `Stripped ${stripped.length} citation(s) the model emitted that were not in source_paths: ${stripped.map((c) => c.path).join(", ")}. This is BY DESIGN — research refuses to cite anything outside the caller-declared source list, it is not a bug. If those paths matter, re-run with them included in source_paths.`,
        );
      }
      if (out_of_bounds_ranges.length > 0) {
        warnings.push(
          `Dropped line_range on ${out_of_bounds_ranges.length} citation(s) — the model pointed past EOF: ${out_of_bounds_ranges.map((r) => `${r.path}:${r.line_range} (file has ${r.file_lines} lines)`).join("; ")}. Path-only citations were preserved.`,
        );
      }
      const base: ResearchResult = { answer, citations: valid };

      // Honest grounding signal. Three buckets:
      //   - abstained: the model produced an explicit refusal phrase
      //   - weak: model produced text but zero validated citations
      //   - normal: at least one citation survived validation
      const answerTrim = answer.trim();
      const answerNonEmpty = answerTrim.length > 0;
      if (answerNonEmpty && ABSTENTION_RX.test(answerTrim)) {
        base.abstained = true;
        base.sources_address_question = false;
        // Model refused — citations on an abstention answer are spurious.
        base.citations = [];
        const notes = base.coverage_notes ?? [];
        notes.push(
          "Model abstained — answer matched an abstention phrase. Treat the answer as a refusal, not a fact; citations were stripped to keep the contract clean.",
        );
        base.coverage_notes = notes;
      } else if (answerNonEmpty && valid.length === 0) {
        base.weak = true;
        base.abstained = false;
        base.sources_address_question = false;
        const notes = base.coverage_notes ?? [];
        notes.push(
          "Model produced answer with no validated citations from source_paths — answer may be ungrounded.",
        );
        base.coverage_notes = notes;
      } else {
        base.abstained = false;
        // Tri-state: we don't actually know the sources address the
        // question just because the model cited something. Stay honest.
        base.sources_address_question = null;
      }

      // Coverage only meaningful with multiple sources — one-source research
      // either cites or doesn't, and the citation check already covers it.
      // Skip when abstained: there's nothing to cover.
      if (sources.length >= 2 && !base.abstained) {
        const cov = detectCoverage(answer, sources, {
          explicitlyCovered: valid.map((c) => c.path),
        });
        base.covered_sources = cov.covered_sources;
        base.omitted_sources = cov.omitted_sources;
        if (cov.coverage_notes.length > 0) {
          base.coverage_notes = [...(base.coverage_notes ?? []), ...cov.coverage_notes];
        }
      }
      return base;
    },
  });

  if (warnings.length > 0) {
    envelope.warnings = [...(envelope.warnings ?? []), ...warnings];
    // FT-017: emit one structured guardrail event per stripped citation
    // (or per dropped line_range) instead of a single { count } summary.
    // An operator grepping the NDJSON log can now answer "which path
    // did the model fabricate?" without re-running the call. Also
    // attaches FT-010 correlation fields (run_id, parent_call_id) via
    // buildGuardrailEventWithCorrelation so events stitch back to the
    // owning envelope. Falls back to a count-summary event when the
    // per-strip details array is empty (shouldn't happen given the
    // warnings.length>0 guard, but defensive).
    const details = buildCitationStripEventDetails(citationResult);
    if (details.length > 0) {
      for (const detail of details) {
        await ctx.logger.log(
          buildGuardrailEventWithCorrelation({
            tool: "ollama_research",
            rule: "citations",
            action: "stripped",
            detail,
          }),
        );
      }
    } else {
      await ctx.logger.log(
        buildGuardrailEventWithCorrelation({
          tool: "ollama_research",
          rule: "citations",
          action: "stripped",
          detail: { count: warnings.length },
        }),
      );
    }
  }

  return envelope;
}
