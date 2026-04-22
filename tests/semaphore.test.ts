import { describe, it, expect } from "vitest";
import { Semaphore, parseConcurrency } from "../src/semaphore.js";
import { InternError } from "../src/errors.js";

describe("Semaphore wait estimation (out-of-order release)", () => {
  it("tracks per-ticket start times so out-of-order release preserves the oldest marker", async () => {
    const sem = new Semaphore(3);

    // Acquire three at spaced-out times so we can assert on the oldest.
    const release1 = await sem.acquire();
    const t1 = Date.now();

    await new Promise((r) => setTimeout(r, 10));
    const release2 = await sem.acquire();

    await new Promise((r) => setTimeout(r, 10));
    const release3 = await sem.acquire();

    // Release OUT OF ORDER — the most-recently acquired holder finishes first.
    // Under the old FIFO-array implementation this would drop the marker for
    // holder 1 (the oldest), collapsing `expected_wait_ms` to the age of
    // holder 2 and understating the real wait.
    release3();

    const snap = sem.snapshot();
    expect(snap.in_flight).toBe(2);
    // Oldest remaining holder is still release1 (from t1) — expected_wait_ms
    // must reflect that, not the age of holder 2.
    const elapsedSinceT1 = Date.now() - t1;
    expect(snap.expected_wait_ms).toBeGreaterThanOrEqual(10);
    expect(snap.expected_wait_ms).toBeLessThanOrEqual(elapsedSinceT1 + 50);

    // Now release the middle holder — oldest remaining is still release1.
    release2();
    const snap2 = sem.snapshot();
    expect(snap2.in_flight).toBe(1);
    expect(snap2.expected_wait_ms).toBeGreaterThanOrEqual(10);

    // Release the oldest — now no in-flight, expected_wait_ms is 0.
    release1();
    const snap3 = sem.snapshot();
    expect(snap3.in_flight).toBe(0);
    expect(snap3.expected_wait_ms).toBe(0);
  });

  it("permit accounting remains correct after many out-of-order releases", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.wouldBlock).toBe(true);

    // Release in reverse order a few times.
    r2();
    expect(sem.wouldBlock).toBe(false);
    r1();
    expect(sem.wouldBlock).toBe(false);

    // Re-acquire twice, should succeed immediately.
    const r3 = await sem.acquire();
    const r4 = await sem.acquire();
    expect(sem.wouldBlock).toBe(true);
    r3();
    r4();
    expect(sem.wouldBlock).toBe(false);
  });
});

describe("parseConcurrency", () => {
  it("returns 2 by default when unset", () => {
    expect(parseConcurrency(undefined)).toBe(2);
  });

  it("accepts a positive integer string", () => {
    expect(parseConcurrency("4")).toBe(4);
    expect(parseConcurrency("1")).toBe(1);
  });

  it("rejects NaN (non-numeric) with CONFIG_INVALID", () => {
    let caught: unknown;
    try {
      parseConcurrency("abc");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    const err = caught as InternError;
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.hint).toContain("INTERN_MAX_CONCURRENT");
    expect(err.hint).toContain("abc");
  });

  it("rejects zero and negative values", () => {
    expect(() => parseConcurrency("0")).toThrow(InternError);
    expect(() => parseConcurrency("-1")).toThrow(InternError);
  });

  it("rejects non-integer numerics", () => {
    expect(() => parseConcurrency("1.5")).toThrow(InternError);
  });

  it("rejects empty string", () => {
    expect(() => parseConcurrency("")).toThrow(InternError);
  });
});
