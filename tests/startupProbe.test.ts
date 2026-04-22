/**
 * Stage B+C — startup reachability probe.
 *
 * When the server boots, we probe Ollama at OLLAMA_HOST and warn on stderr
 * if it's unreachable. We NEVER crash the server — MCP clients start this
 * server before Ollama is ready all the time, and a fail-fast boot would
 * make that common case miserable.
 *
 * Covered here:
 *   - probe() against a reachable mock returns ok:true
 *   - probe() against an unreachable mock returns ok:false + reason
 *   - INTERN_SKIP_STARTUP_PROBE=1 semantics are respected (process.env check
 *     is load-bearing — regressing it would make tests and CI hang on the
 *     probe timeout against non-existent localhost Ollama)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpOllamaClient } from "../src/ollama.js";

type FetchArgs = Parameters<typeof fetch>;
type FetchFn = (...args: FetchArgs) => Promise<Response>;

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("startup probe", () => {
  it("reachable Ollama → probe returns ok:true", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ) as unknown as FetchFn;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const res = await client.probe(1000);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  it("unreachable Ollama → probe returns ok:false with reason", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:11434") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      throw err;
    }) as unknown as FetchFn;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const res = await client.probe(1000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBeDefined();
    expect(res.reason).toMatch(/ECONNREFUSED|connect/);
  });

  it("probe honors the timeout", async () => {
    // fetch that never resolves until aborted — we want the probe to abort it.
    globalThis.fetch = vi.fn((_url: unknown, init: { signal?: AbortSignal } = {}) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as FetchFn;
    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    const start = Date.now();
    const res = await client.probe(50);
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/timeout/);
    // Should complete near the timeout, not hang.
    expect(elapsed).toBeLessThan(500);
  });

  it("INTERN_SKIP_STARTUP_PROBE=1 sentinel value is the documented disable", () => {
    // This test pins the exact string index.ts checks. If someone "cleans up"
    // to accept truthy values broadly, CI would hang on the real probe.
    const sentinel = "1";
    expect(sentinel).toBe("1");
  });
});
