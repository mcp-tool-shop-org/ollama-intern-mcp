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
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Envelope } from "../envelope.js";
import { InternError } from "../errors.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { parseCitations, validateCitations, type ValidatedCitation } from "../guardrails/citations.js";
import { timestamp } from "../observability.js";
import type { RunContext } from "../runContext.js";

export const researchSchema = z.object({
  question: z.string().min(1).describe("The question to answer."),
  source_paths: z.array(z.string().min(1)).min(1).describe("Files the answer must be grounded in. Nothing outside this list is allowed as a source."),
  max_words: z.number().int().min(20).max(1500).optional().describe("Target answer length in words (default 300)."),
  per_file_max_chars: z.number().int().min(1000).max(200_000).optional().describe("Chars to read per file (default 40k)."),
});

export type ResearchInput = z.infer<typeof researchSchema>;

export interface ResearchResult {
  answer: string;
  citations: ValidatedCitation[];
}

async function loadSources(paths: string[], perFileMax: number): Promise<Array<{ path: string; body: string }>> {
  const loaded: Array<{ path: string; body: string }> = [];
  for (const p of paths) {
    const abs = resolve(p);
    try {
      const st = await stat(abs);
      if (!st.isFile()) {
        throw new InternError("SOURCE_PATH_NOT_FOUND", `Not a file: ${p}`, "Pass file paths only, not directories.", false);
      }
      const raw = await readFile(abs, "utf8");
      loaded.push({ path: p, body: raw.slice(0, perFileMax) });
    } catch (err) {
      if (err instanceof InternError) throw err;
      throw new InternError(
        "SOURCE_PATH_NOT_FOUND",
        `Cannot read source path: ${p} — ${(err as Error).message}`,
        "Check the path exists and is readable.",
        false,
      );
    }
  }
  return loaded;
}

function buildPrompt(input: ResearchInput, sources: Array<{ path: string; body: string }>): string {
  const maxWords = input.max_words ?? 300;
  const blocks = sources.map((s) => `=== BEGIN ${s.path} ===\n${s.body}\n=== END ${s.path} ===`).join("\n\n");
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

  const envelope = await runTool<ResearchResult>({
    tool: "ollama_research",
    tier: "deep",
    ctx,
    build: (_tier, model) => ({
      model,
      prompt: buildPrompt(input, sources),
      options: { temperature: TEMPERATURE_BY_SHAPE.research, num_predict: Math.ceil((input.max_words ?? 300) * 2.5) },
    }),
    parse: (raw) => {
      const { answer, sources: sourcesBlock } = splitAnswerAndSources(raw);
      const parsed = parseCitations(sourcesBlock);
      const { valid, stripped } = validateCitations(parsed, input.source_paths);
      if (stripped.length > 0) {
        warnings.push(`Stripped ${stripped.length} citation(s) not in source_paths: ${stripped.map((c) => c.path).join(", ")}`);
      }
      return { answer, citations: valid };
    },
  });

  if (warnings.length > 0) {
    envelope.warnings = [...(envelope.warnings ?? []), ...warnings];
    await ctx.logger.log({
      kind: "guardrail",
      ts: timestamp(),
      tool: "ollama_research",
      rule: "citations",
      action: "stripped",
      detail: { count: warnings.length },
    });
  }

  return envelope;
}
