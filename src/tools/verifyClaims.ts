/**
 * ollama_verify_claims — F1. Cross-family flagship verification of claims.
 *
 * The strategic gap this fills: `ollama_code_review` GENERATES findings;
 * nothing ADJUDICATES them. This atom takes caller-supplied claims (review
 * findings, design assertions, "the fix handles X" statements) and runs a
 * panel of DISJOINT-FAMILY Ollama Cloud flagships to confirm/refute each,
 * riding F2's per-call cloud escalation with a per-juror model override.
 *
 * Research grounding (every design choice traces to a finding):
 *   - Cross-family panel, never the generator's family: LLM judges over-rate
 *     their own family mechanistically (Panickssery/Bowman/Feng 2024,
 *     arXiv:2404.13076; Wataoka 2024, arXiv:2410.21819).
 *   - 3-model PoLL jury beats one big judge at lower cost; diversity ceiling
 *     is ~2 effective votes, so never naive-majority (Verga 2024,
 *     arXiv:2404.18796; arXiv:2605.29800). Aggregation below is
 *     lone-dissent-never-decides: REFUTED needs ≥ min_refute_votes (2).
 *   - Generative verdicts (short rationale + enum) beat bare scoring by
 *     16–40% (Zhang 2024, arXiv:2408.15240).
 *   - Reference answers sharply raise verifier reliability — pass the
 *     caller's ground truth (test output, lint, measured facts) into the
 *     juror prompt (arXiv:2510.09738; MT-Bench arXiv:2306.05685).
 *   - Reasoning-stripped: jurors see claims + evidence, NEVER the
 *     generator's reasoning (CoT is post-hoc rationalization — Turpin 2023).
 *     The claim schema is strict() so a reasoning channel cannot exist.
 *   - Honest ceiling: verifier scale alone doesn't catch a strong
 *     generator's subtle errors (Ai 2025, arXiv:2509.17995). A CONFIRMED
 *     on Claude-authored claims is WEAK evidence, not proof; the panel is
 *     reliable at flagging gross errors and honest about the rest via
 *     `confidence` + the `weak` flag.
 *
 * This is a CLOUD tool: it refuses without a configured cloud (a local-8B
 * panel is too weak to adjudicate flagship-authored claims — documented
 * future extension, not silently substituted). Each juror call escalates
 * via `backend:'cloud'`; a juror served by local fallback, or whose served
 * model ≠ the requested juror (normalized: strip /[-:]cloud$/ — cloud tags
 * come in BOTH `:cloud` and `-cloud` forms), is EXCLUDED from the vote and
 * flagged. Shape discipline mirrors codeReview: zod schema + closed enums +
 * runTool + coerce-before-trust (malformed juror output is dropped, never
 * thrown).
 *
 * Registration note: this tool exports its handler + schema but does NOT
 * self-register; the server.tool block lives in src/index.ts.
 */

import { z } from "zod";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { TEMPERATURE_BY_SHAPE } from "../tiers.js";
import { runTool } from "./runner.js";
import { loadSources, formatSourcesBlock } from "../sources.js";
import { parseModelJsonObject, readObjectArray, readString } from "./briefs/common.js";
import { InternError } from "../errors.js";
import { OLLAMA_MODEL_NAME_RE } from "../profiles.js";
import type { RunContext } from "../runContext.js";

// ── Closed enums ────────────────────────────────────────────

const JUROR_VERDICTS = ["CONFIRMED", "REFUTED", "UNCERTAIN"] as const;
const AGGREGATE_VERDICTS = ["CONFIRMED", "REFUTED", "NEEDS_REVIEW"] as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;

export type JurorVerdict = (typeof JUROR_VERDICTS)[number];
export type AggregateVerdict = (typeof AGGREGATE_VERDICTS)[number];
export type VerifySeverity = (typeof SEVERITIES)[number];
export type VerifyConfidence = (typeof CONFIDENCES)[number];

/**
 * Default 3-model cross-family flagship panel (PoLL: 3, not 1, not 9).
 * Disjoint vendor families — DeepSeek / Moonshot / Z.ai — per the
 * cross-family doctrine: same-family judges over-rate mechanically.
 * Roster checked against ollama.com/search?c=cloud 2026-07-06; cloud ids
 * are VOLATILE (rotate/retire server-side) — when a juror 404s, re-check
 * the live roster and pass a current trio via `panel`. A retired juror
 * degrades visibly (excluded seat + degraded envelope), never silently.
 */
export const DEFAULT_VERIFY_PANEL: readonly string[] = [
  "deepseek-v4-pro:cloud",
  "kimi-k2.7-code:cloud",
  "glm-5.2:cloud",
];

/**
 * Confirms required for an aggregate CONFIRMED. Fixed at 2 (the PoLL
 * "two effective votes" ceiling): a single juror can never establish
 * CONFIRMED, even on a caller-shrunk panel — thin panels surface as
 * NEEDS_REVIEW + weak, not as false confidence.
 */
const CONFIRM_VOTES_REQUIRED = 2;

// ── Schema ──────────────────────────────────────────────────

/**
 * strictObject: unknown keys REJECT. Load-bearing for reasoning-stripped
 * verification — there is structurally no field through which the
 * generator's chain-of-thought can ride into a juror prompt.
 */
const claimSchema = z
  .strictObject({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe("Caller-assigned claim id. Aggregate verdicts key on it; must be unique."),
    statement: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe(
        "The claim to adjudicate, stated as a single falsifiable assertion. " +
          "Do NOT include the reasoning that produced it — jurors must judge " +
          "the claim against evidence, not against the author's argument.",
      ),
  })
  .describe("One claim. Extra fields are rejected (reasoning-stripped by construction).");

export const verifyClaimsSchema = z.object({
  claims: z
    .array(claimSchema)
    .min(1)
    .max(20)
    .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, {
      message: "claim ids must be unique",
    })
    .describe("Claims to verify (1–20). Each gets an independent aggregate verdict."),
  source_paths: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe(
      "Optional file paths loaded server-side as shared evidence for the " +
        "panel (the code the claims are about). Max 50 paths.",
    ),
  reference: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .optional()
    .describe(
      "Optional ground truth the panel weighs above its own priors: test " +
        "runner output, lint results, measured numbers, corpus facts. " +
        "Reference answers sharply raise verifier reliability — supply one " +
        "whenever you have it.",
    ),
  panel: z
    .array(z.string().trim().min(1).max(128))
    .min(1)
    .max(5)
    .refine((models) => models.every((m) => OLLAMA_MODEL_NAME_RE.test(m)), {
      message: "panel entries must be valid Ollama model ids",
    })
    .optional()
    .describe(
      "Optional juror override — Ollama Cloud model ids (1–5). Default is a " +
        "3-model disjoint-family flagship trio; keep families disjoint from " +
        "the claim author or the panel inherits its bias. Cloud ids rotate " +
        "server-side — check ollama.com/search?c=cloud when a juror 404s.",
    ),
  min_refute_votes: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .optional()
    .describe(
      "Refute votes required to mark a claim REFUTED (default 2 — a lone " +
        "dissent never decides). Raise to 3+ for higher-stakes kills; 1 only " +
        "with a single-juror panel you already trust.",
    ),
});

export type VerifyClaimsInput = z.infer<typeof verifyClaimsSchema>;

// ── Result shape ────────────────────────────────────────────

export interface ClaimJurorVote {
  /** Requested juror model id (as configured, e.g. deepseek-v4-pro:cloud). */
  model: string;
  verdict: JurorVerdict;
  severity: VerifySeverity;
  rationale: string;
}

export interface ClaimAggregate {
  id: string;
  statement: string;
  verdict: AggregateVerdict;
  /**
   * Agreement-based, per arXiv:2509.17995's honesty requirement: 'high' =
   * unanimous decisive votes from ≥2 jurors; 'medium' = decisive with
   * dissent (or a single-juror decision); 'low' = NEEDS_REVIEW. A 'high'
   * CONFIRMED on claims authored by a frontier model is still WEAK
   * evidence, not proof.
   */
  confidence: VerifyConfidence;
  refute_votes: number;
  confirm_votes: number;
  uncertain_votes: number;
  /** Included jurors' votes on THIS claim (excluded jurors never appear). */
  jurors: ClaimJurorVote[];
}

export interface PanelSeat {
  /** Requested juror model id. */
  model: string;
  /** Model the backend reported serving, when the call produced a response. */
  served_model?: string;
  /** True when this juror's votes counted toward aggregates. */
  included: boolean;
  /**
   * Why the seat was excluded: `call_failed:<code>` | `local_fallback:<reason>`
   * | `served_model_mismatch:<served>` | `no_valid_verdicts`.
   */
  exclude_reason?: string;
  /**
   * Bounded head-sample (≤ RAW_SAMPLE_MAX_CHARS) of the raw juror reply,
   * present ONLY on `no_valid_verdicts` exclusions — enough to tell
   * "returned prose" from "wrong schema" from "empty verdicts array"
   * without a re-run. Never on included seats, and never the full reply
   * (a juror reply echoes the caller's claims/evidence, which must not
   * bloat the envelope or the NDJSON log).
   */
  raw_sample?: string;
  /** Valid verdict entries that survived coercion (0 for excluded seats). */
  verdicts_returned: number;
}

export interface VerifyClaimsResult {
  claims: ClaimAggregate[];
  panel: PanelSeat[];
  /** One-line operator triage: counts + how much of the panel actually served. */
  summary: string;
  min_refute_votes: number;
  /**
   * True when fewer than 2 jurors were cloud-served — the aggregates below
   * cannot reach CONFIRMED and any REFUTED rests on a thin panel. Treat
   * every verdict as NEEDS_REVIEW-grade evidence.
   */
  weak: boolean;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Normalize a model id for the served-vs-requested comparison. Cloud tags
 * come in BOTH forms — `glm-5.2:cloud` AND `qwen3-coder:480b-cloud` — and
 * the served echo strips whichever suffix was used, so strip /[-:]cloud$/
 * from both sides (the two-tag-form rule; stripping only one form
 * false-flags every model of the other form as a local fallback).
 */
function normModel(model: string): string {
  return model.trim().toLowerCase().replace(/[-:]cloud$/, "");
}

interface JurorVote {
  id: string;
  verdict: JurorVerdict;
  severity: VerifySeverity;
  rationale: string;
}

// Fence-tolerant parsing lives in briefs/common.ts as parseModelJsonObject
// (Phase 3b Slice A promoted it from the local parseJurorJson this file
// carried — the live glm/kimi fence defect is surface-wide, not F1's alone).

/**
 * Cap for PanelSeat.raw_sample, in characters. Large enough to distinguish
 * prose / wrong-schema / empty-array replies, small enough that even a
 * 5-seat panel of failures adds under 1 KB to the envelope and log line.
 */
const RAW_SAMPLE_MAX_CHARS = 200;

function boundRawSample(raw: string): string {
  return raw.trim().slice(0, RAW_SAMPLE_MAX_CHARS);
}

function isJurorVerdict(v: unknown): v is JurorVerdict {
  return typeof v === "string" && (JUROR_VERDICTS as readonly string[]).includes(v);
}

function isSeverity(v: unknown): v is VerifySeverity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

/**
 * Coerce one juror's raw output into votes. Drop rules (never throw):
 *   - id must be a known claim id (unknown/missing → drop)
 *   - verdict must be in the closed enum (else drop)
 *   - rationale must be non-empty (the prompt says so — else drop)
 *   - severity is ADVISORY metadata: invalid/missing coerces to 'medium'
 *     instead of dropping (unlike codeReview's drop rule — discarding a
 *     juror's whole VOTE over a severity typo would silently shrink the
 *     panel, which is worse than an imprecise severity)
 *   - duplicate ids from one juror: first vote wins
 */
function coerceJurorVerdicts(data: Record<string, unknown>, validIds: Set<string>): JurorVote[] {
  const out: JurorVote[] = [];
  const seen = new Set<string>();
  for (const entry of readObjectArray(data, "verdicts")) {
    const id = readString(entry, "id").trim();
    if (!validIds.has(id) || seen.has(id)) continue;
    if (!isJurorVerdict(entry.verdict)) continue;
    const rationale = readString(entry, "rationale").trim();
    if (rationale.length === 0) continue;
    const severity: VerifySeverity = isSeverity(entry.severity) ? entry.severity : "medium";
    seen.add(id);
    out.push({ id, verdict: entry.verdict, severity, rationale });
  }
  return out;
}

/** Aggregate one claim over the included jurors — lone-dissent-never-decides. */
function aggregateClaim(
  claim: { id: string; statement: string },
  included: Array<{ model: string; votes: JurorVote[] }>,
  minRefuteVotes: number,
): ClaimAggregate {
  const jurors: ClaimJurorVote[] = [];
  for (const seat of included) {
    const vote = seat.votes.find((v) => v.id === claim.id);
    if (vote) {
      jurors.push({
        model: seat.model,
        verdict: vote.verdict,
        severity: vote.severity,
        rationale: vote.rationale,
      });
    }
  }
  const refute_votes = jurors.filter((j) => j.verdict === "REFUTED").length;
  const confirm_votes = jurors.filter((j) => j.verdict === "CONFIRMED").length;
  const uncertain_votes = jurors.filter((j) => j.verdict === "UNCERTAIN").length;

  let verdict: AggregateVerdict;
  if (refute_votes >= minRefuteVotes) verdict = "REFUTED";
  else if (confirm_votes >= CONFIRM_VOTES_REQUIRED) verdict = "CONFIRMED";
  else verdict = "NEEDS_REVIEW";

  let confidence: VerifyConfidence;
  if (verdict === "NEEDS_REVIEW") {
    confidence = "low";
  } else {
    const supporting = verdict === "REFUTED" ? refute_votes : confirm_votes;
    // 'high' needs unanimity AND ≥2 votes — a solo juror can never mint
    // high confidence, however emphatic.
    confidence = supporting === jurors.length && jurors.length >= 2 ? "high" : "medium";
  }

  return {
    id: claim.id,
    statement: claim.statement,
    verdict,
    confidence,
    refute_votes,
    confirm_votes,
    uncertain_votes,
    jurors,
  };
}

// ── Prompt builder ──────────────────────────────────────────

/**
 * One prompt, identical for every juror (independence comes from family
 * diversity, not prompt variation). Contains claims + evidence + reference
 * ONLY — never the claim author's reasoning (the input schema makes that
 * structurally impossible). Encodes the refute-discipline symmetrically:
 * hunt for counter-evidence, but a genuinely supported claim MUST be
 * CONFIRMED (an all-refute-biased jury that can't confirm is useless —
 * the 2026-07 jury lesson).
 */
function buildJurorPrompt(args: {
  claims: Array<{ id: string; statement: string }>;
  sourceBody: string;
  reference?: string;
}): string {
  const lines: string[] = [];
  lines.push(
    "You are an independent verification JUROR on a cross-family panel. Adjudicate each claim below strictly against the evidence provided.",
    "",
    "Verdict semantics:",
    "- CONFIRMED: the evidence affirmatively supports the claim.",
    "- REFUTED: the evidence contradicts the claim — name the contradicting evidence in your rationale.",
    "- UNCERTAIN: the evidence is insufficient to decide either way.",
    "",
    "Discipline:",
    "- Judge ONLY against the evidence below plus well-established technical knowledge. Never assume unstated intentions.",
    "- Actively look for counter-evidence before confirming — do not rubber-stamp.",
    "- A claim the evidence genuinely supports MUST be CONFIRMED — do not manufacture doubt to appear rigorous.",
    "- A claim too vague to falsify is UNCERTAIN, not CONFIRMED.",
    "",
  );
  if (args.reference !== undefined) {
    lines.push(
      "Reference (ground truth supplied by the caller — test output, lint results, measured facts). Weigh it above your own priors:",
      args.reference,
      "",
    );
  }
  if (args.sourceBody.length > 0) {
    lines.push("Source files (evidence):", args.sourceBody, "");
  }
  lines.push(
    "Claims to adjudicate:",
    JSON.stringify(
      args.claims.map((c) => ({ id: c.id, statement: c.statement })),
      null,
      2,
    ),
    "",
    "Return JSON matching this shape EXACTLY:",
    `{`,
    `  "verdicts": [`,
    `    {`,
    `      "id": "<claim id from the list above>",`,
    `      "verdict": "CONFIRMED" | "REFUTED" | "UNCERTAIN",`,
    `      "severity": "critical" | "high" | "medium" | "low",`,
    `      "rationale": "<1-3 sentences: WHY, citing the specific evidence>"`,
    `    }`,
    `  ]`,
    `}`,
    "",
    "Rules:",
    "- Exactly one verdict per claim id; only ids from the list above.",
    "- severity = how much it matters if the claim is wrong (REFUTED/UNCERTAIN) or how load-bearing the confirmation is (CONFIRMED).",
    "- rationale is mandatory — a verdict without one is dropped server-side.",
  );
  return lines.join("\n");
}

// ── Handler ─────────────────────────────────────────────────

export async function handleVerifyClaims(
  input: VerifyClaimsInput,
  ctx: RunContext,
): Promise<Envelope<VerifyClaimsResult>> {
  const startedAt = Date.now();

  // Cloud-required gate: adjudication runs on flagship-class models only.
  // Refuse clearly + disclose what WOULD leave the machine, rather than
  // silently substituting a local 8B panel that is too weak to catch a
  // strong generator's errors (arXiv:2509.17995). A local-panel opt-in is
  // a documented future extension, not a silent fallback.
  if (!ctx.cloud) {
    throw new InternError(
      "CLOUD_NOT_CONFIGURED",
      "ollama_verify_claims requires Ollama Cloud — it adjudicates claims with a cross-family flagship panel, which no local model can stand in for.",
      "Set OLLAMA_API_KEY (create a key at https://ollama.com/settings/keys) to arm cloud standby; only this tool's juror calls will egress, and each envelope carries backend provenance. The claims and any source_paths/reference you pass WILL be sent to Ollama Cloud when configured.",
      false,
    );
  }

  const minRefuteVotes = input.min_refute_votes ?? 2;
  const panel = [...(input.panel ?? DEFAULT_VERIFY_PANEL)];
  const validIds = new Set(input.claims.map((c) => c.id));

  // Shared evidence, loaded once — every juror sees the identical prompt.
  let sourceBody = "";
  if (input.source_paths && input.source_paths.length > 0) {
    const sources = await loadSources(input.source_paths, 60_000);
    sourceBody = formatSourcesBlock(sources);
  }
  const prompt = buildJurorPrompt({
    claims: input.claims,
    sourceBody,
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
  });

  // One escalated call per juror, concurrently (the global semaphore
  // paces the wire). allowFallback:false — a tier cascade would re-run on
  // a cheaper tier WITHOUT the juror's model override, silently changing
  // the panel's composition; a juror that can't answer in the deep budget
  // is excluded instead.
  interface JurorRun {
    model: string;
    env?: Envelope<JurorVote[]>;
    error?: unknown;
    /** Bounded sample of the raw reply when its parse yielded 0 valid verdicts. */
    rawSample?: string;
  }
  const runs: JurorRun[] = await Promise.all(
    panel.map(async (jurorModel): Promise<JurorRun> => {
      // A1 observability: when a juror's reply coerces to ZERO valid
      // verdicts, keep a bounded sample of what it actually said — the
      // v2.9.0 dogfood diagnosed exactly this exclusion only via a 4-call
      // side probe because the envelope carried no evidence. Captured at
      // the parse boundary (the only place the raw text exists).
      let rawSample: string | undefined;
      try {
        const env = await runTool<JurorVote[]>({
          tool: "ollama_verify_claims.juror",
          tier: "deep",
          ctx,
          allowFallback: false,
          backend: "cloud",
          modelOverride: jurorModel,
          // Flagship jurors are thinking models; CoT lands in the separate
          // `thinking` field while `response` stays JSON.
          think: true,
          build: (_tier, model) => ({
            model,
            prompt,
            format: "json",
            options: {
              // Adjudication wants judgment stability, not breadth — the
              // cool structured-output floor, same rationale as triage.
              temperature: TEMPERATURE_BY_SHAPE.triage,
              // 20 claims × ~80 tokens/verdict + margin.
              num_predict: 3000,
            },
          }),
          parse: (raw) => {
            const verdicts = coerceJurorVerdicts(parseModelJsonObject(raw), validIds);
            if (verdicts.length === 0) rawSample = boundRawSample(raw);
            return verdicts;
          },
        });
        return { model: jurorModel, env, ...(rawSample !== undefined ? { rawSample } : {}) };
      } catch (error) {
        return { model: jurorModel, error };
      }
    }),
  );

  // Seat classification — the served-model check. A juror only counts when
  // (1) the envelope says cloud served it AND (2) the served-model echo
  // matches the requested juror after /[-:]cloud$/ normalization. A local
  // fallback or a substituted model defeats the cross-family design, so
  // those votes are discarded, visibly.
  const seats: PanelSeat[] = [];
  const included: Array<{ model: string; votes: JurorVote[] }> = [];
  let tokensIn = 0;
  let tokensOut = 0;
  for (const run of runs) {
    if (!run.env) {
      const code = run.error instanceof InternError ? run.error.code : "ERROR";
      seats.push({
        model: run.model,
        included: false,
        exclude_reason: `call_failed:${code}`,
        verdicts_returned: 0,
      });
      continue;
    }
    const env = run.env;
    tokensIn += env.tokens_in;
    tokensOut += env.tokens_out;
    if (env.backend !== "cloud") {
      seats.push({
        model: run.model,
        served_model: env.model,
        included: false,
        exclude_reason: `local_fallback:${env.degrade_reason ?? "not_cloud"}`,
        verdicts_returned: 0,
      });
      continue;
    }
    if (normModel(env.model) !== normModel(run.model)) {
      seats.push({
        model: run.model,
        served_model: env.model,
        included: false,
        exclude_reason: `served_model_mismatch:${env.model}`,
        verdicts_returned: 0,
      });
      continue;
    }
    if (env.result.length === 0) {
      seats.push({
        model: run.model,
        served_model: env.model,
        included: false,
        exclude_reason: "no_valid_verdicts",
        // Truthy check: an all-whitespace reply trims to "" — omit rather
        // than attach an empty sample.
        ...(run.rawSample ? { raw_sample: run.rawSample } : {}),
        verdicts_returned: 0,
      });
      continue;
    }
    seats.push({
      model: run.model,
      served_model: env.model,
      included: true,
      verdicts_returned: env.result.length,
    });
    included.push({ model: run.model, votes: env.result });
  }

  const claims = input.claims.map((c) => aggregateClaim(c, included, minRefuteVotes));

  const includedCount = included.length;
  const weak = includedCount < 2;
  const confirmed = claims.filter((c) => c.verdict === "CONFIRMED").length;
  const refuted = claims.filter((c) => c.verdict === "REFUTED").length;
  const needsReview = claims.filter((c) => c.verdict === "NEEDS_REVIEW").length;
  const summary =
    `${confirmed} confirmed, ${refuted} refuted, ${needsReview} needs review across ${claims.length} claim(s); ` +
    `panel ${includedCount}/${seats.length} cloud-served` +
    (weak ? " — WEAK: fewer than 2 jurors served; treat every verdict as needs-review-grade" : "");

  const result: VerifyClaimsResult = {
    claims,
    panel: seats,
    summary,
    min_refute_votes: minRefuteVotes,
    weak,
  };

  const excludedCount = seats.length - includedCount;
  const warnings = seats
    .filter((s) => !s.included)
    .map((s) => `juror ${s.model} excluded: ${s.exclude_reason}`);

  const envelope = buildEnvelope<VerifyClaimsResult>({
    result,
    tier: "deep",
    // The "model" for this aggregate envelope is the requested panel —
    // per-juror served models live in result.panel.
    model: panel.join(","),
    hardwareProfile: ctx.hardwareProfile,
    tokensIn,
    tokensOut,
    startedAt,
    residency: null, // cloud adjudication — local VRAM residency does not apply
    backend: includedCount > 0 ? "cloud" : "local",
    ...(excludedCount > 0
      ? { degraded: true, degradeReason: `jury_excluded:${excludedCount}/${seats.length}` }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  });

  await ctx.logger.log(callEvent("ollama_verify_claims", envelope));
  return envelope;
}

// Internal exports for tests — coercion/aggregation contracts are pinned
// without round-tripping through a model.
export const __internal = {
  normModel,
  coerceJurorVerdicts,
  aggregateClaim,
  buildJurorPrompt,
  CONFIRM_VOTES_REQUIRED,
};
