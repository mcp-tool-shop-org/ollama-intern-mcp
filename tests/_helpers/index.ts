/**
 * Shared test helpers — fake OllamaClient + RunContext fixtures.
 *
 * MIGRATION PATTERN (FT-003 / Phase 7) — replacing the per-file MockClient
 * boilerplate that exists in ~43 test files.
 *
 * BEFORE (per-file boilerplate, ~30 lines):
 * ```ts
 * import type {
 *   OllamaClient, GenerateRequest, GenerateResponse,
 *   ChatRequest, ChatResponse, EmbedRequest, EmbedResponse,
 * } from "../../src/ollama.js";
 * import type { Residency } from "../../src/envelope.js";
 * import type { RunContext } from "../../src/runContext.js";
 * import { PROFILES } from "../../src/profiles.js";
 * import { NullLogger } from "../../src/observability.js";
 *
 * class MockClient implements OllamaClient {
 *   public lastGenerate?: GenerateRequest;
 *   constructor(private raw: string, private tokens = { in: 50, out: 10 }) {}
 *   async generate(req: GenerateRequest): Promise<GenerateResponse> {
 *     this.lastGenerate = req;
 *     return { model: req.model, response: this.raw, done: true,
 *              prompt_eval_count: this.tokens.in, eval_count: this.tokens.out };
 *   }
 *   async chat(_req: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
 *   async embed(_req: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
 *   async residency(_model: string): Promise<Residency | null> {
 *     return { in_vram: true, size_bytes: 100, size_vram_bytes: 100, evicted: false, expires_at: null };
 *   }
 * }
 *
 * function makeCtx(client: OllamaClient): RunContext & { logger: NullLogger } {
 *   return { client, tiers: PROFILES["dev-rtx5080"].tiers,
 *            timeouts: PROFILES["dev-rtx5080"].timeouts,
 *            hardwareProfile: "dev-rtx5080", logger: new NullLogger() };
 * }
 * ```
 *
 * AFTER (3 lines):
 * ```ts
 * import { createFakeOllama, makeFakeCtx } from "../_helpers/index.js";
 *
 * const client = createFakeOllama({ defaultGenerateResponse: JSON.stringify({ label: "fix", confidence: 0.9 }) });
 * const ctx = makeFakeCtx({ client });
 * ```
 *
 * To capture the last request: read `client.lastGenerate` / `lastChat` / `lastEmbed`.
 * To customize behavior: pass `generateImpl` / `chatImpl` / `embedImpl` callbacks.
 * To assert log events: `ctx.logger.events` (NullLogger preserved).
 *
 * Tests that need bespoke control flow (e.g. semaphore race conditions,
 * mid-call throw-then-recover) should KEEP their custom MockClient — the
 * factory is for the simple "return canned response" case.
 */

export { createFakeOllama, type FakeOllamaOptions, type FakeOllamaClient } from "./fakeOllama.js";
export {
  makeFakeCtx,
  sampleEnvelope,
  FIXTURE_TIER_INSTANT_MODEL,
  FIXTURE_TIER_WORKHORSE_MODEL,
  FIXTURE_TIER_DEEP_MODEL,
  type MakeFakeCtxOptions,
} from "./fixtures.js";
