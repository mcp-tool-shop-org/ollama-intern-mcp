/**
 * H1-res (2026-07 health pass) — end-to-end signal-chain guard.
 *
 * H1 (Phase 1) made the Ollama semaphore abort-aware so a queued call can be
 * dequeued by its tier-timeout signal instead of hanging until an unrelated
 * holder releases. That fix only works if the AbortSignal threads through EVERY
 * hop of the real call path:
 *
 *   runWithTimeoutAndFallback (guardrails/timeouts.ts, arms the timer + signal)
 *     -> run(tier, signal) -> ctx.client.generate(req, signal, tier)  (runner.ts)
 *     -> HttpOllamaClient.post(..., signal)                            (ollama.ts)
 *     -> ollamaSemaphore.acquire(signal)                              (semaphore.ts)
 *
 * This test drives that whole chain through the REAL runner + REAL
 * HttpOllamaClient + REAL module semaphore (fetch is mocked to hang). A future
 * refactor that drops the signal at any hop makes the queued call wait for the
 * permit holder instead of its own budget — caught here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runTool } from "../src/tools/runner.js";
import { HttpOllamaClient } from "../src/ollama.js";
import { ollamaSemaphore } from "../src/semaphore.js";
import { PROFILES } from "../src/profiles.js";
import { NullLogger } from "../src/observability.js";
import { InternError } from "../src/errors.js";
import type { Tier } from "../src/tiers.js";
import type { RunContext } from "../src/runContext.js";

const origFetch = globalThis.fetch;
const origConcurrency = process.env.INTERN_MAX_CONCURRENT;

beforeAll(() => {
  // 1 permit so the holder saturates the gate and the second call MUST queue.
  // Set before the lazily-resolved semaphore singleton is first touched.
  process.env.INTERN_MAX_CONCURRENT = "1";
});

afterAll(() => {
  if (origConcurrency === undefined) delete process.env.INTERN_MAX_CONCURRENT;
  else process.env.INTERN_MAX_CONCURRENT = origConcurrency;
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

function makeCtx(client: HttpOllamaClient, tierBudgetMs: number): RunContext {
  const t: Record<Tier, number> = {
    instant: tierBudgetMs,
    workhorse: tierBudgetMs,
    deep: tierBudgetMs,
    embed: tierBudgetMs,
  };
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: t,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

describe("full signal chain — tier timeout -> runner -> post -> semaphore.acquire (H1-res)", () => {
  it("a queued call is dequeued by its own tier-timeout signal, never waits for the holder, and never reaches the wire", async () => {
    // fetch hangs until ITS signal aborts (a wedged in-flight call).
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal ?? undefined;
          const abort = (): void =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal?.aborted) return abort();
          signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new HttpOllamaClient("http://127.0.0.1:11434");

    // Holder — grabs the sole permit and hangs on fetch until its own 1200ms
    // budget aborts it. Swallow the eventual TIER_TIMEOUT.
    const holder = runTool({
      tool: "holder",
      tier: "workhorse",
      ctx: makeCtx(client, 1200),
      allowFallback: false,
      build: (_t, model) => ({ model, prompt: "hold", format: "json", options: {} }),
      parse: (raw) => JSON.parse(raw) as unknown,
    }).catch(() => "holder-done");

    // Wait until the holder actually holds the permit (gate saturated), so the
    // next call is GUARANTEED to queue rather than acquire a free permit.
    await vi.waitFor(() => expect(ollamaSemaphore.wouldBlock).toBe(true));

    // Queued call — its instant budget (150ms) must abort the QUEUED acquire and
    // settle at ~150ms, NOT wait ~1200ms for the holder to release.
    const started = Date.now();
    let thrown: unknown = null;
    try {
      await runTool({
        tool: "queued",
        tier: "instant",
        ctx: makeCtx(client, 150),
        allowFallback: false,
        build: (_t, model) => ({ model, prompt: "queued", format: "json", options: {} }),
        parse: (raw) => JSON.parse(raw) as unknown,
      });
    } catch (e) {
      thrown = e;
    }
    const elapsed = Date.now() - started;

    // Settled as a tier timeout (ran out of budget waiting for a permit).
    expect(thrown).toBeInstanceOf(InternError);
    expect((thrown as InternError).code).toBe("TIER_TIMEOUT");
    // Dequeued at its budget — NOT blocked until the holder released (~1200ms).
    // If any hop drops the signal, this jumps to ~1200ms.
    expect(elapsed).toBeLessThan(700);
    // Timing-independent proof: the queued call was dequeued at the semaphore
    // BEFORE ever reaching the wire, so only the holder hit fetch. A dropped
    // signal would let it acquire on holder-release and hit fetch a 2nd time.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Its abandoned queue entry consumed no permit: queue empty, holder still in.
    expect(ollamaSemaphore.pending).toBe(0);
    expect(ollamaSemaphore.wouldBlock).toBe(true);

    // Let the holder time out + release before the file tears down.
    await holder;
  });
});
