/**
 * Tool-layer helpers.
 *
 * Small, shared utilities for brief / pack tools. Keeps domain-specific
 * normalization out of individual handlers without bloating the common
 * briefs module, which is already evidence-focused.
 */

import { z } from "zod";
import { posix } from "node:path";
import { InternError } from "../errors.js";

/**
 * Max length for a user-supplied corpus_query string. 200 chars is well
 * past any reasonable natural-language query yet small enough that a
 * novice/noisy caller can't fill the embedding input with fence-delimited
 * prose blobs or whole log excerpts.
 */
export const MAX_CORPUS_QUERY_CHARS = 200;

/**
 * Tail appended to every corpus_query .describe() so the cap is visible in
 * the tool picker, not just in the SCHEMA_INVALID a caller hits mid-run.
 * One constant across all six tools that expose the field — a cap stated
 * six different ways drifts on the first edit.
 */
export const CORPUS_QUERY_CAP_NOTE =
  ` (max ${MAX_CORPUS_QUERY_CHARS} chars — deliberately shorter than ollama_corpus_search.query's 1000, because this is a short retrieval prompt, not a document.)`;

/**
 * Enforce the corpus_query length + shape contract.
 *
 * The query flows through to embedding + prompt contexts; long multi-line
 * payloads dilute the vector, waste tokens, and can smuggle code-fence
 * delimiters into prompts. Reject rather than silently truncating — the
 * caller learns the limit the first time.
 *
 * Strips newlines (CR/LF) and fence markers from OTHERWISE-valid queries
 * as a convenience: they're always mistakes, never intent.
 */
/**
 * Strip prompt-injection vectors from a user-supplied field: code-fence
 * delimiters and CR/LF become spaces, then runs of whitespace collapse. A
 * user field can no longer break out of its slot in an LLM prompt with a
 * fenced block or a newline-delimited "IGNORE ABOVE" instruction.
 */
export function stripInjectionVectors(raw: string): string {
  return raw.replace(/```/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Sanitize a user-supplied field that flows VERBATIM into an LLM prompt
 * (classify labels/frame, research question — M9). Strips injection vectors
 * (fences/newlines) then rejects if the cleaned text exceeds maxChars.
 * Returns the cleaned text. The length reject keeps a caller from filling the
 * prompt budget with a whole log/diff blob under the guise of one field.
 */
export function sanitizePromptField(
  raw: string,
  opts: { fieldName: string; maxChars: number },
): string {
  const cleaned = stripInjectionVectors(raw);
  if (cleaned.length > opts.maxChars) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${opts.fieldName} exceeds ${opts.maxChars} chars after stripping newlines/fences (got ${cleaned.length}).`,
      `Shorten ${opts.fieldName} to a concise single-line value under ${opts.maxChars} chars — it is interpolated directly into the model prompt, so newlines and code fences are stripped.`,
      false,
    );
  }
  return cleaned;
}

export function normalizeCorpusQuery(
  raw: string | undefined,
  opts: { fieldName?: string } = {},
): string | undefined {
  if (raw === undefined) return undefined;
  const field = opts.fieldName ?? "corpus_query";
  // Strip fences + newlines first — if the cleaned query fits within the
  // cap we keep the call alive instead of rejecting on trivia.
  const cleaned = stripInjectionVectors(raw);
  if (cleaned.length > MAX_CORPUS_QUERY_CHARS) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${field} exceeds ${MAX_CORPUS_QUERY_CHARS} chars after stripping newlines/fences (got ${cleaned.length}).`,
      `Corpus queries are short retrieval prompts, not log excerpts or diff blobs. Shorten to under ${MAX_CORPUS_QUERY_CHARS} chars — if the signal you need is a whole log, pass it as log_text instead.`,
      false,
    );
  }
  return cleaned;
}

/**
 * Posix-normalize a path for allowlist comparison: backslashes become
 * slashes, `.` / `..` collapse, a leading `./` is stripped.
 */
export function posixNormPath(p: string): string {
  let n = posix.normalize(p.replace(/\\/g, "/"));
  while (n.startsWith("./")) n = n.slice(2);
  return n;
}

function posixIsAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("//") || /^[A-Za-z]:\//.test(p);
}

/**
 * Allowlist membership for model-cited paths vs caller/diff paths.
 *
 * Exact posix-normalized equality always matches. A separator-safe suffix
 * matches only when the shorter side contains a path separator (rel vs abs
 * of the same file) AND the longer side is absolute. Bare filenames
 * (`package.json`) must equal exactly — `node_modules/evil/package.json`
 * must not inherit membership from a git-diff basename, and
 * `evil/src/index.ts` must not inherit from `src/index.ts`.
 */
export function allowlistPathsMatch(a: string, b: string): boolean {
  const na = posixNormPath(a);
  const nb = posixNormPath(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (!shorter.includes("/")) return false;
  if (!longer.endsWith("/" + shorter)) return false;
  return posixIsAbsolute(longer);
}

// ── Per-call backend escalation (F2c, v2.9.2) ───────────────

/**
 * The per-call backend directive's describe text, stated ONCE.
 *
 * Lifted verbatim from ollama_chat, which shipped the field first (v2.9)
 * and was for one release the ONLY tool of 44 that exposed it — the tool
 * whose own header calls itself a last resort. Every tool that can escalate
 * now shares this exact string: an egress contract stated a dozen ways
 * drifts on the first edit, and a caller must read identical refusal
 * semantics on whichever tool they happen to open first.
 */
export const BACKEND_DIRECTIVE_NOTE =
  "Optional per-call backend directive (v2.9). 'cloud' escalates THIS " +
  "call to Ollama Cloud — works in cloud standby (OLLAMA_API_KEY set, " +
  "OLLAMA_CLOUD_PRIMARY unset) and cloud-primary modes; errors with " +
  "CLOUD_NOT_CONFIGURED when no cloud is configured (never silently " +
  "runs local while claiming escalation). 'local' pins the call to " +
  "the local backend (zero egress) even under cloud-primary. Omit " +
  "for the mode default. Escalated calls disclose egress loudly and " +
  "carry backend provenance on the envelope.";

/**
 * One extra sentence for tools whose OUTPUT QUALITY is model-class
 * sensitive — the discovery path the surface lacked.
 *
 * The category prefix in a tool's description (FLAGSHIP / PACK / REFACTOR)
 * says what KIND of job it is and nothing about whether the model running
 * it is the binding constraint. `ollama_summarize_fast` and
 * `ollama_multi_file_refactor_propose` read identically on that axis while
 * being on opposite ends of it. Carrying this note is itself the signal:
 * the tools that omit it are the ones where a local 8B is genuinely
 * adequate, and saying so by omission is as useful as saying so in prose.
 */
export const MODEL_CLASS_ESCALATION_NOTE =
  " Synthesis quality on this tool scales sharply with model class — on a " +
  "repo-scale job the local 8B is often the binding constraint, not the " +
  "evidence. Tools where a local model is genuinely adequate " +
  "(ollama_summarize_fast, ollama_classify, ollama_triage_logs, and every " +
  "no-LLM tool) deliberately do NOT offer this field.";

/**
 * The shared `backend` schema fragment. Optional and absent-by-default:
 * omitting it is byte-identical to the pre-escalation behavior, and
 * local-first stays the trust property (cloudMayServe still refuses
 * without an explicit directive).
 */
export const backendField = z
  .enum(["cloud", "local"])
  .optional()
  .describe(BACKEND_DIRECTIVE_NOTE);

/** `backendField` plus the model-class signal, for sensitive tools. */
export const modelClassBackendField = z
  .enum(["cloud", "local"])
  .optional()
  .describe(BACKEND_DIRECTIVE_NOTE + MODEL_CLASS_ESCALATION_NOTE);

/**
 * Pack variant — a pack is a MIXED-COST pipeline, so its directive must say
 * which step it reaches.
 *
 * repo_pack is assemble_evidence (no model) → brief (deep synthesis, worth
 * a frontier model) → extract (workhorse structured fill, an 8B does it
 * fine) → artifact_write (no model). Applying one directive to the whole
 * pipeline would bill a flagship for the structured fill; applying it to
 * the synthesis step alone is the honest cost/benefit shape.
 */
export function packSynthesisBackendField(opts: {
  /** The escalated step, named as the caller sees it in `steps[]`. */
  synthesisStep: string;
  /** The steps that stay on the mode default, listed plainly. */
  localSteps: string;
}) {
  return z
    .enum(["cloud", "local"])
    .optional()
    .describe(
      BACKEND_DIRECTIVE_NOTE +
        MODEL_CLASS_ESCALATION_NOTE +
        ` SCOPE: this directive reaches ${opts.synthesisStep} ONLY — ${opts.localSteps} run on the mode default regardless. A pack is a mixed-cost pipeline; escalating all of it would bill a flagship for work a local model does fine.`,
    );
}

/**
 * The model-class coverage note, for a tool that came back `weak: true`.
 *
 * Every weak-path note in the product today diagnoses thin EVIDENCE ("the
 * evidence may not support an orientation brief yet"), which is a
 * plausible-but-unverified reading: a thin synthesis from adequate evidence
 * is exactly what a small local model produces on a repo-scale brief. This
 * names the other remedy alongside the evidence one.
 *
 * Returns null when the call was already served by cloud — a weak cloud
 * result must never suggest a path the caller already took — and null when
 * the result is not weak. The phrasing covers the no-cloud-configured case
 * too, so the advice never points at a knob that would refuse without
 * saying how to arm it.
 */
export function modelClassWeakNote(
  env: { backend?: "cloud" | "local"; model: string },
  weak: boolean,
): string | null {
  if (!weak || env.backend === "cloud") return null;
  return (
    `Model class: this was synthesized by the local model ${env.model || "(unknown)"}. ` +
    `If the evidence looks adequate, the thinness may be model class rather than coverage — ` +
    `re-run with backend:"cloud" to put the synthesis on an Ollama Cloud flagship ` +
    `(requires OLLAMA_API_KEY; escalated calls disclose egress on the envelope).`
  );
}

/**
 * Fail-fast mirror of the runner's CLOUD_NOT_CONFIGURED refusal, for
 * MULTI-STEP tools.
 *
 * An atom hits the runner's gate on its only model call, so the refusal is
 * already the first thing that happens. A pack is not: incident_pack runs a
 * triage call and change_pack a whole evidence assembly BEFORE the escalated
 * synthesis step, so without this the caller pays for two local steps and
 * then gets told cloud was never configured. Same code, same hint, same
 * non-retryable flag as runner.ts — an escalation that cannot be served
 * refuses loudly and never degrades into a silent local run.
 */
export function assertCloudEscalationConfigured(opts: {
  tool: string;
  backend?: "cloud" | "local";
  cloudConfigured: boolean;
}): void {
  if (opts.backend !== "cloud" || opts.cloudConfigured) return;
  throw new InternError(
    "CLOUD_NOT_CONFIGURED",
    `Tool ${opts.tool} requested backend:'cloud' but no Ollama Cloud is configured.`,
    "Set OLLAMA_API_KEY (create a key at https://ollama.com/settings/keys) to arm cloud standby — calls stay local unless they request backend:'cloud'. Optionally set OLLAMA_CLOUD_PRIMARY=1 for cloud-primary routing. This call was refused, not silently served by the local model.",
    false,
  );
}
