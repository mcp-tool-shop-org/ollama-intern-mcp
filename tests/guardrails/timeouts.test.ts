import { describe, it, expect } from "vitest";
import { runWithTimeoutAndFallback } from "../../src/guardrails/timeouts.js";
import { NullLogger } from "../../src/observability.js";
import { InternError } from "../../src/errors.js";

describe("runWithTimeoutAndFallback", () => {
  it("returns the value when run() resolves before timeout", async () => {
    const logger = new NullLogger();
    const result = await runWithTimeoutAndFallback({
      tool: "t",
      tier: "instant",
      logger,
      run: async () => "ok",
    });
    expect(result.value).toBe("ok");
    expect(result.actualTier).toBe("instant");
    expect(result.fallbackFrom).toBeUndefined();
    expect(logger.events).toHaveLength(0);
  });

  it("throws TIER_TIMEOUT when the terminal tier has no fallback", async () => {
    const logger = new NullLogger();
    await expect(
      runWithTimeoutAndFallback({
        tool: "t",
        tier: "instant",
        logger,
        allowFallback: true,
        timeoutOverrideMs: { instant: 20 },
        run: (_tier, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      }),
    ).rejects.toMatchObject({ code: "TIER_TIMEOUT" });

    expect(logger.events.some((e) => e.kind === "timeout")).toBe(true);
  });

  it("logs timeout and fallback events when cascading", async () => {
    const logger = new NullLogger();
    const result = await runWithTimeoutAndFallback({
      tool: "t",
      tier: "deep",
      logger,
      allowFallback: true,
      timeoutOverrideMs: { deep: 20, workhorse: 1000 },
      run: async (tier, signal) => {
        if (tier === "deep") {
          return new Promise<string>((_r, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return "workhorse-ok";
      },
    });
    expect(result.value).toBe("workhorse-ok");
    expect(result.actualTier).toBe("workhorse");
    expect(result.fallbackFrom).toBe("deep");

    const kinds = logger.events.map((e) => e.kind);
    expect(kinds).toContain("timeout");
    expect(kinds).toContain("fallback");
  });
});
