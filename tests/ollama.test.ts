import { describe, it, expect } from "vitest";
import { normalizeOllamaHost } from "../src/ollama.js";

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
});
