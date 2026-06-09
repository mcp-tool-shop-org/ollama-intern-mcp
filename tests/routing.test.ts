/**
 * RoutingOllamaClient — cloud-primary / local-fallback policy + circuit breaker.
 *
 * Network-free: a fake cloud client and a fake local client are injected via
 * createFakeOllama's generateImpl. We assert the routing PROVENANCE
 * (getRoutingInfo) and the breaker state machine, not real HTTP.
 */

import { describe, it, expect } from "vitest";
import {
  RoutingOllamaClient,
  CircuitBreaker,
  getRoutingInfo,
} from "../src/routing.js";
import { createFakeOllama } from "./_helpers/fakeOllama.js";
import { NullLogger } from "../src/observability.js";
import { InternError } from "../src/errors.js";
import type { Tier, TierConfig } from "../src/tiers.js";

const CLOUD_TIERS: TierConfig = {
  instant: "minimax-m3:cloud",
  workhorse: "minimax-m3:cloud",
  deep: "minimax-m3:cloud",
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
function authErr(): InternError {
  return new InternError("OLLAMA_AUTH_FAILED", "Ollama returned 401: nope", "hint", false);
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
  cloudGen?: (req: { model: string }) => Promise<unknown>;
  breaker?: CircuitBreaker;
}): Harness {
  const cloud = createFakeOllama({
    generateImpl: opts.cloudGen
      ? (async (req) => opts.cloudGen!(req) as never)
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
  });
  return { routing, cloud, local, logger };
}

describe("RoutingOllamaClient — happy path", () => {
  it("serves from cloud when healthy and tags backend=cloud, not degraded", async () => {
    const { routing, cloud, local } = makeRouting({});
    const resp = await routing.generate({ model: "hermes3:8b", prompt: "hi" }, undefined, "deep");

    const info = getRoutingInfo(resp);
    expect(info?.backend).toBe("cloud");
    expect(info?.model).toBe("minimax-m3:cloud");
    expect(info?.degraded).toBe(false);
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(0);
    // The cloud attempt used the cloud model, not the runner-supplied local one.
    expect(cloud.lastGenerate?.model).toBe("minimax-m3:cloud");
  });
});

describe("RoutingOllamaClient — num_ctx per backend", () => {
  it("overrides cloud num_ctx to the cap (not the local VRAM-driven value)", async () => {
    const { routing, cloud } = makeRouting({});
    // Runner supplies a tiny local num_ctx (8192 for workhorse on dev-rtx5080).
    const resp = await routing.generate(
      { model: "hermes3:8b", prompt: "hi", options: { num_ctx: 8192 } },
      undefined,
      "workhorse",
    );
    expect(cloud.lastGenerate?.options?.num_ctx).toBe(32_768);
    expect(getRoutingInfo(resp)?.num_ctx).toBe(32_768);
  });

  it("keeps the runner's local num_ctx on a local fallback", async () => {
    const { routing, local } = makeRouting({
      cloudGen: async () => {
        throw transient(503);
      },
    });
    const resp = await routing.generate(
      { model: "hermes3:8b", prompt: "hi", options: { num_ctx: 8192 } },
      undefined,
      "workhorse",
    );
    expect(local.lastGenerate?.options?.num_ctx).toBe(8192);
    expect(getRoutingInfo(resp)?.num_ctx).toBe(8192);
  });
});

describe("RoutingOllamaClient — transient fallback", () => {
  it("falls back to local on a transient cloud failure, tagged degraded + reason", async () => {
    const { routing, cloud, local, logger } = makeRouting({
      cloudGen: async () => {
        throw transient(503);
      },
    });
    const resp = await routing.generate({ model: "hermes3:8b", prompt: "hi" }, undefined, "workhorse");

    const info = getRoutingInfo(resp);
    expect(info?.backend).toBe("local");
    expect(info?.degraded).toBe(true);
    expect(info?.degrade_reason).toBe("cloud_5xx");
    expect(info?.model).toBe("hermes3:8b");
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(1);
    // The local fallback used the local model.
    expect(local.lastGenerate?.model).toBe("hermes3:8b");
    // A backend_fallback event was emitted.
    const ev = logger.events.find((e) => e.kind === "backend_fallback");
    expect(ev).toBeDefined();
    expect((ev as { reason?: string }).reason).toBe("cloud_5xx");
  });

  it("maps 429 to cloud_rate_limited", async () => {
    const { routing } = makeRouting({
      cloudGen: async () => {
        throw transient(429);
      },
    });
    const resp = await routing.generate({ model: "hermes3:8b", prompt: "x" }, undefined, "instant");
    expect(getRoutingInfo(resp)?.degrade_reason).toBe("cloud_rate_limited");
  });
});

describe("RoutingOllamaClient — auth is sticky", () => {
  it("trips a misconfigured breaker on 401 and stops attempting cloud", async () => {
    const { routing, cloud, local } = makeRouting({
      cloudGen: async () => {
        throw authErr();
      },
    });
    // First call: cloud 401 → serve local, breaker → misconfigured.
    const first = await routing.generate({ model: "hermes3:8b", prompt: "a" }, undefined, "deep");
    expect(getRoutingInfo(first)?.degrade_reason).toBe("cloud_auth_failed");
    expect(routing.breaker.currentState).toBe("misconfigured");

    // Second call: must NOT retry cloud (sticky) — cloud callCount frozen at 1.
    const second = await routing.generate({ model: "hermes3:8b", prompt: "b" }, undefined, "deep");
    expect(getRoutingInfo(second)?.backend).toBe("local");
    expect(getRoutingInfo(second)?.degrade_reason).toBe("cloud_auth_failed");
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(2);
  });
});

describe("RoutingOllamaClient — deterministic errors surface", () => {
  it("rethrows a 404 model-missing instead of silently serving local", async () => {
    const { routing, cloud, local } = makeRouting({
      cloudGen: async () => {
        throw modelMissing();
      },
    });
    await expect(
      routing.generate({ model: "hermes3:8b", prompt: "x" }, undefined, "deep"),
    ).rejects.toMatchObject({ code: "OLLAMA_MODEL_MISSING" });
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(0); // no silent fallback
  });
});

describe("RoutingOllamaClient — embed is always local", () => {
  it("never calls cloud for embed", async () => {
    const { routing, cloud, local } = makeRouting({});
    await routing.embed({ model: "nomic-embed-text", input: "hello" }, undefined, "embed");
    expect(cloud.callCount.embed).toBe(0);
    expect(local.callCount.embed).toBe(1);
  });
});

describe("CircuitBreaker state machine", () => {
  it("opens after 3 consecutive failures, then routes straight to local (no cloud attempt)", async () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 20_000, now: () => 0 });
    const { routing, cloud, local } = makeRouting({
      cloudGen: async () => {
        throw transient(503);
      },
      breaker,
    });
    // 3 calls each try cloud (and fall to local), tripping the breaker on the 3rd.
    for (let i = 0; i < 3; i++) {
      await routing.generate({ model: "hermes3:8b", prompt: `c${i}` }, undefined, "deep");
    }
    expect(cloud.callCount.generate).toBe(3);
    expect(breaker.currentState).toBe("open");

    // 4th call: breaker OPEN within cooldown → straight to local, cloud NOT attempted.
    const fourth = await routing.generate({ model: "hermes3:8b", prompt: "c4" }, undefined, "deep");
    expect(getRoutingInfo(fourth)?.degrade_reason).toBe("circuit_open");
    expect(cloud.callCount.generate).toBe(3); // frozen
    expect(local.callCount.generate).toBe(4);
  });

  it("admits exactly one half-open probe after the cooldown, and closes on success", async () => {
    let clock = 0;
    let cloudShouldFail = true;
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 1_000, now: () => clock });
    const { routing, cloud } = makeRouting({
      cloudGen: async (req) => {
        if (cloudShouldFail) throw transient(503);
        return { model: req.model, response: "cloud-recovered", done: true };
      },
      breaker,
    });
    // Trip it open.
    for (let i = 0; i < 3; i++) {
      await routing.generate({ model: "hermes3:8b", prompt: `t${i}` }, undefined, "deep");
    }
    expect(breaker.currentState).toBe("open");
    const beforeProbe = cloud.callCount.generate;

    // Advance past cooldown; cloud is healthy now.
    clock = 2_000;
    cloudShouldFail = false;
    const probe = await routing.generate({ model: "hermes3:8b", prompt: "probe" }, undefined, "deep");
    // The half-open probe hit cloud and succeeded → closed, served from cloud.
    expect(cloud.callCount.generate).toBe(beforeProbe + 1);
    expect(getRoutingInfo(probe)?.backend).toBe("cloud");
    expect(breaker.currentState).toBe("closed");
  });
});
