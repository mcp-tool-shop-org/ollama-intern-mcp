/**
 * RoutingOllamaClient — cloud-STANDBY mode + per-call route directives (F2).
 *
 * F2a: with a key set but OLLAMA_CLOUD_PRIMARY unset, routing runs
 * LOCAL-PRIMARY — a normal call never touches cloud (zero egress), but the
 * cloud client stands by for per-call escalation.
 *
 * F2b: a per-call route directive (set by the runner via setRouteDirective,
 * carried on a non-enumerable Symbol so it can never serialize onto the
 * wire) escalates ONE call to cloud (`backend:'cloud'`), pins one call
 * local under cloud-primary (`backend:'local'`), and marks the request
 * model as an explicit caller override (`modelExplicit`) so the cloud
 * attempt honors it instead of clobbering it with the tier map — the
 * v2.3.0-override-dropped-on-cloud audit fix. First standby egress is
 * disclosed loudly (stderr + cloud_egress event), per the
 * disclose-at-the-point-of-egress finding (Homebrew #142 / GDPR Art. 25).
 *
 * Network-free: fake cloud/local clients; we assert routing PROVENANCE.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RoutingOllamaClient,
  CircuitBreaker,
  getRoutingInfo,
  setRouteDirective,
} from "../src/routing.js";
import { createFakeOllama } from "./_helpers/fakeOllama.js";
import { NullLogger } from "../src/observability.js";
import { InternError } from "../src/errors.js";
import type { Tier, TierConfig } from "../src/tiers.js";
import type { GenerateRequest } from "../src/ollama.js";

const CLOUD_TIERS: TierConfig = {
  instant: "qwen3-coder-next:cloud",
  workhorse: "qwen3-coder-next:cloud",
  deep: "deepseek-v4-pro:cloud",
  embed: "nomic-embed-text",
};
const LOCAL_TIERS: TierConfig = {
  instant: "hermes3:8b",
  workhorse: "hermes3:8b",
  deep: "hermes3:8b",
  embed: "nomic-embed-text",
};
const CLOUD_TIMEOUTS: Record<Tier, number> = {
  instant: 30_000,
  workhorse: 120_000,
  deep: 300_000,
  embed: 10_000,
};

function transient(status: number): InternError {
  return new InternError("OLLAMA_UNREACHABLE", `Ollama returned ${status}: boom`, "hint", true);
}
function modelMissing(): InternError {
  return new InternError("OLLAMA_MODEL_MISSING", "Model not found (404)", "hint", false);
}

interface Harness {
  routing: RoutingOllamaClient;
  cloud: ReturnType<typeof createFakeOllama>;
  local: ReturnType<typeof createFakeOllama>;
  logger: NullLogger;
}

function makeRouting(opts: {
  standby?: boolean;
  cloudGen?: (req: GenerateRequest, signal?: AbortSignal) => Promise<unknown>;
  breaker?: CircuitBreaker;
  standbyEscalateTiers?: Tier[];
}): Harness {
  const cloud = createFakeOllama({
    generateImpl: opts.cloudGen
      ? (async (req, signal) => opts.cloudGen!(req, signal) as never)
      : undefined,
    defaultGenerateResponse: "cloud-ok",
    errorOnUnused: false,
  });
  const local = createFakeOllama({ defaultGenerateResponse: "local-ok", errorOnUnused: false });
  const logger = new NullLogger();
  const routing = new RoutingOllamaClient({
    cloud,
    local,
    cloudTiers: CLOUD_TIERS,
    localTiers: LOCAL_TIERS,
    cloudTimeouts: CLOUD_TIMEOUTS,
    cloudNumCtx: 32_768,
    breaker: opts.breaker,
    logger,
    standby: opts.standby ?? false,
    cloudHost: "https://ollama.com",
    standbyEscalateTiers: opts.standbyEscalateTiers ?? [],
  });
  return { routing, cloud, local, logger };
}

/** A generate request carrying a per-call cloud-escalation directive. */
function escalated(model = "hermes3:8b", prompt = "hi"): GenerateRequest {
  return setRouteDirective({ model, prompt }, { backend: "cloud" });
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("standby — local-primary default (F2a)", () => {
  it("serves LOCAL with zero cloud attempts when no directive is present (the zero-egress default)", async () => {
    const { routing, cloud, local, logger } = makeRouting({ standby: true });
    const resp = await routing.generate({ model: "hermes3:8b", prompt: "hi" }, undefined, "workhorse");

    const info = getRoutingInfo(resp);
    expect(info?.backend).toBe("local");
    expect(info?.degraded).toBe(false);
    expect(info?.model).toBe("hermes3:8b");
    expect(cloud.callCount.generate).toBe(0);
    expect(local.callCount.generate).toBe(1);
    // Not a fallback — nothing was degraded, so no backend_fallback event.
    expect(logger.events.find((e) => e.kind === "backend_fallback")).toBeUndefined();
    // No egress → no disclosure.
    expect(logger.events.find((e) => (e as { kind?: string }).kind === "cloud_egress")).toBeUndefined();
    expect(routing.breaker.currentState).toBe("closed");
  });

  it("keeps the runner's local num_ctx on the standby local serve", async () => {
    const { routing, local } = makeRouting({ standby: true });
    const resp = await routing.generate(
      { model: "hermes3:8b", prompt: "hi", options: { num_ctx: 8192 } },
      undefined,
      "workhorse",
    );
    expect(local.lastGenerate?.options?.num_ctx).toBe(8192);
    expect(getRoutingInfo(resp)?.num_ctx).toBe(8192);
  });
});

describe("standby — per-call backend:'cloud' escalation (F2b)", () => {
  it("a backend:'cloud' directive escalates exactly that call to cloud", async () => {
    const { routing, cloud, local } = makeRouting({ standby: true });
    // A normal call first — stays local.
    await routing.generate({ model: "hermes3:8b", prompt: "a" }, undefined, "workhorse");
    // The escalated call — goes to cloud on the tier's cloud model.
    const resp = await routing.generate(escalated(), undefined, "workhorse");

    const info = getRoutingInfo(resp);
    expect(info?.backend).toBe("cloud");
    expect(info?.degraded).toBe(false);
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(1);
    expect(cloud.lastGenerate?.model).toBe("qwen3-coder-next:cloud");
    // Cloud num_ctx cap applies to the escalated attempt.
    expect(cloud.lastGenerate?.options?.num_ctx).toBe(32_768);
  });

  it("an escalated call that fails transiently falls back to LOCAL with honest degrade provenance", async () => {
    const { routing, cloud, local, logger } = makeRouting({
      standby: true,
      cloudGen: async () => {
        throw transient(503);
      },
    });
    const resp = await routing.generate(escalated(), undefined, "workhorse");

    const info = getRoutingInfo(resp);
    expect(info?.backend).toBe("local");
    expect(info?.degraded).toBe(true);
    expect(info?.degrade_reason).toBe("cloud_5xx");
    expect(info?.model).toBe("hermes3:8b");
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(1);
    const ev = logger.events.find((e) => e.kind === "backend_fallback");
    expect((ev as { reason?: string } | undefined)?.reason).toBe("cloud_5xx");
  });

  it("escalated calls share the breaker: after it opens, further escalations short-circuit to local as circuit_open", async () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 20_000, now: () => 0 });
    const { routing, cloud } = makeRouting({
      standby: true,
      breaker,
      cloudGen: async () => {
        throw transient(503);
      },
    });
    for (let i = 0; i < 3; i++) {
      await routing.generate(escalated("hermes3:8b", `t${i}`), undefined, "deep");
    }
    expect(breaker.currentState).toBe("open");
    const fourth = await routing.generate(escalated("hermes3:8b", "t4"), undefined, "deep");
    expect(getRoutingInfo(fourth)?.degrade_reason).toBe("circuit_open");
    expect(cloud.callCount.generate).toBe(3); // frozen — no probe within cooldown
  });

  it("a backend:'cloud' directive with NO tier still serves local (the no-tier guard wins — documented edge)", async () => {
    const { routing, cloud, local } = makeRouting({ standby: true });
    const resp = await routing.generate(escalated(), undefined, undefined);
    expect(getRoutingInfo(resp)?.backend).toBe("local");
    expect(cloud.callCount.generate).toBe(0);
    expect(local.callCount.generate).toBe(1);
  });
});

describe("standby — first-egress disclosure (F2b, finding 3)", () => {
  it("emits ONE loud stderr line + ONE cloud_egress event on the first escalation only", async () => {
    const { routing, logger } = makeRouting({ standby: true });
    await routing.generate(escalated("hermes3:8b", "first"), undefined, "workhorse");
    await routing.generate(escalated("hermes3:8b", "second"), undefined, "workhorse");

    const egress = logger.events.filter((e) => (e as { kind?: string }).kind === "cloud_egress");
    expect(egress.length).toBe(1);
    const ev = egress[0] as unknown as { host?: string; model?: string; mode?: string; tier?: string };
    expect(ev.host).toBe("https://ollama.com");
    expect(ev.model).toBe("qwen3-coder-next:cloud");
    expect(ev.mode).toBe("standby");
    expect(ev.tier).toBe("workhorse");
    // Exactly one stderr disclosure, and it names the host.
    const disclosures = errSpy.mock.calls.filter((args) =>
      String(args[0]).includes("ollama.com"),
    );
    expect(disclosures.length).toBe(1);
  });

  it("standby local-primary calls never disclose (no egress happened)", async () => {
    const { routing, logger } = makeRouting({ standby: true });
    await routing.generate({ model: "hermes3:8b", prompt: "hi" }, undefined, "workhorse");
    expect(logger.events.find((e) => (e as { kind?: string }).kind === "cloud_egress")).toBeUndefined();
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("cloud-primary — per-call backend:'local' pin (F2b)", () => {
  it("pins one call local with no cloud attempt and no degraded flag", async () => {
    const { routing, cloud, local } = makeRouting({ standby: false });
    const req = setRouteDirective(
      { model: "hermes3:8b", prompt: "private" } as GenerateRequest,
      { backend: "local" },
    );
    const resp = await routing.generate(req, undefined, "workhorse");

    const info = getRoutingInfo(resp);
    expect(info?.backend).toBe("local");
    expect(info?.degraded).toBe(false); // caller's choice, not a degradation
    expect(info?.degrade_reason).toBeUndefined();
    expect(cloud.callCount.generate).toBe(0);
    expect(local.callCount.generate).toBe(1);
  });
});

describe("per-call model override honored on cloud (F2b — the v2.3.0 clobber fix)", () => {
  it("modelExplicit sends req.model to cloud instead of the tier map (cloud-primary)", async () => {
    const { routing, cloud } = makeRouting({ standby: false });
    const req = setRouteDirective(
      { model: "glm-5.2:cloud", prompt: "adjudicate" } as GenerateRequest,
      { modelExplicit: true },
    );
    const resp = await routing.generate(req, undefined, "deep");

    expect(cloud.lastGenerate?.model).toBe("glm-5.2:cloud");
    expect(getRoutingInfo(resp)?.backend).toBe("cloud");
    expect(getRoutingInfo(resp)?.model).toBe("glm-5.2:cloud");
  });

  it("modelExplicit + backend:'cloud' under standby — the verify-claims juror path", async () => {
    const { routing, cloud } = makeRouting({ standby: true });
    const req = setRouteDirective(
      { model: "kimi-k2.7-code:cloud", prompt: "adjudicate" } as GenerateRequest,
      { backend: "cloud", modelExplicit: true },
    );
    const resp = await routing.generate(req, undefined, "deep");

    expect(cloud.lastGenerate?.model).toBe("kimi-k2.7-code:cloud");
    expect(getRoutingInfo(resp)?.backend).toBe("cloud");
  });

  it("an explicit-model 404 falls back loudly but does NOT arm the process-wide deterministic cooldown", async () => {
    const { routing, cloud } = makeRouting({
      standby: false,
      cloudGen: async (req) => {
        if (req.model === "retired-model:cloud") throw modelMissing();
        return { model: req.model, response: "cloud-ok", done: true };
      },
    });
    // Call 1: explicit override names a retired cloud model → 404 → local,
    // loud cloud_model_missing.
    const first = await routing.generate(
      setRouteDirective(
        { model: "retired-model:cloud", prompt: "a" } as GenerateRequest,
        { modelExplicit: true },
      ),
      undefined,
      "deep",
    );
    expect(getRoutingInfo(first)?.degrade_reason).toBe("cloud_model_missing");
    expect(cloud.callCount.generate).toBe(1);

    // Call 2: a NORMAL call (tier default model). If the per-call typo had
    // armed the process-wide H3 cooldown, this would skip cloud — one
    // caller's bad override must not degrade every other call for 60s.
    const second = await routing.generate({ model: "hermes3:8b", prompt: "b" }, undefined, "deep");
    expect(cloud.callCount.generate).toBe(2); // cloud WAS attempted
    expect(getRoutingInfo(second)?.backend).toBe("cloud");
    expect(routing.breaker.currentState).toBe("closed");
  });
});

describe("served-model echo (F2b — evidence channel for the verify-claims served-model check)", () => {
  it("routing provenance reports the model the backend SAYS it served, not just what we requested", async () => {
    // Live Ollama Cloud strips the tag suffix on the served model field
    // (request deepseek-v4-pro:cloud → served "deepseek-v4-pro"). The
    // provenance must carry the echo so callers can run the /[-:]cloud$/
    // normalized comparison instead of trusting the request.
    const { routing } = makeRouting({
      standby: false,
      cloudGen: async () => ({ model: "deepseek-v4-pro", response: "ok", done: true }),
    });
    const resp = await routing.generate({ model: "hermes3:8b", prompt: "x" }, undefined, "deep");
    expect(getRoutingInfo(resp)?.model).toBe("deepseek-v4-pro");
  });
});

describe("standby escalation POLICY (F-ef444c5d — INTERN_CLOUD_STANDBY_TIERS)", () => {
  // Standby used to be reachable only through a per-call directive, and only
  // ollama_chat exposed one — so the README's "escalate one high-stakes
  // review to a 600B model" was unreachable for every review-shaped tool.
  // The policy lets an operator declare, once, which TIERS escalate while
  // everything else stays local. The per-call directive still outranks it in
  // both directions.

  it("empty policy leaves standby byte-identical to today: a deep call stays local", async () => {
    const { routing } = makeRouting({ standby: true, standbyEscalateTiers: [] });
    const resp = await routing.generate({ model: "hermes3:8b", prompt: "x" }, undefined, "deep");
    expect(getRoutingInfo(resp)?.backend).toBe("local");
  });

  it("a policy tier escalates without any per-call directive; other tiers stay local", async () => {
    const { routing } = makeRouting({ standby: true, standbyEscalateTiers: ["deep"] });
    const deep = await routing.generate({ model: "hermes3:8b", prompt: "x" }, undefined, "deep");
    expect(getRoutingInfo(deep)?.backend).toBe("cloud");
    const instant = await routing.generate({ model: "hermes3:8b", prompt: "x" }, undefined, "instant");
    expect(getRoutingInfo(instant)?.backend).toBe("local");
  });

  it("an explicit backend:'local' directive opts a policy tier OUT", async () => {
    const { routing } = makeRouting({ standby: true, standbyEscalateTiers: ["deep"] });
    const req = setRouteDirective({ model: "hermes3:8b", prompt: "x" }, { backend: "local" });
    const resp = await routing.generate(req, undefined, "deep");
    expect(getRoutingInfo(resp)?.backend).toBe("local");
  });

  it("an explicit backend:'cloud' directive escalates a NON-policy tier", async () => {
    const { routing } = makeRouting({ standby: true, standbyEscalateTiers: ["deep"] });
    const resp = await routing.generate(escalated(), undefined, "instant");
    expect(getRoutingInfo(resp)?.backend).toBe("cloud");
  });

  it("embed never escalates, even if a policy somehow names it", async () => {
    // loadCloudConfig rejects `embed` by name, so this is belt-and-braces at
    // the routing layer: embeddings ALWAYS stay local, which is the one
    // promise the corpus subsystem is built on.
    const { routing } = makeRouting({
      standby: true,
      standbyEscalateTiers: ["embed" as Tier],
    });
    const resp = await routing.generate({ model: "nomic-embed-text", prompt: "x" }, undefined, "embed");
    expect(getRoutingInfo(resp)?.backend).toBe("local");
  });
});
