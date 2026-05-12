/**
 * Uniform response envelope — every tool returns this shape.
 *
 * residency is populated from Ollama's /api/ps. When in_vram is false
 * or size_vram < size, the model paged to disk; inference drops 5–10×.
 * Surfacing it mechanically in every call is what prevents hand-wavy
 * performance claims when Ollama's eviction bug (#13227) strikes.
 */

import type { Tier } from "./tiers.js";

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
  if (input.modelRequested) env.model_requested = input.modelRequested;
  if (input.numCtxUsed !== undefined) env.num_ctx_used = input.numCtxUsed;
  if (input.warnings && input.warnings.length > 0) env.warnings = input.warnings;
  return env;
}

/** True when residency indicates the model was evicted to disk. */
export function isEvicted(residency: Residency | null): boolean {
  if (!residency) return false;
  return residency.evicted || !residency.in_vram || residency.size_vram_bytes < residency.size_bytes;
}
