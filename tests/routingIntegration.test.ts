/**
 * End-to-end: a real tool (ollama_classify) driven through the
 * RoutingOllamaClient with ctx.cloud set. Proves the runner lifts backend
 * provenance onto the envelope and that residency is null for cloud-served
 * calls — without any network.
 */

import { describe, it, expect } from "vitest";
import { handleClassify } from "../src/tools/classify.js";
import { RoutingOllamaClient } from "../src/routing.js";
import { createFakeOllama } from "./_helpers/fakeOllama.js";
import { NullLogger } from "../src/observability.js";
import { PROFILES, type CloudConfig } from "../src/profiles.js";
import { InternError } from "../src/errors.js";
import type { RunContext } from "../src/runContext.js";

const CLOUD: CloudConfig = {
  host: "https://ollama.com",
  apiKey: "sk-test",
  tiers: {
    instant: "minimax-m3:cloud",
    workhorse: "minimax-m3:cloud",
    deep: "minimax-m3:cloud",
    embed: "nomic-embed-text",
  },
  timeouts: { instant: 30_000, workhorse: 120_000, deep: 300_000, embed: 10_000 },
  numCtx: 32_768,
};

const CLASSIFY_JSON = JSON.stringify({ label: "fix", confidence: 0.9 });

function makeCloudCtx(opts: { cloudGen?: () => Promise<unknown> }): {
  ctx: RunContext;
  logger: NullLogger;
  cloud: ReturnType<typeof createFakeOllama>;
  local: ReturnType<typeof createFakeOllama>;
} {
  const logger = new NullLogger();
  const cloud = createFakeOllama({
    generateImpl: opts.cloudGen ? (async () => opts.cloudGen!() as never) : undefined,
    defaultGenerateResponse: CLASSIFY_JSON,
    errorOnUnused: false,
  });
  const local = createFakeOllama({ defaultGenerateResponse: CLASSIFY_JSON, errorOnUnused: false });
  const routing = new RoutingOllamaClient({
    cloud,
    local,
    cloudTiers: CLOUD.tiers,
    localTiers: PROFILES["dev-rtx5080"].tiers,
    cloudTimeouts: CLOUD.timeouts,
    cloudNumCtx: CLOUD.numCtx,
    logger,
  });
  const ctx: RunContext = {
    client: routing,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger,
    cloud: CLOUD,
  };
  return { ctx, logger, cloud, local };
}

describe("runner + routing — envelope provenance", () => {
  it("a cloud-served classify reports backend=cloud, cloud model, null residency", async () => {
    const { ctx, cloud, local } = makeCloudCtx({});
    const env = await handleClassify({ text: "patch null deref", labels: ["feat", "fix", "chore"] }, ctx);

    expect(env.result.label).toBe("fix");
    expect(env.backend).toBe("cloud");
    expect(env.model).toBe("minimax-m3:cloud");
    expect(env.degraded).toBeUndefined(); // additive: absent, not false
    expect(env.residency).toBeNull(); // cloud has no local residency
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(0);
  });

  it("a degraded classify reports backend=local, degraded + reason, local model, and logs backend_fallback", async () => {
    const { ctx, logger, cloud, local } = makeCloudCtx({
      cloudGen: async () => {
        throw new InternError("OLLAMA_UNREACHABLE", "Ollama returned 503: boom", "hint", true);
      },
    });
    const env = await handleClassify({ text: "patch null deref", labels: ["feat", "fix", "chore"] }, ctx);

    expect(env.result.label).toBe("fix"); // local still answered
    expect(env.backend).toBe("local");
    expect(env.degraded).toBe(true);
    expect(env.degrade_reason).toBe("cloud_5xx");
    expect(env.model).toBe(PROFILES["dev-rtx5080"].tiers.instant); // local instant model
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(1);
    // The cloud→local fallback was logged for observability.
    const ev = logger.events.find((e) => e.kind === "backend_fallback");
    expect(ev).toBeDefined();
    expect((ev as { reason?: string }).reason).toBe("cloud_5xx");
  });
});
