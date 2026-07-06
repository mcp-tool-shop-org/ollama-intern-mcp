/**
 * ollama_verify_claims — cross-family flagship verification atom (F1).
 *
 * The tool adjudicates caller-supplied claims with a panel of DISJOINT-family
 * Ollama Cloud flagships (default deepseek / kimi / glm — PoLL jury,
 * arXiv:2404.18796) riding F2's per-call cloud escalation. This file pins the
 * kickoff invariants:
 *
 *   (a) N claims → N aggregate verdicts, each with a per-juror breakdown
 *   (b) lone-dissent-never-decides: REFUTED needs ≥ min_refute_votes (2);
 *       CONFIRMED needs ≥ 2 confirms; else NEEDS_REVIEW
 *   (c) a juror whose call was served local (fallback) or whose served model
 *       ≠ requested (normalized /[-:]cloud$/) is EXCLUDED from the vote,
 *       flagged, never counted
 *   (d) no cloud configured → CLOUD_NOT_CONFIGURED refusal, zero wire calls
 *   (e) malformed juror output is dropped (whole-output AND per-entry),
 *       never throws
 *   (f) the juror prompt carries claims + sources + reference ONLY — the
 *       claim schema is .strict() so a `reasoning` field is structurally
 *       rejected (reasoning-stripped verification, arXiv:2404.13076)
 *
 * Network-free: real RoutingOllamaClient in standby over fake cloud/local
 * clients, so the served-model / backend evidence channel is the real one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleVerifyClaims,
  verifyClaimsSchema,
  DEFAULT_VERIFY_PANEL,
  __internal,
} from "../../src/tools/verifyClaims.js";
import { RoutingOllamaClient } from "../../src/routing.js";
import { loadCloudConfig, PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
import { InternError } from "../../src/errors.js";
import { createFakeOllama, makeFakeCtx } from "../_helpers/index.js";
import type { RunContext } from "../../src/runContext.js";
import type { GenerateRequest } from "../../src/ollama.js";

const KEY_ENV = { OLLAMA_API_KEY: "sk-test-verify" };
const LOCAL_TIERS = PROFILES["dev-rtx5080"].tiers;

const [DEEPSEEK, KIMI, GLM] = DEFAULT_VERIFY_PANEL;

/** Live-cloud-like served-model echo: strip the trailing -cloud / :cloud tag. */
function servedEcho(requested: string): string {
  return requested.replace(/[-:]cloud$/i, "");
}

type VerdictEntry = {
  id: string;
  verdict?: string;
  severity?: string;
  rationale?: string;
} & Record<string, unknown>;

/** Juror JSON body with per-entry defaults so tests stay terse. */
function jurorJson(entries: VerdictEntry[]): string {
  return JSON.stringify({
    verdicts: entries.map((e) => ({ verdict: "CONFIRMED", severity: "medium", rationale: "because evidence", ...e })),
  });
}

interface VerifyHarness {
  ctx: RunContext & { logger: NullLogger };
  cloud: ReturnType<typeof createFakeOllama>;
  local: ReturnType<typeof createFakeOllama>;
  prompts: Map<string, string>;
}

/**
 * Standby cloud ctx whose fake cloud answers per-juror from `script`
 * (requested model id → JSON body | thrown error). Unscripted models get
 * a confirm-everything default built from `claimIds`.
 */
function makeVerifyCtx(opts: {
  claimIds: string[];
  script?: Record<string, string | Error>;
  localResponse?: string;
}): VerifyHarness {
  const cfg = loadCloudConfig({ ...KEY_ENV })!;
  const prompts = new Map<string, string>();
  const cloud = createFakeOllama({
    errorOnUnused: false,
    generateImpl: async (req: GenerateRequest) => {
      prompts.set(req.model, req.prompt);
      const scripted = opts.script?.[req.model];
      if (scripted instanceof Error) throw scripted;
      const body = scripted ?? jurorJson(opts.claimIds.map((id) => ({ id })));
      return {
        model: servedEcho(req.model),
        response: body,
        done: true,
        prompt_eval_count: 100,
        eval_count: 50,
      };
    },
  });
  const local = createFakeOllama({
    errorOnUnused: false,
    defaultGenerateResponse:
      opts.localResponse ?? jurorJson(opts.claimIds.map((id) => ({ id, verdict: "REFUTED" }))),
  });
  const routing = new RoutingOllamaClient({
    cloud,
    local,
    cloudTiers: cfg.tiers,
    localTiers: LOCAL_TIERS,
    cloudTimeouts: cfg.timeouts,
    cloudNumCtx: cfg.numCtx,
    logger: new NullLogger(),
    standby: cfg.standby,
    cloudHost: cfg.host,
  });
  const ctx = makeFakeCtx({ client: routing });
  ctx.cloud = cfg;
  return { ctx, cloud, local, prompts };
}

function transient(status: number): InternError {
  return new InternError("OLLAMA_UNREACHABLE", `Ollama returned ${status}: boom`, "hint", true);
}

const CLAIMS_2 = [
  { id: "c1", statement: "The runner refuses backend:'cloud' when no cloud is configured." },
  { id: "c2", statement: "Standby mode performs zero egress without a directive." },
];

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("verify_claims — module surface", () => {
  it("exports handler, schema, and the default disjoint-family panel", () => {
    expect(typeof handleVerifyClaims).toBe("function");
    expect(verifyClaimsSchema).toBeDefined();
    expect(DEFAULT_VERIFY_PANEL.length).toBe(3);
    // Disjoint families — no two jurors share a vendor prefix.
    const families = DEFAULT_VERIFY_PANEL.map((m) => m.split(/[-:]/)[0]);
    expect(new Set(families).size).toBe(3);
  });
});

describe("verify_claims — happy path (invariant a)", () => {
  it("N claims → N aggregates with per-juror breakdowns; unanimous confirms → CONFIRMED/high", async () => {
    const { ctx, cloud } = makeVerifyCtx({ claimIds: ["c1", "c2"] });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);

    expect(env.result.claims.length).toBe(2);
    for (const claim of env.result.claims) {
      expect(claim.verdict).toBe("CONFIRMED");
      expect(claim.confidence).toBe("high");
      expect(claim.confirm_votes).toBe(3);
      expect(claim.refute_votes).toBe(0);
      expect(claim.jurors.length).toBe(3);
      for (const j of claim.jurors) {
        expect(typeof j.rationale).toBe("string");
        expect(j.rationale.length).toBeGreaterThan(0);
      }
    }
    // Panel provenance: every juror included, served-model echo captured.
    expect(env.result.panel.length).toBe(3);
    for (const seat of env.result.panel) {
      expect(seat.included).toBe(true);
      expect(seat.served_model).toBe(servedEcho(seat.model));
    }
    expect(env.result.weak).toBe(false);
    expect(env.result.summary).toMatch(/2 confirmed/i);
    // Envelope provenance: cloud-served aggregate, one wire call per juror.
    expect(env.backend).toBe("cloud");
    expect(cloud.callCount.generate).toBe(3);
    expect(env.tokens_in).toBe(300); // 3 jurors × 100
    expect(env.tokens_out).toBe(150);
  });
});

describe("verify_claims — lone dissent never decides (invariant b)", () => {
  it("REFUTED needs ≥2 refutes; a single refute cannot kill a claim; mixed → NEEDS_REVIEW", async () => {
    const claims = [
      { id: "c1", statement: "claim one" },
      { id: "c2", statement: "claim two" },
      { id: "c3", statement: "claim three" },
    ];
    const { ctx } = makeVerifyCtx({
      claimIds: ["c1", "c2", "c3"],
      script: {
        [DEEPSEEK]: jurorJson([
          { id: "c1", verdict: "REFUTED" },
          { id: "c2", verdict: "REFUTED" },
          { id: "c3", verdict: "REFUTED" },
        ]),
        [KIMI]: jurorJson([
          { id: "c1", verdict: "REFUTED" },
          { id: "c2", verdict: "CONFIRMED" },
          { id: "c3", verdict: "CONFIRMED" },
        ]),
        [GLM]: jurorJson([
          { id: "c1", verdict: "CONFIRMED" },
          { id: "c2", verdict: "CONFIRMED" },
          { id: "c3", verdict: "UNCERTAIN" },
        ]),
      },
    });
    const env = await handleVerifyClaims({ claims }, ctx);
    const byId = Object.fromEntries(env.result.claims.map((c) => [c.id, c]));

    // c1: 2 refutes + 1 confirm → REFUTED (dissent present → medium).
    expect(byId.c1.verdict).toBe("REFUTED");
    expect(byId.c1.refute_votes).toBe(2);
    expect(byId.c1.confidence).toBe("medium");
    // c2: 1 refute + 2 confirms → the lone refute does NOT decide → CONFIRMED.
    expect(byId.c2.verdict).toBe("CONFIRMED");
    expect(byId.c2.confirm_votes).toBe(2);
    expect(byId.c2.confidence).toBe("medium");
    // c3: 1 refute + 1 confirm + 1 uncertain → nothing reaches threshold.
    expect(byId.c3.verdict).toBe("NEEDS_REVIEW");
    expect(byId.c3.confidence).toBe("low");
  });

  it("min_refute_votes:3 raises the kill bar — 2 refutes no longer refute", async () => {
    const claims = [{ id: "c1", statement: "contested claim" }];
    const { ctx } = makeVerifyCtx({
      claimIds: ["c1"],
      script: {
        [DEEPSEEK]: jurorJson([{ id: "c1", verdict: "REFUTED" }]),
        [KIMI]: jurorJson([{ id: "c1", verdict: "REFUTED" }]),
        [GLM]: jurorJson([{ id: "c1", verdict: "CONFIRMED" }]),
      },
    });
    const env = await handleVerifyClaims({ claims, min_refute_votes: 3 }, ctx);
    expect(env.result.claims[0].verdict).toBe("NEEDS_REVIEW"); // 2 < 3 refutes, 1 < 2 confirms
  });
});

describe("verify_claims — served-model / fallback exclusion (invariant c)", () => {
  it("a juror whose served model ≠ requested is excluded and its vote never counts", async () => {
    // The GLM seat answers, but the backend reports a DIFFERENT served model
    // — and that impostor REFUTES everything. It must be excluded, not
    // counted. Custom fake: the served-model echo mismatches for GLM only.
    const cfg = loadCloudConfig({ ...KEY_ENV })!;
    const cloud = createFakeOllama({
      errorOnUnused: false,
      generateImpl: async (req: GenerateRequest) => ({
        model: req.model === GLM ? "hermes3:8b" : servedEcho(req.model),
        response:
          req.model === GLM
            ? jurorJson([
                { id: "c1", verdict: "REFUTED" },
                { id: "c2", verdict: "REFUTED" },
              ])
            : jurorJson([{ id: "c1" }, { id: "c2" }]),
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    });
    const local = createFakeOllama({ errorOnUnused: false, defaultGenerateResponse: "{}" });
    const routing = new RoutingOllamaClient({
      cloud,
      local,
      cloudTiers: cfg.tiers,
      localTiers: LOCAL_TIERS,
      cloudTimeouts: cfg.timeouts,
      cloudNumCtx: cfg.numCtx,
      logger: new NullLogger(),
      standby: cfg.standby,
      cloudHost: cfg.host,
    });
    const freshCtx = makeFakeCtx({ client: routing });
    freshCtx.cloud = cfg;

    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, freshCtx);
    const glmSeat = env.result.panel.find((p) => p.model === GLM)!;
    expect(glmSeat.included).toBe(false);
    expect(glmSeat.exclude_reason).toMatch(/served_model_mismatch/);
    // The impostor's refutes were discarded — remaining 2 confirms carry it.
    const byId = Object.fromEntries(env.result.claims.map((c) => [c.id, c]));
    expect(byId.c1.verdict).toBe("CONFIRMED");
    expect(byId.c1.refute_votes).toBe(0);
    expect(byId.c1.jurors.length).toBe(2);
  });

  it("a juror served by LOCAL fallback (cloud 5xx) is excluded and flagged, never counted", async () => {
    const { ctx, local } = makeVerifyCtx({
      claimIds: ["c1", "c2"],
      script: { [KIMI]: transient(503) },
      // The local fallback REFUTES everything — if exclusion regresses,
      // c1/c2 would flip verdicts.
      localResponse: jurorJson([
        { id: "c1", verdict: "REFUTED" },
        { id: "c2", verdict: "REFUTED" },
      ]),
    });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    const kimiSeat = env.result.panel.find((p) => p.model === KIMI)!;
    expect(kimiSeat.included).toBe(false);
    expect(kimiSeat.exclude_reason).toMatch(/local_fallback:cloud_5xx/);
    expect(local.callCount.generate).toBeGreaterThan(0); // the fallback DID run…
    const byId = Object.fromEntries(env.result.claims.map((c) => [c.id, c]));
    expect(byId.c1.verdict).toBe("CONFIRMED"); // …but its votes never counted
    expect(byId.c1.refute_votes).toBe(0);
    // Envelope is honest that the panel degraded.
    expect(env.degraded).toBe(true);
  });
});

describe("verify_claims — no cloud configured (invariant d)", () => {
  it("refuses with CLOUD_NOT_CONFIGURED before any wire call", async () => {
    const client = createFakeOllama({ errorOnUnused: false, defaultGenerateResponse: "{}" });
    const ctx = makeFakeCtx({ client });
    let caught: unknown;
    try {
      await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect((caught as InternError).code).toBe("CLOUD_NOT_CONFIGURED");
    expect((caught as InternError).hint).toMatch(/OLLAMA_API_KEY/);
    expect(client.callCount.generate).toBe(0);
  });
});

describe("verify_claims — malformed juror output (invariant e)", () => {
  it("a juror returning non-JSON is excluded (no_valid_verdicts) and never throws", async () => {
    const { ctx } = makeVerifyCtx({
      claimIds: ["c1", "c2"],
      script: { [DEEPSEEK]: "％％ not json at all ％％" },
    });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    const seat = env.result.panel.find((p) => p.model === DEEPSEEK)!;
    expect(seat.included).toBe(false);
    expect(seat.exclude_reason).toBe("no_valid_verdicts");
    // Remaining two jurors still decide.
    expect(env.result.claims[0].verdict).toBe("CONFIRMED");
    expect(env.result.claims[0].jurors.length).toBe(2);
    expect(env.result.weak).toBe(false); // 2 jurors is still a quorum
  });

  it("juror JSON wrapped in markdown fences is parsed, not discarded (glm-5.2 / kimi-k2.7 cloud shape, observed live 2026-07-06)", async () => {
    // Live finding from the first dogfood jury: glm-5.2 (both think modes)
    // and kimi-k2.7 (think:false) fence their JSON even with format:"json"
    // — Ollama Cloud doesn't grammar-enforce those models the way it does
    // deepseek. The verdicts were valid; only the parse discarded them.
    const fenced = "```json\n" + jurorJson([{ id: "c1" }, { id: "c2" }]) + "\n```";
    const { ctx } = makeVerifyCtx({ claimIds: ["c1", "c2"], script: { [GLM]: fenced } });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    const seat = env.result.panel.find((p) => p.model === GLM)!;
    expect(seat.included).toBe(true);
    expect(seat.verdicts_returned).toBe(2);
    // All three jurors count again — unanimous 3-confirm, high confidence.
    expect(env.result.claims[0].confirm_votes).toBe(3);
    expect(env.result.claims[0].confidence).toBe("high");
  });

  it("a bare-fence wrap (no json language tag) also parses", async () => {
    const fenced = "```\n" + jurorJson([{ id: "c1" }, { id: "c2" }]) + "\n```";
    const { ctx } = makeVerifyCtx({ claimIds: ["c1", "c2"], script: { [KIMI]: fenced } });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    expect(env.result.panel.find((p) => p.model === KIMI)!.included).toBe(true);
  });

  it("malformed ENTRIES are dropped per-entry: unknown id, bad verdict, missing rationale", async () => {
    const { ctx } = makeVerifyCtx({
      claimIds: ["c1", "c2"],
      script: {
        [GLM]: JSON.stringify({
          verdicts: [
            { id: "zz", verdict: "CONFIRMED", severity: "low", rationale: "unknown id → dropped" },
            { id: "c1", verdict: "MAYBE", severity: "low", rationale: "bad enum → dropped" },
            { id: "c1", verdict: "REFUTED", severity: "high" }, // no rationale → dropped
            { id: "c2", verdict: "REFUTED", severity: "bogus", rationale: "severity coerced, vote kept" },
            null,
            "garbage",
          ],
        }),
      },
    });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    const seat = env.result.panel.find((p) => p.model === GLM)!;
    expect(seat.included).toBe(true);
    expect(seat.verdicts_returned).toBe(1); // only the c2 REFUTED survived
    const byId = Object.fromEntries(env.result.claims.map((c) => [c.id, c]));
    // c1: GLM's votes all dropped → 2 confirms from the other jurors.
    expect(byId.c1.confirm_votes).toBe(2);
    expect(byId.c1.refute_votes).toBe(0);
    // c2: GLM's surviving REFUTED counts (1) — lone dissent, still CONFIRMED.
    expect(byId.c2.refute_votes).toBe(1);
    expect(byId.c2.verdict).toBe("CONFIRMED");
    // Coerced severity landed in the closed enum.
    const glmVote = byId.c2.jurors.find((j) => j.model === GLM)!;
    expect(["critical", "high", "medium", "low"]).toContain(glmVote.severity);
  });
});

describe("verify_claims — juror raw_sample on no_valid_verdicts (A1 observability)", () => {
  it("a no_valid_verdicts seat carries a bounded, non-empty raw_sample; included seats never do", async () => {
    // Long prose reply (the live kimi/glm large-payload thinning shape) —
    // no JSON anywhere, well over the sample cap.
    const prose =
      "Looking at these claims, the cloud gate appears correct and the standby path seems fine to me. ".repeat(6);
    const { ctx } = makeVerifyCtx({
      claimIds: ["c1", "c2"],
      script: { [DEEPSEEK]: prose },
    });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    const seat = env.result.panel.find((p) => p.model === DEEPSEEK)!;
    expect(seat.included).toBe(false);
    expect(seat.exclude_reason).toBe("no_valid_verdicts");
    // The exclusion now carries evidence: a head sample of the raw reply…
    expect(seat.raw_sample).toBeDefined();
    expect(seat.raw_sample!.length).toBeGreaterThan(0);
    // …bounded at the cap — never the full response (it echoes the
    // caller's claims/evidence and must not bloat envelope or NDJSON log).
    expect(seat.raw_sample!.length).toBeLessThanOrEqual(200);
    expect(seat.raw_sample!.length).toBeLessThan(prose.length);
    expect(prose.startsWith(seat.raw_sample!)).toBe(true);
    // Included seats never carry a raw_sample.
    for (const s of env.result.panel.filter((p) => p.included)) {
      expect(s.raw_sample).toBeUndefined();
    }
  });

  it("valid JSON with an empty verdicts array is sampled too — 'empty array' is diagnosable", async () => {
    const emptyVerdicts = JSON.stringify({ verdicts: [] });
    const { ctx } = makeVerifyCtx({ claimIds: ["c1", "c2"], script: { [KIMI]: emptyVerdicts } });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    const seat = env.result.panel.find((p) => p.model === KIMI)!;
    expect(seat.exclude_reason).toBe("no_valid_verdicts");
    expect(seat.raw_sample).toBe(emptyVerdicts); // short reply → sampled whole
  });

  it("raw_sample never rides a non-no_valid_verdicts exclusion (local fallback returning prose)", async () => {
    const { ctx } = makeVerifyCtx({
      claimIds: ["c1", "c2"],
      script: { [GLM]: transient(503) },
      localResponse: "％％ prose from the local fallback ％％",
    });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    const seat = env.result.panel.find((p) => p.model === GLM)!;
    expect(seat.included).toBe(false);
    expect(seat.exclude_reason).toMatch(/local_fallback/);
    expect(seat.raw_sample).toBeUndefined();
  });
});

describe("verify_claims — reasoning-stripped juror prompts (invariant f)", () => {
  it("the claim schema is strict: a `reasoning` field is structurally rejected", () => {
    expect(() =>
      verifyClaimsSchema.parse({
        claims: [
          {
            id: "c1",
            statement: "some claim",
            reasoning: "here is my post-hoc rationalization the jury must never see",
          },
        ],
      }),
    ).toThrow();
  });

  it("the juror prompt carries statement + reference (ground truth) and is identical across jurors", async () => {
    const { ctx, prompts } = makeVerifyCtx({ claimIds: ["c1", "c2"] });
    await handleVerifyClaims(
      { claims: CLAIMS_2, reference: "vitest: 1101 passed (RUN-XYZ-REF)" },
      ctx,
    );
    expect(prompts.size).toBe(3);
    for (const [, prompt] of prompts) {
      expect(prompt).toContain(CLAIMS_2[0].statement);
      expect(prompt).toContain("RUN-XYZ-REF"); // the caller's reference reached the jury
    }
    // Reasoning-stripped symmetry: every juror sees the SAME prompt.
    const bodies = [...prompts.values()];
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("verify_claims — panel override + weak panel", () => {
  it("a caller panel replaces the default; single juror + min_refute_votes:1 can refute but the result is weak", async () => {
    const SOLO = "gpt-oss:120b-cloud";
    const { ctx, cloud } = makeVerifyCtx({
      claimIds: ["c1"],
      script: { [SOLO]: jurorJson([{ id: "c1", verdict: "REFUTED", severity: "high" }]) },
    });
    const env = await handleVerifyClaims(
      { claims: [{ id: "c1", statement: "solo claim" }], panel: [SOLO], min_refute_votes: 1 },
      ctx,
    );
    expect(cloud.callCount.generate).toBe(1); // only the solo juror ran
    expect(env.result.panel.length).toBe(1);
    expect(env.result.claims[0].verdict).toBe("REFUTED");
    expect(env.result.weak).toBe(true); // < 2 jurors served — flagged honestly
  });

  it("all jurors falling back to local → every claim NEEDS_REVIEW, weak, degraded envelope", async () => {
    const { ctx } = makeVerifyCtx({
      claimIds: ["c1", "c2"],
      script: {
        [DEEPSEEK]: transient(500),
        [KIMI]: transient(500),
        [GLM]: transient(500),
      },
    });
    const env = await handleVerifyClaims({ claims: CLAIMS_2 }, ctx);
    expect(env.result.weak).toBe(true);
    for (const claim of env.result.claims) {
      expect(claim.verdict).toBe("NEEDS_REVIEW");
      expect(claim.jurors.length).toBe(0);
    }
    for (const seat of env.result.panel) {
      expect(seat.included).toBe(false);
      expect(seat.exclude_reason).toMatch(/local_fallback/);
    }
    expect(env.degraded).toBe(true);
  });
});

describe("verify_claims — schema gates", () => {
  it("rejects empty claims, >20 claims, and duplicate ids", () => {
    expect(() => verifyClaimsSchema.parse({ claims: [] })).toThrow();
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, statement: "s" }));
    expect(() => verifyClaimsSchema.parse({ claims: many })).toThrow();
    expect(() =>
      verifyClaimsSchema.parse({
        claims: [
          { id: "dup", statement: "a" },
          { id: "dup", statement: "b" },
        ],
      }),
    ).toThrow();
  });

  it("rejects malformed panel model ids fail-fast", () => {
    expect(() =>
      verifyClaimsSchema.parse({
        claims: [{ id: "c1", statement: "s" }],
        panel: ["Bad Model Name!"],
      }),
    ).toThrow();
  });
});

describe("verify_claims — __internal units", () => {
  it("normModel strips both cloud tag forms and case", () => {
    expect(__internal.normModel("qwen3-coder:480b-cloud")).toBe("qwen3-coder:480b");
    expect(__internal.normModel("glm-5.2:cloud")).toBe("glm-5.2");
    expect(__internal.normModel("DeepSeek-V4-Pro")).toBe("deepseek-v4-pro");
    expect(__internal.normModel(" kimi-k2.7-code:cloud ")).toBe("kimi-k2.7-code");
  });
});
