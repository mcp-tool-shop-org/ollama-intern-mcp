/**
 * loadCloudConfig — opt-in cloud configuration + fail-fast validation.
 *
 * Cloud is OFF unless OLLAMA_CLOUD_PRIMARY is truthy AND OLLAMA_API_KEY is set.
 * Tests pass a synthetic env object (never mutate process.env).
 */

import { describe, it, expect } from "vitest";
import { loadCloudConfig, OLLAMA_MODEL_NAME_RE } from "../src/profiles.js";
import { InternError } from "../src/errors.js";

const KEY = { OLLAMA_API_KEY: "sk-test-123" };

describe("loadCloudConfig — gating", () => {
  it("returns null when OLLAMA_CLOUD_PRIMARY is unset (default = local-only, zero egress)", () => {
    expect(loadCloudConfig({})).toBeNull();
    expect(loadCloudConfig({ ...KEY })).toBeNull(); // a key alone does NOT enable cloud
  });

  it("returns null when OLLAMA_CLOUD_PRIMARY is falsy", () => {
    expect(loadCloudConfig({ OLLAMA_CLOUD_PRIMARY: "0", ...KEY })).toBeNull();
    expect(loadCloudConfig({ OLLAMA_CLOUD_PRIMARY: "false", ...KEY })).toBeNull();
    expect(loadCloudConfig({ OLLAMA_CLOUD_PRIMARY: "", ...KEY })).toBeNull();
  });

  it("enables on truthy variants", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) {
      expect(loadCloudConfig({ OLLAMA_CLOUD_PRIMARY: v, ...KEY })).not.toBeNull();
    }
  });

  it("fails fast with CONFIG_INVALID when enabled but no API key", () => {
    let caught: unknown;
    try {
      loadCloudConfig({ OLLAMA_CLOUD_PRIMARY: "1" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InternError);
    expect((caught as InternError).code).toBe("CONFIG_INVALID");
    expect((caught as InternError).hint).toMatch(/OLLAMA_API_KEY/);
  });
});

describe("loadCloudConfig — defaults", () => {
  it("uses qwen3-coder-next:cloud (non-thinking) across generative tiers, ollama.com host, 32768 num_ctx", () => {
    const cfg = loadCloudConfig({ OLLAMA_CLOUD_PRIMARY: "1", ...KEY })!;
    expect(cfg.host).toBe("https://ollama.com");
    expect(cfg.apiKey).toBe("sk-test-123");
    expect(cfg.tiers.instant).toBe("qwen3-coder-next:cloud");
    expect(cfg.tiers.workhorse).toBe("qwen3-coder-next:cloud");
    expect(cfg.tiers.deep).toBe("qwen3-coder-next:cloud");
    expect(cfg.tiers.embed).toBe("nomic-embed-text");
    expect(cfg.numCtx).toBe(32_768);
    expect(cfg.timeouts).toEqual({ instant: 30_000, workhorse: 120_000, deep: 300_000, embed: 10_000 });
  });
});

describe("loadCloudConfig — overrides", () => {
  it("honors INTERN_CLOUD_DEEP_MODEL for the deep tier only", () => {
    const cfg = loadCloudConfig({
      OLLAMA_CLOUD_PRIMARY: "1",
      ...KEY,
      INTERN_CLOUD_DEEP_MODEL: "deepseek-v3.1:671b",
    })!;
    expect(cfg.tiers.instant).toBe("qwen3-coder-next:cloud");
    expect(cfg.tiers.deep).toBe("deepseek-v3.1:671b");
  });

  it("honors INTERN_CLOUD_MODEL, OLLAMA_CLOUD_HOST, and timeout/num_ctx overrides", () => {
    const cfg = loadCloudConfig({
      OLLAMA_CLOUD_PRIMARY: "1",
      ...KEY,
      INTERN_CLOUD_MODEL: "gpt-oss:120b",
      OLLAMA_CLOUD_HOST: "https://ollama.example.com/",
      INTERN_CLOUD_TIMEOUT_DEEP_MS: "600000",
      INTERN_CLOUD_NUM_CTX: "65536",
    })!;
    expect(cfg.tiers.instant).toBe("gpt-oss:120b");
    expect(cfg.host).toBe("https://ollama.example.com"); // trailing slash stripped
    expect(cfg.timeouts.deep).toBe(600_000);
    expect(cfg.numCtx).toBe(65_536);
  });

  it("rejects a malformed cloud model name with CONFIG_INVALID", () => {
    expect(() =>
      loadCloudConfig({ OLLAMA_CLOUD_PRIMARY: "1", ...KEY, INTERN_CLOUD_MODEL: "Bad Model Name!" }),
    ).toThrow(InternError);
  });
});

describe("OLLAMA_MODEL_NAME_RE — accepts cloud identifiers", () => {
  it("passes the cloud model ids we route to", () => {
    for (const id of [
      "minimax-m3:cloud",
      "minimax-m2.7:cloud",
      "deepseek-v3.1:671b",
      "deepseek-v3.1:671b-cloud",
      "qwen3-coder:480b-cloud",
      "gpt-oss:120b",
      "gpt-oss:120b-cloud",
      "glm-4.6:cloud",
    ]) {
      expect(OLLAMA_MODEL_NAME_RE.test(id), id).toBe(true);
    }
  });
});
