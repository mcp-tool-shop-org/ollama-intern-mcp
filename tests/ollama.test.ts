import { describe, it, expect } from "vitest";
import { normalizeOllamaHost } from "../src/ollama.js";
import { InternError } from "../src/errors.js";

describe("normalizeOllamaHost", () => {
  it("defaults to http://127.0.0.1:11434 when env is empty", () => {
    expect(normalizeOllamaHost(undefined)).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaHost("")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaHost("   ")).toBe("http://127.0.0.1:11434");
  });

  it("adds http:// when scheme is missing (Ollama CLI-style host:port)", () => {
    expect(normalizeOllamaHost("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaHost("localhost:11434")).toBe("http://localhost:11434");
    expect(normalizeOllamaHost("remote-box:9999")).toBe("http://remote-box:9999");
  });

  it("preserves http:// and https:// schemes", () => {
    expect(normalizeOllamaHost("http://foo:1234")).toBe("http://foo:1234");
    expect(normalizeOllamaHost("https://foo:1234")).toBe("https://foo:1234");
    expect(normalizeOllamaHost("HTTP://foo:1234")).toBe("HTTP://foo:1234");
  });

  it("strips trailing slashes", () => {
    expect(normalizeOllamaHost("127.0.0.1:11434/")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaHost("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
  });

  it("rejects an out-of-range port with CONFIG_INVALID", () => {
    // 70000 > 65535 — deep in fetch() this surfaced as "Failed to reach
    // Ollama"; we'd rather fail loud at startup with a clear hint.
    let caught: unknown;
    try {
      normalizeOllamaHost("http://127.0.0.1:70000");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect((caught as InternError).code).toBe("CONFIG_INVALID");
    expect((caught as InternError).hint).toMatch(/1 and 65535|OLLAMA_HOST/);
  });

  it("rejects a zero port with CONFIG_INVALID", () => {
    expect(() => normalizeOllamaHost("http://127.0.0.1:0")).toThrow(InternError);
  });

  it("accepts a port at the high boundary (65535)", () => {
    expect(normalizeOllamaHost("http://127.0.0.1:65535")).toBe("http://127.0.0.1:65535");
  });

  it("accepts a URL with no explicit port (defaults to scheme default)", () => {
    // No port on the URL — URL.port === "" and we skip validation.
    expect(normalizeOllamaHost("http://foo")).toBe("http://foo");
  });
});
