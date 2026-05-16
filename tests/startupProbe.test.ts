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
    // Should complete bounded, not hang. Ceiling widened from 500 to 2000ms:
    // a busy Windows runner can spike 600-800ms even on a 50ms probe due
    // to GC/scheduler jitter, and the load-bearing regression this guards
    // is "probe hung indefinitely" (15s+) — not "probe took 600ms instead
    // of 50ms". The 2000 ceiling still catches the real hang.
    expect(elapsed).toBeLessThan(2000);
  });

  // INTERN_SKIP_STARTUP_PROBE — the load-bearing string check.
  //
  // The previous test here was `const sentinel = "1"; expect(sentinel).toBe("1")`,
  // a pure tautology that imported nothing from src/index.ts and provided
  // zero coverage of the actual env-var path at src/index.ts:477. If
  // someone "cleaned up" that string check to accept truthy values
  // broadly (e.g. `if (process.env.INTERN_SKIP_STARTUP_PROBE)`), CI
  // would silently start hanging on the real probe against unreachable
  // localhost Ollama in environments that set the var to "0" / "false".
  //
  // Replace with grep against the source to lock the exact comparison
  // shape — fast, deterministic, and catches the regression without
  // spawning a subprocess.
  it("INTERN_SKIP_STARTUP_PROBE=1 is the documented disable string in src/index.ts", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("../src/index.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");
    // Two assertions: (1) the env var is referenced, (2) the check
    // compares strictly against the literal "1" — not a truthy check
    // and not against any other sentinel.
    expect(src).toContain("INTERN_SKIP_STARTUP_PROBE");
    expect(src).toMatch(/process\.env\.INTERN_SKIP_STARTUP_PROBE\s*!==?\s*["']1["']/);
  });
});
