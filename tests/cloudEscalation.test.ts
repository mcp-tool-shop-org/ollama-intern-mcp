/**
 * Per-call cloud escalation through the RUNNER and CHAT layers (F2b).
 *
 * routingStandby.test.ts proves the RoutingOllamaClient honors directives;
 * this file proves the directive actually THREADS from tool input →
 * runner/handler → route() and surfaces on the ENVELOPE:
 *
 *   - RunToolInput.backend:'cloud' escalates one call under a standby ctx
 *   - no backend → local under standby (zero egress), envelope backend:'local'
 *   - backend:'cloud' with NO cloud configured → CLOUD_NOT_CONFIGURED
 *     refusal BEFORE any wire call (never a silent local run pretending
 *     it escalated)
 *   - backend:'local' pins a call local under cloud-primary
 *   - per-call modelOverride is honored on the CLOUD path (the v2.3.0
 *     override used to be clobbered by the tier→cloud-model map)
 *   - ollama_chat exposes the same per-call `backend` directive
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runTool } from "../src/tools/runner.js";
import { handleChat, chatSchema } from "../src/tools/chat.js";
import { RoutingOllamaClient } from "../src/routing.js";
import { loadCloudConfig, PROFILES } from "../src/profiles.js";
import { NullLogger } from "../src/observability.js";
import { InternError } from "../src/errors.js";
import { createFakeOllama, makeFakeCtx } from "./_helpers/index.js";
import type { RunContext } from "../src/runContext.js";
import type { GenerateRequest } from "../src/ollama.js";

const KEY_ENV = { OLLAMA_API_KEY: "sk-test-escalation" };
const LOCAL_TIERS = PROFILES["dev-rtx5080"].tiers;

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

interface CloudHarness {
  ctx: RunContext & { logger: NullLogger };
  cloud: ReturnType<typeof createFakeOllama>;
  local: ReturnType<typeof createFakeOllama>;
}

function makeCloudCtx(opts: {
  primary?: boolean;
  cloudGen?: (req: GenerateRequest, signal?: AbortSignal) => Promise<unknown>;
} = {}): CloudHarness {
  const cfg = loadCloudConfig(
    opts.primary ? { OLLAMA_CLOUD_PRIMARY: "1", ...KEY_ENV } : { ...KEY_ENV },
  )!;
  const cloud = createFakeOllama({
    generateImpl: opts.cloudGen
      ? (async (req, signal) => opts.cloudGen!(req, signal) as never)
      : undefined,
    defaultGenerateResponse: '{"ok":true}',
    errorOnUnused: false,
  });
  const local = createFakeOllama({ defaultGenerateResponse: '{"ok":true}', errorOnUnused: false });
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
  return { ctx, cloud, local };
}

function run(ctx: RunContext, extra: Partial<Parameters<typeof runTool<string>>[0]> = {}) {
  return runTool<string>({
    tool: "test_tool",
    tier: "workhorse",
    ctx,
    build: (_tier, model) => ({ model, prompt: "p" }),
    parse: (raw) => raw,
    ...extra,
  });
}

describe("runTool — per-call backend directive (F2b)", () => {
  it("backend:'cloud' escalates under a STANDBY ctx and the envelope carries backend:'cloud'", async () => {
    const { ctx, cloud, local } = makeCloudCtx();
    const env = await run(ctx, { backend: "cloud" });
    expect(env.backend).toBe("cloud");
    expect(env.degraded).toBeUndefined();
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(0);
    expect(cloud.lastGenerate?.model).toBe("qwen3-coder-next:cloud");
    expect(env.model).toBe("qwen3-coder-next:cloud");
  });

  it("no backend under STANDBY stays local — zero egress, envelope backend:'local'", async () => {
    const { ctx, cloud, local } = makeCloudCtx();
    const env = await run(ctx);
    expect(env.backend).toBe("local");
    expect(env.degraded).toBeUndefined();
    expect(cloud.callCount.generate).toBe(0);
    expect(local.callCount.generate).toBe(1);
  });

  it("backend:'cloud' with NO cloud configured refuses with CLOUD_NOT_CONFIGURED before any wire call", async () => {
    const client = createFakeOllama({ defaultGenerateResponse: '{"ok":true}', errorOnUnused: false });
    const ctx = makeFakeCtx({ client });
    let caught: unknown;
    try {
      await run(ctx, { backend: "cloud" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect((caught as InternError).code).toBe("CLOUD_NOT_CONFIGURED");
    // Refused BEFORE the wire — never silently served local pretending it escalated.
    expect(client.callCount.generate).toBe(0);
  });

  it("backend:'local' pins a call local under cloud-PRIMARY (no cloud attempt, not degraded)", async () => {
    const { ctx, cloud, local } = makeCloudCtx({ primary: true });
    const env = await run(ctx, { backend: "local" });
    expect(env.backend).toBe("local");
    expect(env.degraded).toBeUndefined();
    expect(cloud.callCount.generate).toBe(0);
    expect(local.callCount.generate).toBe(1);
  });
});

describe("runTool — per-call modelOverride honored on cloud (the v2.3.0 clobber fix)", () => {
  it("cloud-primary: the override is the model actually sent to cloud, and the envelope proves it", async () => {
    const { ctx, cloud } = makeCloudCtx({ primary: true });
    const env = await run(ctx, { modelOverride: "glm-5.2:cloud" });
    expect(cloud.lastGenerate?.model).toBe("glm-5.2:cloud");
    expect(env.model_requested).toBe("glm-5.2:cloud");
    expect(env.model).toBe("glm-5.2:cloud");
    expect(env.backend).toBe("cloud");
  });

  it("standby + backend:'cloud' + modelOverride — the verify-claims juror path", async () => {
    const { ctx, cloud } = makeCloudCtx();
    const env = await run(ctx, { backend: "cloud", modelOverride: "deepseek-v4-pro:cloud" });
    expect(cloud.lastGenerate?.model).toBe("deepseek-v4-pro:cloud");
    expect(env.backend).toBe("cloud");
    expect(env.model_requested).toBe("deepseek-v4-pro:cloud");
  });

  it("an escalated call whose cloud attempt fails falls back LOCAL with honest provenance", async () => {
    const { ctx, cloud, local } = makeCloudCtx({
      cloudGen: async () => {
        throw new InternError("OLLAMA_UNREACHABLE", "Ollama returned 503: boom", "hint", true);
      },
    });
    const env = await run(ctx, { backend: "cloud", modelOverride: "kimi-k2.7-code:cloud" });
    expect(env.backend).toBe("local");
    expect(env.degraded).toBe(true);
    expect(env.degrade_reason).toBe("cloud_5xx");
    expect(env.model).toBe(LOCAL_TIERS.workhorse); // the local tier model served
    expect(env.model_requested).toBe("kimi-k2.7-code:cloud"); // substitution detectable
    expect(cloud.callCount.generate).toBe(1);
    expect(local.callCount.generate).toBe(1);
  });
});

describe("ollama_chat — per-call backend directive (F2b)", () => {
  it("backend:'cloud' escalates a chat under standby", async () => {
    const { ctx, cloud, local } = makeCloudCtx();
    const env = await handleChat(
      { messages: [{ role: "user", content: "hi" }], backend: "cloud" },
      ctx,
    );
    expect(env.backend).toBe("cloud");
    expect(cloud.callCount.chat).toBe(1);
    expect(local.callCount.chat).toBe(0);
  });

  it("chat stays local under standby by default", async () => {
    const { ctx, cloud, local } = makeCloudCtx();
    const env = await handleChat({ messages: [{ role: "user", content: "hi" }] }, ctx);
    expect(env.backend).toBe("local");
    expect(cloud.callCount.chat).toBe(0);
    expect(local.callCount.chat).toBe(1);
  });

  it("chat backend:'cloud' without cloud configured → CLOUD_NOT_CONFIGURED, no wire call", async () => {
    const client = createFakeOllama({ defaultGenerateResponse: "x", errorOnUnused: false });
    const ctx = makeFakeCtx({ client });
    let caught: unknown;
    try {
      await handleChat({ messages: [{ role: "user", content: "hi" }], backend: "cloud" }, ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect((caught as InternError).code).toBe("CLOUD_NOT_CONFIGURED");
    expect(client.callCount.chat).toBe(0);
  });

  it("a per-call model override rides the cloud escalation (juror-shaped chat)", async () => {
    const { ctx, cloud } = makeCloudCtx();
    const env = await handleChat(
      {
        messages: [{ role: "user", content: "adjudicate" }],
        model: "glm-5.2:cloud",
        backend: "cloud",
      },
      ctx,
    );
    expect(cloud.lastChat?.model).toBe("glm-5.2:cloud");
    expect(env.backend).toBe("cloud");
    expect(env.model_requested).toBe("glm-5.2:cloud");
  });

  it("chatSchema accepts backend:'cloud'|'local' and rejects anything else", () => {
    const base = { messages: [{ role: "user", content: "hi" }] };
    expect(() => chatSchema.parse({ ...base, backend: "cloud" })).not.toThrow();
    expect(() => chatSchema.parse({ ...base, backend: "local" })).not.toThrow();
    expect(() => chatSchema.parse({ ...base, backend: "mars" })).toThrow();
  });
});
