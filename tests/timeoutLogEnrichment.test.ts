/**
 * Stage B+C log enrichment — timeout events now carry `model` and
 * `profile_name` so operators can diff timeouts across profile changes.
 * fallback events also carry `profile_name`. Both fields are optional on
 * the LogEvent type so existing callers keep working.
 */

import { describe, expect, it } from "vitest";
import { runWithTimeoutAndFallback } from "../src/guardrails/timeouts.js";
import { NullLogger } from "../src/observability.js";

describe("timeout log enrichment", () => {
  it("timeout event includes model and profile_name when provided", async () => {
    const logger = new NullLogger();
    await runWithTimeoutAndFallback({
      tool: "t",
      tier: "instant",
      logger,
      allowFallback: false,
      timeoutOverrideMs: { instant: 10 },
      modelFor: (tier) => `hermes3:8b-for-${tier}`,
      profileName: "dev-rtx5080",
      run: (_tier, signal) =>
        new Promise<string>((_r, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }).catch(() => undefined);

    const timeoutEv = logger.events.find((e) => e.kind === "timeout");
    expect(timeoutEv).toBeDefined();
    expect(timeoutEv!.kind).toBe("timeout");
    // Cast through the discriminant — assertions must run unconditionally.
    // Using the discriminant as a guard (`if (...kind === "timeout")`)
    // silently skips every assertion if the kind ever changes, which is
    // exactly the regression this test is supposed to guard against.
    const ev = timeoutEv as Extract<typeof timeoutEv, { kind: "timeout" }>;
    expect(ev.model).toBe("hermes3:8b-for-instant");
    expect(ev.profile_name).toBe("dev-rtx5080");
    expect(ev.timeout_ms).toBe(10);
    expect(ev.tier).toBe("instant");
  });

  it("fallback event carries profile_name", async () => {
    const logger = new NullLogger();
    await runWithTimeoutAndFallback({
      tool: "t",
      tier: "deep",
      logger,
      allowFallback: true,
      timeoutOverrideMs: { deep: 10, workhorse: 1000 },
      modelFor: (tier) => `m-${tier}`,
      profileName: "dev-rtx5080-qwen3",
      run: async (tier, signal) => {
        if (tier === "deep") {
          return new Promise<string>((_r, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return "ok";
      },
    });

    const fallbackEv = logger.events.find((e) => e.kind === "fallback");
    expect(fallbackEv).toBeDefined();
    expect(fallbackEv!.kind).toBe("fallback");
    const ev = fallbackEv as Extract<typeof fallbackEv, { kind: "fallback" }>;
    expect(ev.profile_name).toBe("dev-rtx5080-qwen3");
    expect(ev.from).toBe("deep");
    expect(ev.to).toBe("workhorse");
  });

  it("omits model / profile_name fields when resolvers are not passed (backward compat)", async () => {
    const logger = new NullLogger();
    await runWithTimeoutAndFallback({
      tool: "t",
      tier: "instant",
      logger,
      allowFallback: false,
      timeoutOverrideMs: { instant: 10 },
      run: (_tier, signal) =>
        new Promise<string>((_r, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }).catch(() => undefined);

    const timeoutEv = logger.events.find((e) => e.kind === "timeout");
    expect(timeoutEv).toBeDefined();
    expect(timeoutEv!.kind).toBe("timeout");
    const ev = timeoutEv as Extract<typeof timeoutEv, { kind: "timeout" }>;
    expect(ev.model).toBeUndefined();
    expect(ev.profile_name).toBeUndefined();
  });
});
