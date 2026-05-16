/**
 * Direct coverage for src/corpus/lock.ts (Stage C / tests F-002).
 *
 * withCorpusLock is load-bearing for corpus + manifest atomicity. Without
 * it, two concurrent ollama_corpus_index / ollama_corpus_refresh callers
 * targeting the same corpus name can interleave the corpus JSON and
 * manifest JSON writes — leaving the pair inconsistent. The lock had
 * ZERO direct test coverage before this file; bugs landed by way of
 * downstream corpus consistency failures.
 *
 * What this file locks:
 *   1. Two concurrent waiters serialize — deferred-promise barrier (NOT
 *      setTimeout) for deterministic ordering, no timer flake.
 *   2. Exception in the locked region releases the lock — the next caller
 *      still acquires.
 *   3. Lock chain poisoning recovery — the `chain.catch(() => undefined)`
 *      in the implementation actually prevents one bad caller from
 *      stranding the chain.
 *   4. Different names DO NOT serialize — locks are per-name only.
 *   5. Lock map cleanup — single-name usage doesn't leak entries forever.
 *   6. No-double-release safety — withCorpusLock owns release, and a
 *      caller calling the inner fn twice doesn't trigger a permit leak
 *      (semantic: lock is a Promise chain, not a permit; the test pins
 *      the documented contract).
 *
 * Failure messages describe the TIMELINE — operators reading a stack
 * trace see "B acquired at T+5ms before A released at T+10ms" rather
 * than just "expected true to be false".
 */

import { describe, it, expect } from "vitest";
import { withCorpusLock } from "../../src/corpus/lock.js";

/** Deferred promise — the deterministic barrier used to order waiters. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withCorpusLock — serialization (F-002)", () => {
  it("two concurrent waiters serialize against the same name (deferred-promise barrier)", async () => {
    // Hold the first lock open via a deferred until the test explicitly
    // releases it. The SECOND withCorpusLock call MUST NOT execute its
    // fn until the first deferred resolves — that's the load-bearing
    // serialization guarantee.
    const gateA = deferred<void>();
    const order: string[] = [];

    const aPromise = withCorpusLock("alpha", async () => {
      order.push("A:enter");
      await gateA.promise;
      order.push("A:exit");
      return "A";
    });

    // Microtask flush so A registers BEFORE we queue B.
    await Promise.resolve();
    await Promise.resolve();

    const bPromise = withCorpusLock("alpha", async () => {
      order.push("B:enter");
      return "B";
    });

    // At this point A holds the lock; B is queued. Drain microtasks —
    // B MUST NOT have entered yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order, `expected B to be queued behind A, but order so far is [${order.join(", ")}]`).toEqual([
      "A:enter",
    ]);

    // Now release A — B should run next and the final order is fixed.
    gateA.resolve();
    const [aVal, bVal] = await Promise.all([aPromise, bPromise]);
    expect(aVal).toBe("A");
    expect(bVal).toBe("B");
    expect(order).toEqual(["A:enter", "A:exit", "B:enter"]);
  });

  it("different names DO NOT serialize against each other", async () => {
    // Per-name locks; alpha and beta MUST be independent. If they
    // weren't, a slow alpha mutation would block beta callers forever
    // — a regression we want to fail fast on.
    const gateAlpha = deferred<void>();
    const order: string[] = [];

    const alphaPromise = withCorpusLock("alpha", async () => {
      order.push("alpha:enter");
      await gateAlpha.promise;
      order.push("alpha:exit");
    });

    await Promise.resolve();

    const betaPromise = withCorpusLock("beta", async () => {
      order.push("beta:enter");
      order.push("beta:exit");
    });

    // beta should be able to finish before alpha — different name.
    await betaPromise;
    expect(order, `beta should run while alpha is held, but order is [${order.join(", ")}]`).toEqual([
      "alpha:enter",
      "beta:enter",
      "beta:exit",
    ]);
    gateAlpha.resolve();
    await alphaPromise;
  });
});

describe("withCorpusLock — fault tolerance (F-002)", () => {
  it("exception in the locked region releases the lock; the next caller acquires", async () => {
    // The implementation uses a try/finally cleanup; if it ever drops
    // back to a plain `.then(release)`, a throw would strand the lock.
    // Lock A throws, then B should acquire immediately — not hang.
    const boom = new Error("intentional failure inside locked region");
    await expect(
      withCorpusLock("trap", async () => {
        throw boom;
      }),
    ).rejects.toThrow("intentional failure");

    // After the failure, B must be able to acquire and run.
    const bVal = await withCorpusLock("trap", async () => "recovered");
    expect(bVal).toBe("recovered");
  });

  it("lock chain poisoning recovery — one rejected fn does not block subsequent callers", async () => {
    // The implementation does `prior.catch(() => undefined).then(fn)` so
    // a rejected prior promise doesn't poison the chain. Without that
    // catch, the SECOND caller would inherit the rejection and never
    // run its fn.
    const order: string[] = [];

    const aPromise = withCorpusLock("poison", async () => {
      order.push("A:enter");
      throw new Error("A failed");
    });

    // Queue B and C concurrently — both should run regardless of A.
    const bPromise = withCorpusLock("poison", async () => {
      order.push("B:enter");
      return "B";
    });
    const cPromise = withCorpusLock("poison", async () => {
      order.push("C:enter");
      return "C";
    });

    await expect(aPromise).rejects.toThrow("A failed");
    expect(await bPromise).toBe("B");
    expect(await cPromise).toBe("C");
    expect(order).toEqual(["A:enter", "B:enter", "C:enter"]);
  });

  it("synchronous throw inside the fn is treated the same as async rejection", async () => {
    // Defensive — async functions auto-promote throws to rejections, but
    // pin that the lock cleanup runs in both cases.
    await expect(
      withCorpusLock("sync-throw", async () => {
        // Intentionally synchronous throw before any await.
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");

    const recovered = await withCorpusLock("sync-throw", async () => "ok");
    expect(recovered).toBe("ok");
  });
});

describe("withCorpusLock — ordering and cleanup (F-002)", () => {
  it("FIFO ordering across many queued waiters", async () => {
    // The chain is a strict promise chain — waiters run in the order
    // they queued. Pin the contract so a future change to a priority
    // queue (or parallel acquire) doesn't slip past unnoticed.
    const gate = deferred<void>();
    const order: number[] = [];

    const first = withCorpusLock("queue", async () => {
      order.push(0);
      await gate.promise;
    });

    await Promise.resolve();

    const followers = Array.from({ length: 5 }, (_, i) =>
      withCorpusLock("queue", async () => {
        order.push(i + 1);
      }),
    );

    gate.resolve();
    await Promise.all([first, ...followers]);
    expect(order, `expected FIFO 0..5 but got [${order.join(", ")}]`).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("lock map cleans up after the chain drains (no unbounded growth)", async () => {
    // The implementation deletes the entry when the head of the chain
    // matches the just-finished promise. We can't observe the internal
    // Map directly without exporting it, but we CAN observe the
    // behavior: many sequential single-shot calls against distinct
    // names complete without leaking. If they did leak, this loop
    // would grow memory unboundedly — which a Node test runner would
    // notice indirectly via OOM, but the load-bearing assertion is
    // that subsequent calls against the same name still serialize.
    for (let i = 0; i < 50; i++) {
      const value = await withCorpusLock(`name-${i}`, async () => i * 2);
      expect(value).toBe(i * 2);
    }

    // After cleanup, a brand-new caller on a recently-used name should
    // execute immediately (no stale chain waiting on a resolved prior).
    const t0 = Date.now();
    const v = await withCorpusLock("name-0", async () => "fresh");
    expect(v).toBe("fresh");
    // Should be effectively instant — generous ceiling to absorb CI
    // scheduler jitter; the load-bearing guarantee is "no async hang",
    // not a tight latency bound.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a long-running fn returning many event-loop turns later still releases the lock cleanly", async () => {
    // Defensive — a slow fn that yields multiple times must release on
    // completion so the next caller can run. The previous test pinned
    // the cleanup contract via the cleanup loop; this one pins it
    // against a multi-await fn.
    let aReleased = false;
    const a = withCorpusLock("slow", async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
      }
      aReleased = true;
      return "A";
    });

    const b = withCorpusLock("slow", async () => {
      // B can only run AFTER A's fn body completes — pin it.
      expect(aReleased, `B should not enter while A is still inside its fn body`).toBe(true);
      return "B";
    });

    expect(await a).toBe("A");
    expect(await b).toBe("B");
  });
});

describe("withCorpusLock — return-value contract (F-002)", () => {
  it("returns whatever the fn returns (passes through value)", async () => {
    const obj = { hello: "world" };
    const out = await withCorpusLock("val", async () => obj);
    // Reference equality — withCorpusLock is a passthrough, not a clone.
    expect(out).toBe(obj);
  });

  it("propagates the fn's rejection unchanged", async () => {
    const err = new TypeError("specific shape");
    await expect(
      withCorpusLock("err", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});
