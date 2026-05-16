/**
 * Shared test fixtures — RunContext factories, in-memory loggers, etc.
 *
 * Built alongside `fakeOllama.ts` (FT-003) to remove the per-file
 * RunContext+MockClient boilerplate from the ~43 tests that depend on it.
 *
 * Naming: `makeFakeCtx` is the equivalent of the per-file `makeCtx` —
 * accepts a client (or builds one from defaults) and a logger (or builds
 * a NullLogger by default). Returns a RunContext whose `.logger` is
 * typed as NullLogger so tests can introspect `.events` without casting.
 */

import { PROFILES, type ProfileName } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
import type { OllamaClient } from "../../src/ollama.js";
import type { RunContext } from "../../src/runContext.js";
import { createFakeOllama, type FakeOllamaOptions } from "./fakeOllama.js";

export interface MakeFakeCtxOptions {
  /** Override the client. If absent, a default fake is built. */
  client?: OllamaClient;
  /** Profile to drive tier/timeout/hardware-profile defaults. Defaults to dev-rtx5080. */
  profile?: ProfileName;
  /** If `client` is absent, these forward to createFakeOllama. */
  fakeOptions?: FakeOllamaOptions;
}

/**
 * Build a RunContext for tests. Caller can override the client, profile,
 * or pass fakeOptions; we always return a NullLogger so tests can
 * introspect `.events` directly.
 */
export function makeFakeCtx(
  options: MakeFakeCtxOptions = {},
): RunContext & { logger: NullLogger } {
  const profile = options.profile ?? "dev-rtx5080";
  const client = options.client ?? createFakeOllama(options.fakeOptions);
  return {
    client,
    tiers: PROFILES[profile].tiers,
    timeouts: PROFILES[profile].timeouts,
    hardwareProfile: profile,
    logger: new NullLogger(),
  };
}

/** Frequently used probe — pre-configured for testing the dev-rtx5080 instant tier. */
export const FIXTURE_TIER_INSTANT_MODEL = PROFILES["dev-rtx5080"].tiers.instant;
export const FIXTURE_TIER_WORKHORSE_MODEL = PROFILES["dev-rtx5080"].tiers.workhorse;
export const FIXTURE_TIER_DEEP_MODEL = PROFILES["dev-rtx5080"].tiers.deep;

/**
 * Sample envelope for tests that need to construct a `LogEvent` of
 * kind:'call' without touching a real handler.
 */
export function sampleEnvelope() {
  return {
    result: { ok: true },
    tier_used: "instant" as const,
    model: FIXTURE_TIER_INSTANT_MODEL,
    hardware_profile: "dev-rtx5080",
    tokens_in: 5,
    tokens_out: 3,
    elapsed_ms: 12,
    residency: null,
  };
}
