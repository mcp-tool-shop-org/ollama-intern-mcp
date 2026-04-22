/**
 * Stage B+C — retry with backoff for transient Ollama failures.
 *
 * HttpOllamaClient's post path now retries up to 3× on transient errors
 * (5xx, 429, connection reset). 4xx (except 429) fail fast. AbortError
 * (tier timeout) fails fast.
 *
 * We mock global fetch so we can exercise the real retry logic without
 * requiring Ollama to be up, and we stamp backoff down to 0ms so the
 * tests don't sleep the full 200+400+800 ladder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpOllamaClient, setTestBackoff, __retryInternals } from "../src/ollama.js";
import { InternError } from "../src/errors.js";

type FetchArgs = Parameters<typeof fetch>;
type FetchFn = (...args: FetchArgs) => Promise<Response>;

const origFetch = globalThis.fetch;

beforeEach(() => {
  setTestBackoff(0);
});

afterEach(() => {
  setTestBackoff(null);
  globalThis.fetch = origFetch;
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function errorResponse(status: number, body: string = ""): Response {
  return new Response(body, { status });
}

describe("HttpOllamaClient — retry with backoff", () => {
  it("retries a 503 twice then succeeds on attempt 3", async () => {
    const calls: number[] = [];
    const responses: Response[] = [
      errorResponse(503, "overloaded"),
      errorResponse(503, "overloaded"),
      jsonResponse({ model: "m", response: "ok", done: true }),
    ];
    const mock = vi.fn(async () => {
      calls.push(Date.now());
      return responses.shift()!;
    }) as unknown as FetchFn;
    globalThis.fetch = mock;

    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const result = await client.generate({ model: "m", prompt: "hi" });
    expect(result.response).toBe("ok");
    expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
  });

  it("retries a 429 (rate limit) as transient", async () => {
    const responses: Response[] = [
      errorResponse(429, "slow down"),
      jsonResponse({ model: "m", response: "ok", done: true }),
    ];
    const mock = vi.fn(async () => responses.shift()!) as unknown as FetchFn;
    globalThis.fetch = mock;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const result = await client.generate({ model: "m", prompt: "hi" });
    expect(result.response).toBe("ok");
    expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("throws OLLAMA_UNREACHABLE with retry count in hint after 3 failed attempts", async () => {
    const mock = vi.fn(async () => errorResponse(503, "overloaded")) as unknown as FetchFn;
    globalThis.fetch = mock;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");

    let caught: unknown;
    try {
      await client.generate({ model: "m", prompt: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    const err = caught as InternError;
    expect(err.code).toBe("OLLAMA_UNREACHABLE");
    expect(err.hint).toMatch(/Retried 3. with backoff/);
    expect(err.hint.toLowerCase()).toContain("ollama unreachable");
    expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(3);
  });

  it("does NOT retry a 404 (model missing — definitive 4xx)", async () => {
    const mock = vi.fn(async () => errorResponse(404, "model not found")) as unknown as FetchFn;
    globalThis.fetch = mock;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");

    let caught: unknown;
    try {
      await client.generate({ model: "nope", prompt: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect((caught as InternError).code).toBe("OLLAMA_MODEL_MISSING");
    expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("does NOT retry a 400 (definitive 4xx other than 429)", async () => {
    const mock = vi.fn(async () => errorResponse(400, "bad request")) as unknown as FetchFn;
    globalThis.fetch = mock;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");

    let caught: unknown;
    try {
      await client.generate({ model: "m", prompt: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    // Only 1 call — no retry on definitive 4xx.
    expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("retries a connection reset (ECONNRESET)", async () => {
    let attempts = 0;
    const mock = vi.fn(async () => {
      attempts++;
      if (attempts < 3) {
        const err = new Error("socket hang up") as NodeJS.ErrnoException;
        err.code = "ECONNRESET";
        throw err;
      }
      return jsonResponse({ model: "m", response: "ok", done: true });
    }) as unknown as FetchFn;
    globalThis.fetch = mock;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const result = await client.generate({ model: "m", prompt: "hi" });
    expect(result.response).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("does not retry on AbortError (tier timeout fired)", async () => {
    const mock = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as FetchFn;
    globalThis.fetch = mock;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");

    let caught: unknown;
    try {
      await client.generate({ model: "m", prompt: "hi" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect((caught as InternError).code).toBe("OLLAMA_TIMEOUT");
    // No retry — AbortError is definitive.
    expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });
});

describe("HttpOllamaClient.probe — startup reachability probe", () => {
  it("returns ok:true when /api/ps responds 200", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ models: [] })) as unknown as FetchFn;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const res = await client.probe(500);
    expect(res.ok).toBe(true);
  });

  it("returns ok:false with reason on network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      throw err;
    }) as unknown as FetchFn;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const res = await client.probe(500);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/ECONNREFUSED|connect/);
  });

  it("returns ok:false on non-2xx HTTP response", async () => {
    globalThis.fetch = vi.fn(async () => errorResponse(500, "boom")) as unknown as FetchFn;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const res = await client.probe(500);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/500/);
  });
});

describe("backoff internals — deterministic bounds", () => {
  it("backoffDelayMs respects base delays (±20% jitter)", () => {
    for (let i = 0; i < 20; i++) {
      const d0 = __retryInternals.backoffDelayMs(0);
      const d1 = __retryInternals.backoffDelayMs(1);
      const d2 = __retryInternals.backoffDelayMs(2);
      expect(d0).toBeGreaterThanOrEqual(160); // 200 - 20%
      expect(d0).toBeLessThanOrEqual(240); // 200 + 20%
      expect(d1).toBeGreaterThanOrEqual(320);
      expect(d1).toBeLessThanOrEqual(480);
      expect(d2).toBeGreaterThanOrEqual(640);
      expect(d2).toBeLessThanOrEqual(960);
    }
  });

  it("backoffDelayMs returns 0 jitter when jitterPct=0 (deterministic)", () => {
    expect(__retryInternals.backoffDelayMs(0, 0)).toBe(200);
    expect(__retryInternals.backoffDelayMs(1, 0)).toBe(400);
    expect(__retryInternals.backoffDelayMs(2, 0)).toBe(800);
  });
});
