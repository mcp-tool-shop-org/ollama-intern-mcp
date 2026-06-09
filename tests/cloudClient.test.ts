/**
 * Cloud-capable HttpOllamaClient — auth header + cloud-aware residency/probe.
 *
 * The same HttpOllamaClient class serves both local and cloud backends. When
 * constructed with { apiKey, kind: 'cloud', baseUrl: 'https://ollama.com' } it:
 *   - attaches `Authorization: Bearer <key>` to every request,
 *   - reports residency() as null (no /api/ps on the stateless cloud host),
 *   - probes /api/tags instead of /api/ps,
 *   - maps 401/403 to OLLAMA_AUTH_FAILED (distinct from transient failures).
 *
 * Critical footgun guard: a Bearer key must NOT be sent to a loopback host —
 * local Ollama 403s on an auth header.
 *
 * We mock global fetch so the real header/path logic runs without a network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpOllamaClient, isLoopbackHost } from "../src/ollama.js";
import { InternError } from "../src/errors.js";

type FetchArgs = Parameters<typeof fetch>;
type FetchFn = (...args: FetchArgs) => Promise<Response>;

const origFetch = globalThis.fetch;
const CLOUD = "https://ollama.com";

afterEach(() => {
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

/** Pull the headers object off the Nth recorded fetch call's init arg. */
function headersOf(mock: unknown, n = 0): Record<string, string> {
  const calls = (mock as { mock: { calls: FetchArgs[] } }).mock.calls;
  const init = calls[n]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

function urlOf(mock: unknown, n = 0): string {
  const calls = (mock as { mock: { calls: FetchArgs[] } }).mock.calls;
  return String(calls[n]?.[0]);
}

describe("HttpOllamaClient — cloud auth", () => {
  it("attaches Authorization: Bearer to a cloud generate", async () => {
    const mock = vi.fn(async () =>
      jsonResponse({ model: "minimax-m3:cloud", response: "ok", done: true }),
    ) as unknown as FetchFn;
    globalThis.fetch = mock;

    const client = new HttpOllamaClient({ baseUrl: CLOUD, apiKey: "sk-test-123", kind: "cloud" });
    await client.generate({ model: "minimax-m3:cloud", prompt: "hi" });

    expect(headersOf(mock).Authorization).toBe("Bearer sk-test-123");
    expect(urlOf(mock)).toBe("https://ollama.com/api/generate");
  });

  it("a local client (no apiKey) sends NO Authorization header", async () => {
    const mock = vi.fn(async () =>
      jsonResponse({ model: "hermes3:8b", response: "ok", done: true }),
    ) as unknown as FetchFn;
    globalThis.fetch = mock;

    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    await client.generate({ model: "hermes3:8b", prompt: "hi" });

    expect(headersOf(mock).Authorization).toBeUndefined();
  });

  it("NEVER sends the key to a loopback host even when apiKey is set (403 footgun)", async () => {
    const mock = vi.fn(async () =>
      jsonResponse({ model: "hermes3:8b", response: "ok", done: true }),
    ) as unknown as FetchFn;
    globalThis.fetch = mock;

    // apiKey supplied but host is loopback — header must be stripped.
    const client = new HttpOllamaClient({ baseUrl: "http://127.0.0.1:11434", apiKey: "sk-leak" });
    await client.generate({ model: "hermes3:8b", prompt: "hi" });

    expect(headersOf(mock).Authorization).toBeUndefined();
  });
});

describe("HttpOllamaClient — cloud residency / probe", () => {
  it("residency() returns null for a cloud client without hitting the network", async () => {
    const mock = vi.fn(async () => {
      throw new Error("fetch should not be called for cloud residency");
    }) as unknown as FetchFn;
    globalThis.fetch = mock;

    const client = new HttpOllamaClient({ baseUrl: CLOUD, apiKey: "sk", kind: "cloud" });
    const residency = await client.residency("minimax-m3:cloud");

    expect(residency).toBeNull();
    expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  it("probe() hits /api/tags (not /api/ps) for a cloud client, with auth", async () => {
    const mock = vi.fn(async () => jsonResponse({ models: [] })) as unknown as FetchFn;
    globalThis.fetch = mock;

    const client = new HttpOllamaClient({ baseUrl: CLOUD, apiKey: "sk-test", kind: "cloud" });
    const res = await client.probe(1000);

    expect(res.ok).toBe(true);
    expect(urlOf(mock)).toBe("https://ollama.com/api/tags");
    expect(headersOf(mock).Authorization).toBe("Bearer sk-test");
  });

  it("local probe() still hits /api/ps", async () => {
    const mock = vi.fn(async () => jsonResponse({ models: [] })) as unknown as FetchFn;
    globalThis.fetch = mock;

    const client = new HttpOllamaClient("http://127.0.0.1:11434");
    await client.probe(1000);

    expect(urlOf(mock)).toBe("http://127.0.0.1:11434/api/ps");
  });
});

describe("HttpOllamaClient — auth error mapping", () => {
  for (const status of [401, 403]) {
    it(`maps ${status} to OLLAMA_AUTH_FAILED (definitive, single attempt)`, async () => {
      const mock = vi.fn(async () => errorResponse(status, "unauthorized")) as unknown as FetchFn;
      globalThis.fetch = mock;

      const client = new HttpOllamaClient({ baseUrl: CLOUD, apiKey: "bad-key", kind: "cloud" });
      let caught: unknown;
      try {
        await client.generate({ model: "minimax-m3:cloud", prompt: "hi" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InternError);
      expect((caught as InternError).code).toBe("OLLAMA_AUTH_FAILED");
      expect((caught as InternError).retryable).toBe(false);
      // Definitive — no retry ladder.
      expect((mock as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    });
  }
});

describe("isLoopbackHost", () => {
  it("recognizes loopback forms and treats remote/unparseable as non-loopback", () => {
    expect(isLoopbackHost("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackHost("http://localhost:11434")).toBe(true);
    expect(isLoopbackHost("https://ollama.com")).toBe(false);
    expect(isLoopbackHost("not a url")).toBe(false);
  });
});
