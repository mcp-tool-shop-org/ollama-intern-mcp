/**
 * Uniform response envelope — every tool returns this shape.
 *
 * residency is populated from Ollama's /api/ps. When in_vram is false
 * or size_vram < size, the model paged to disk; inference drops 5–10×.
 * Surfacing it mechanically in every call is what prevents hand-wavy
 * performance claims when Ollama's eviction bug (#13227) strikes.
 */

import type { Tier } from "./tiers.js";
import { getRunContext } from "./runContext.js";

export interface Residency {
  in_vram: boolean;
  size_bytes: number;
  size_vram_bytes: number;
  evicted: boolean;
  expires_at: string | null;
}

export interface Envelope<T> {
  result: T;
  tier_used: Tier;
  model: string;
  /** Active hardware profile (e.g. "dev-rtx5080", "m5-max"). Lets bench/eval runs keep dev numbers out of publishable tables. */
  hardware_profile: string;
  tokens_in: number;
  tokens_out: number;
  elapsed_ms: number;
  residency: Residency | null;
  /** Set when a timeout fired and the server fell back to a cheaper tier. */
  fallback_from?: Tier;
  /**
   * Which backend served this call (cloud-primary mode only). ABSENT in the
   * default local-only path — so existing callers see no change. When present:
   * 'cloud' = served by Ollama Cloud; 'local' = served locally.
   */
  backend?: "cloud" | "local";
  /**
   * True when cloud was wanted but the call was served LOCALLY (cloud failed,
   * the circuit was open, or the key is misconfigured) — i.e. you got the
   * smaller local model instead of the big cloud one. Present only in
   * cloud-primary mode; surfaced so a worse answer is never silent.
   */
  degraded?: boolean;
  /**
   * Why the call degraded to local: cloud_timeout | cloud_5xx |
   * cloud_rate_limited | cloud_unreachable | cloud_auth_failed | circuit_open.
   * Present only when `degraded` is true.
   */
  degrade_reason?: string;
  /**
   * The model the CALLER asked for via input.model override. Present only
   * when override was supplied. Calibration-aware callers compare
   * model_requested vs model to detect fallback substitution.
   */
  model_requested?: string;
  /**
   * The `num_ctx` (Ollama context window, tokens) the MCP server EXPLICITLY
   * sent on the generate request — added v2.4.0. Present only when the
   * active profile's tier-level `num_ctx` was set for the calling tier
   * AND that value was actually placed in `options.num_ctx` on the wire.
   *
   * ABSENT means the request omitted `num_ctx` entirely, so Ollama used
   * its model-loaded default. Do NOT fake a value here — the MCP server
   * does not query Ollama for the effective context, and synthesizing a
   * default would silently mis-report what was actually sent. The "absent
   * when unset" contract is what preserves v2.3.0 backward-compat.
   */
  num_ctx_used?: number;
  /**
   * Server-minted correlation ID for this tool call (Phase 7 / FT-001).
   * Added v2.5.0 via the same Option A additive pattern as
   * `num_ctx_used`: PRESENT when the call ran inside an active
   * `withRunContext` scope (every MCP tool-call entry from index.ts
   * does this), ABSENT when no scope is active (startup paths, prewarm,
   * tests that don't wrap). Callers correlating envelope back to NDJSON
   * events join on this field — same value lands on every event line
   * via `runContext` lookup in `observability.ts` and `ollama.ts`.
   *
   * Format: `run_<ISO-date-with-hyphens>_<6-hex>` — see `mintRunId()`.
   * The "absent when unset" contract preserves v2.4.0 backward-compat
   * for callers that build envelopes outside a tool-call scope.
   */
  run_id?: string;
  /** Non-fatal warnings — e.g. "2 citations stripped (paths not in source_paths)". */
  warnings?: string[];
  /** Total items in the batch. Only set on batch-mode calls. */
  batch_count?: number;
  /** Items that returned {ok: true, result}. Only set on batch-mode calls. */
  ok_count?: number;
  /** Items that returned {ok: false, error}. Only set on batch-mode calls. */
  error_count?: number;
}

export interface EnvelopeBuilderInput<T> {
  result: T;
  tier: Tier;
  model: string;
  hardwareProfile: string;
  tokensIn: number;
  tokensOut: number;
  startedAt: number;
  residency: Residency | null;
  fallbackFrom?: Tier;
  /** Backend that served the call (cloud-primary mode). Omit in local-only path. */
  backend?: "cloud" | "local";
  /** True when cloud was wanted but local served. Omit in local-only path. */
  degraded?: boolean;
  /** Reason for the cloud→local degrade. Omit unless `degraded` is true. */
  degradeReason?: string;
  /**
   * The model the caller asked for via the per-call `model` override.
   * Propagates to `model_requested` on the output envelope. Omit when
   * no override was supplied.
   */
  modelRequested?: string;
  /**
   * The `num_ctx` value the MCP server actually placed on the Ollama
   * generate request (v2.4.0). Propagates to `num_ctx_used` on the output
   * envelope. Omit (do NOT pass `undefined` synthesized to 0) when the
   * profile didn't specify a per-tier `num_ctx` — the envelope field is
   * intentionally absent in that case so callers can detect that the
   * MCP server let Ollama choose the default.
   */
  numCtxUsed?: number;
  /**
   * Server-minted correlation ID (Phase 7 / FT-001). Normally OMITTED by
   * the caller — `buildEnvelope` auto-populates from the active
   * `CorrelationContext` via `getRunContext()`. Explicit override is
   * supported for tests that want to assert a known value without
   * wrapping the call in `withRunContext`. When the active context is
   * missing AND no override is supplied, the envelope field is absent
   * (preserves v2.4.0 backward-compat).
   */
  runId?: string;
  warnings?: string[];
}

export function buildEnvelope<T>(input: EnvelopeBuilderInput<T>): Envelope<T> {
  const env: Envelope<T> = {
    result: input.result,
    tier_used: input.tier,
    model: input.model,
    hardware_profile: input.hardwareProfile,
    tokens_in: input.tokensIn,
    tokens_out: input.tokensOut,
    elapsed_ms: Date.now() - input.startedAt,
    residency: input.residency,
  };
  if (input.fallbackFrom) env.fallback_from = input.fallbackFrom;
  if (input.backend) env.backend = input.backend;
  if (input.degraded) env.degraded = input.degraded;
  if (input.degradeReason) env.degrade_reason = input.degradeReason;
  if (input.modelRequested) env.model_requested = input.modelRequested;
  if (input.numCtxUsed !== undefined) env.num_ctx_used = input.numCtxUsed;
  // run_id propagation (Phase 7 / FT-001) — prefer caller-supplied value
  // (tests) over the ALS lookup so deterministic envelopes remain easy
  // to assert. Production paths always go through the ALS read because
  // tools don't pass `runId` explicitly through `runTool`.
  const runId = input.runId ?? getRunContext()?.run_id;
  if (runId) env.run_id = runId;
  if (input.warnings && input.warnings.length > 0) env.warnings = input.warnings;
  return env;
}

/** True when residency indicates the model was evicted to disk. */
export function isEvicted(residency: Residency | null): boolean {
  if (!residency) return false;
  return residency.evicted || !residency.in_vram || residency.size_vram_bytes < residency.size_bytes;
}
