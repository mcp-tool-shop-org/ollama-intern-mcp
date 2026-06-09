/**
 * ollama_doctor — cloud block. When ctx.cloud is set, doctor probes the cloud
 * host's /api/tags with the Bearer key and reports reachable + auth_ok + model
 * map. A 401/403 = reachable-but-bad-key (warning, not fatal). Local fallback
 * keeps the server healthy.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { handleDoctor } from "../src/tools/doctor.js";
import { createFakeOllama } from "./_helpers/fakeOllama.js";
import { NullLogger } from "../src/observability.js";
import { PROFILES, type CloudConfig } from "../src/profiles.js";
import type { RunContext } from "../src/runContext.js";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock fetch: cloud host responds per `cloudStatus`; local host returns the required models. */
function mockFetch(cloudStatus: number) {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("ollama.com")) {
      return cloudStatus === 200 ? jsonResponse({ models: [] }) : new Response("no", { status: cloudStatus });
    }
    if (u.endsWith("/api/tags")) {
      return jsonResponse({ models: [{ name: "hermes3:8b" }, { name: "nomic-embed-text" }] });
    }
    if (u.endsWith("/api/ps")) return jsonResponse({ models: [] });
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeCtx(): RunContext {
  // Local probe ok so reachability is the cloud test's focus, not local.
  const client = createFakeOllama({ probeImpl: async () => ({ ok: true }) });
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
    cloud: CLOUD,
  };
}

describe("ollama_doctor — cloud block", () => {
  it("reports reachable + auth 'unverified' on a 200 (/api/tags does not gate the key)", async () => {
    mockFetch(200);
    const env = await handleDoctor({}, makeCtx());
    expect(env.result.cloud).toBeDefined();
    expect(env.result.cloud?.enabled).toBe(true);
    expect(env.result.cloud?.host).toBe("https://ollama.com");
    expect(env.result.cloud?.reachable).toBe(true);
    // 200 from /api/tags can't confirm a GOOD key → unverified, never "ok".
    expect(env.result.cloud?.auth).toBe("unverified");
    expect(env.result.cloud?.models.instant).toBe("minimax-m3:cloud");
    expect(env.warnings?.some((w) => /Cloud auth failed/.test(w)) ?? false).toBe(false);
  });

  it("flags auth='failed' and warns on a 401 (but stays reachable + healthy via local)", async () => {
    mockFetch(401);
    const env = await handleDoctor({}, makeCtx());
    expect(env.result.cloud?.reachable).toBe(true); // HTTP 401 = server answered
    expect(env.result.cloud?.auth).toBe("failed");
    expect(env.warnings?.some((w) => /Ollama Cloud auth failed/.test(w))).toBe(true);
    // Local is reachable + models present → overall still healthy.
    expect(env.result.healthy).toBe(true);
  });

  it("omits the cloud block entirely when cloud is not enabled", async () => {
    mockFetch(200);
    const ctx = makeCtx();
    delete ctx.cloud;
    const env = await handleDoctor({}, ctx);
    expect(env.result.cloud).toBeUndefined();
  });
});
