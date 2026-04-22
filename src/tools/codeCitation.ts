/**
 * ollama_code_citation — Deep tier.
 *
 * Answer a code question with per-claim citations (file + line range). The
 * big difference from ollama_research is the CITATION GEOMETRY: every
 * factual claim in the answer is anchored to a concrete line range, not
 * just a file path.
 *
 * Validation:
 *   - Every returned citation must point at a file in source_paths.
 *     Out-of-scope citations are STRIPPED server-side and a warning is
 *     added (same posture as ollama_research).
 *   - start_line / end_line must be within the loaded file's line count;
 *     out-of-range citations are stripped.
 *   - If the model couldn't anchor a fragment, it goes into
 *     uncited_fragments — the answer still lands but the operator can see
 *     what wasn't grounded.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { loadSources, type LoadedSource } from "../sources.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { parseJsonObject, readArray } from "./briefs/common.js";
import { timestamp } from "../observability.js";
import type { RunContext } from "../runContext.js";

export const codeCitationSchema = z.object({
  question: z
    .string()
    .min(10)
    .max(1000)
    .describe(
      "The code question to answer. 10-1000 chars — specific enough that citations can be anchored ('where does X get validated', not 'tell me about this code').",
    ),
  source_paths: strictStringArray({ min: 1, fieldName: "source_paths" }).describe(
    "Files the answer must be grounded in. Citations to files outside this list are stripped.",
  ),
  per_file_max_chars: z
    .number()
    .int()
    .min(1000)
    .max(500_000)
    .optional()
    .describe("Chars to read per file (default 100_000). Bigger than research because citations need the lines to exist."),
});

export type CodeCitationInput = z.infer<typeof codeCitationSchema>;

export interface CodeCitation {
  claim_fragment: string;
  file: string;
  start_line: number;
  end_line: number;
  excerpt: string;
}

export interface CodeCitationResult {
  answer: string;
  citations: CodeCitation[];
  uncited_fragments: string[];
  weak: boolean;
}

// Map path → total line count, so we can validate (start_line, end_line).
function lineCountsByPath(sources: LoadedSource[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sources) {
    m.set(s.path, s.body.split("\n").length);
  }
  return m;
}

function sourceByPath(sources: LoadedSource[]): Map<string, LoadedSource> {
  const m = new Map<string, LoadedSource>();
  for (const s of sources) m.set(s.path, s);
  return m;
}

function buildPrompt(input: CodeCitationInput, sources: LoadedSource[]): string {
  // Number lines 1-based per file so the model has exact anchors to cite.
  const blocks = sources
    .map((s) => {
      const numbered = s.body
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(5, " ")}  ${line}`)
        .join("\n");
      return `=== BEGIN ${s.path} ===\n${numbered}\n=== END ${s.path} ===`;
    })
    .join("\n\n");
  return [
    `You are a grounded code explainer. Answer the question from the files below.`,
    `Every factual claim must be anchored to a file path + line range.`,
    ``,
    `Question: ${input.question}`,
    ``,
    `Files (lines are 1-based, shown as "<lineno>  <content>"):`,
    blocks,
    ``,
    `Return JSON matching this shape EXACTLY:`,
    `{`,
    `  "answer": "<narrative synthesis that answers the question, 2-8 sentences>",`,
    `  "citations": [`,
    `    {`,
    `      "claim_fragment": "<a short excerpt from the answer that this citation supports>",`,
    `      "file": "<file path exactly as given>",`,
    `      "start_line": <1-based>,`,
    `      "end_line": <1-based, >= start_line>`,
    `    }`,
    `  ],`,
    `  "uncited_fragments": ["<parts of the answer you could NOT anchor to a specific range>"]`,
    `}`,
    ``,
    `Rules:`,
    `- Never cite a file not in the list above.`,
    `- Never invent line numbers. If you aren't sure of the exact range, put that claim into uncited_fragments instead.`,
    `- claim_fragment must be a literal substring of your answer (or a near-verbatim excerpt from it).`,
    `- Keep the answer focused on the question. No preamble.`,
  ].join("\n");
}

function excerptLines(source: LoadedSource, start: number, end: number, maxChars = 400): string {
  const lines = source.body.split("\n");
  const s = Math.max(1, Math.min(start, lines.length));
  const e = Math.max(s, Math.min(end, lines.length));
  const slice = lines.slice(s - 1, e).join("\n");
  return slice.length > maxChars ? slice.slice(0, maxChars) + "..." : slice;
}

export async function handleCodeCitation(
  input: CodeCitationInput,
  ctx: RunContext,
): Promise<Envelope<CodeCitationResult>> {
  const perFileMax = input.per_file_max_chars ?? 100_000;
  const sources = await loadSources(input.source_paths, perFileMax);
  const lineCounts = lineCountsByPath(sources);
  const byPath = sourceByPath(sources);
  const validPathSet = new Set(input.source_paths);
  const warnings: string[] = [];

  const envelope = await runTool<CodeCitationResult>({
    tool: "ollama_code_citation",
    tier: "deep",
    ctx,
    think: true,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input, sources),
      format: "json",
      options: {
        temperature: TEMPERATURE_BY_SHAPE.research,
        num_predict: 2000,
      },
    }),
    parse: (raw): CodeCitationResult => {
      const o = parseJsonObject(raw);
      const answer = typeof o.answer === "string" ? o.answer.trim() : "";

      const cites: CodeCitation[] = [];
      let strippedOutOfScope = 0;
      let strippedBadRange = 0;
      for (const entry of readArray(o, "citations")) {
        const c = entry as {
          claim_fragment?: unknown;
          file?: unknown;
          start_line?: unknown;
          end_line?: unknown;
        };
        if (typeof c.file !== "string") continue;
        // Out-of-scope citation — strip (same rule as ollama_research).
        if (!validPathSet.has(c.file)) {
          strippedOutOfScope += 1;
          continue;
        }
        const src = byPath.get(c.file);
        if (!src) continue;
        const maxLine = lineCounts.get(c.file) ?? 0;
        let start = typeof c.start_line === "number" ? Math.trunc(c.start_line) : NaN;
        let end = typeof c.end_line === "number" ? Math.trunc(c.end_line) : NaN;
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          strippedBadRange += 1;
          continue;
        }
        if (start < 1 || end < 1 || start > maxLine || end > maxLine || start > end) {
          strippedBadRange += 1;
          continue;
        }
        const claim = typeof c.claim_fragment === "string" ? c.claim_fragment.trim() : "";
        cites.push({
          claim_fragment: claim,
          file: c.file,
          start_line: start,
          end_line: end,
          excerpt: excerptLines(src, start, end),
        });
      }

      if (strippedOutOfScope > 0) {
        warnings.push(
          `Stripped ${strippedOutOfScope} citation(s) pointing at files not in source_paths. This is BY DESIGN — ollama_code_citation refuses to cite anything outside the caller-declared source list.`,
        );
      }
      if (strippedBadRange > 0) {
        warnings.push(
          `Stripped ${strippedBadRange} citation(s) with line ranges outside the loaded file bounds.`,
        );
      }

      const uncited: string[] = [];
      for (const u of readArray(o, "uncited_fragments")) {
        if (typeof u === "string" && u.trim().length > 0) uncited.push(u.trim());
      }

      const weak =
        answer.length === 0 ||
        (cites.length === 0 && answer.length > 0);

      return {
        answer,
        citations: cites,
        uncited_fragments: uncited,
        weak,
      };
    },
  });

  if (warnings.length > 0) {
    envelope.warnings = [...(envelope.warnings ?? []), ...warnings];
    await ctx.logger.log({
      kind: "guardrail",
      ts: timestamp(),
      tool: "ollama_code_citation",
      rule: "citations_out_of_scope",
      action: "stripped",
      detail: { warnings: warnings.length },
    });
  }

  return envelope;
}
