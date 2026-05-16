/**
 * Shared OllamaClient stub factory — replaces the 43-copy hand-rolled
 * MockClient pattern (FT-003 / Phase 7).
 *
 * Migration motivation: before this helper, every test file declared its
 * own `class MockClient implements OllamaClient` with subtly different
 * stub shapes. Any interface change on `OllamaClient` (e.g. the `tier`
 * parameter added in Stage C / F-004) had to be propagated across 43
 * files. With the factory, future interface changes touch ONE file.
 *
 * Design:
 *   - One factory `createFakeOllama(options)` returning a fully-typed
 *     `OllamaClient`. Defaults are reasonable for happy-path tests.
 *   - Per-method overrides via `generateImpl` / `chatImpl` / `embedImpl`
 *     callbacks. Tests that need to capture a request body assign their
 *     own callback; the factory threads it through.
 *   - `lastGenerate` / `lastChat` / `lastEmbed` properties on the
 *     returned object let tests inspect the most-recent call without
 *     wiring a callback. Matches the prevailing inspection pattern in
 *     existing tests.
 *   - `residencyImpl` lets tests assert eviction/probe-failure paths.
 *     Default is a healthy in-VRAM residency response.
 *
 * NOT migrated: tests that need bespoke control flow (e.g. semaphore
 * race tests, retry-with-throw-then-recover) keep their custom stubs.
 * The helper covers the simple "return canned response" case.
 */

import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "../../src/ollama.js";
import type { Residency } from "../../src/envelope.js";
import type { Tier } from "../../src/tiers.js";

export interface FakeOllamaOptions {
  /** Raw string the default `generate` returns. JSON-stringify before passing if needed. */
  defaultGenerateResponse?: string;
  /** Default token counts the canned generate returns. */
  defaultTokens?: { in: number; out: number };
  /** Override the entire generate path. */
  generateImpl?: (req: GenerateRequest, signal?: AbortSignal, tier?: Tier) => Promise<GenerateResponse>;
  /** Override the entire chat path. */
  chatImpl?: (req: ChatRequest, signal?: AbortSignal, tier?: Tier) => Promise<ChatResponse>;
  /** Override the entire embed path. */
  embedImpl?: (req: EmbedRequest, signal?: AbortSignal, tier?: Tier) => Promise<EmbedResponse>;
  /** Override the residency probe. Default is healthy (in_vram=true). */
  residencyImpl?: (model: string) => Promise<Residency | null>;
  /** Override the reachability probe. Default returns ok:true. */
  probeImpl?: (timeoutMs?: number) => Promise<{ ok: boolean; reason?: string }>;
  /**
   * When `generateImpl` is NOT supplied, the default factory throws this
   * error from `chat` and `embed` instead of the default "not used" message.
   * Match the legacy MockClient behavior where unused methods threw to
   * surface accidental wiring.
   */
  errorOnUnused?: boolean;
}

export interface FakeOllamaClient extends OllamaClient {
  /** Most recent GenerateRequest passed to `generate`. */
  lastGenerate?: GenerateRequest;
  /** Most recent ChatRequest passed to `chat`. */
  lastChat?: ChatRequest;
  /** Most recent EmbedRequest passed to `embed`. */
  lastEmbed?: EmbedRequest;
  /** Count of generate / chat / embed calls. */
  callCount: { generate: number; chat: number; embed: number };
}

const DEFAULT_TOKENS = { in: 50, out: 10 };
const DEFAULT_RESIDENCY: Residency = {
  in_vram: true,
  size_bytes: 100,
  size_vram_bytes: 100,
  evicted: false,
  expires_at: null,
};

export function createFakeOllama(options: FakeOllamaOptions = {}): FakeOllamaClient {
  const errorOnUnused = options.errorOnUnused ?? true;
  const tokens = options.defaultTokens ?? DEFAULT_TOKENS;
  const defaultResponse = options.defaultGenerateResponse ?? '{"ok":true}';

  const state: FakeOllamaClient = {
    callCount: { generate: 0, chat: 0, embed: 0 },
    async generate(req, signal, tier) {
      state.callCount.generate += 1;
      state.lastGenerate = req;
      if (options.generateImpl) return options.generateImpl(req, signal, tier);
      return {
        model: req.model,
        response: defaultResponse,
        done: true,
        prompt_eval_count: tokens.in,
        eval_count: tokens.out,
      };
    },
    async chat(req, signal, tier) {
      state.callCount.chat += 1;
      state.lastChat = req;
      if (options.chatImpl) return options.chatImpl(req, signal, tier);
      if (errorOnUnused) throw new Error("FakeOllama.chat not configured for this test (pass chatImpl)");
      return {
        model: req.model,
        message: { role: "assistant", content: defaultResponse },
        done: true,
        prompt_eval_count: tokens.in,
        eval_count: tokens.out,
      };
    },
    async embed(req, signal, tier) {
      state.callCount.embed += 1;
      state.lastEmbed = req;
      if (options.embedImpl) return options.embedImpl(req, signal, tier);
      if (errorOnUnused) throw new Error("FakeOllama.embed not configured for this test (pass embedImpl)");
      // Default to a single 3-dim vector per input — minimum-viable shape.
      const inputs = Array.isArray(req.input) ? req.input : [req.input];
      return {
        model: req.model,
        embeddings: inputs.map(() => [0.1, 0.2, 0.3]),
      };
    },
    async residency(model) {
      if (options.residencyImpl) return options.residencyImpl(model);
      return { ...DEFAULT_RESIDENCY };
    },
    async probe(timeoutMs) {
      if (options.probeImpl) return options.probeImpl(timeoutMs);
      return { ok: true };
    },
  };
  return state;
}
