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
  tokens_in: number;
  tokens_out: number;
  elapsed_ms: number;
  residency: Residency | null;
  /** Set when a timeout fired and the server fell back to a cheaper tier. */
  fallback_from?: Tier;
  /** Non-fatal warnings — e.g. "2 citations stripped (paths not in source_paths)". */
  warnings?: string[];
}

export interface EnvelopeBuilderInput<T> {
  result: T;
  tier: Tier;
  model: string;
  tokensIn: number;
  tokensOut: number;
  startedAt: number;
  residency: Residency | null;
  fallbackFrom?: Tier;
  warnings?: string[];
}

export function buildEnvelope<T>(input: EnvelopeBuilderInput<T>): Envelope<T> {
  const env: Envelope<T> = {
    result: input.result,
    tier_used: input.tier,
    model: input.model,
    tokens_in: input.tokensIn,
    tokens_out: input.tokensOut,
    elapsed_ms: Date.now() - input.startedAt,
    residency: input.residency,
  };
  if (input.fallbackFrom) env.fallback_from = input.fallbackFrom;
  if (input.warnings && input.warnings.length > 0) env.warnings = input.warnings;
  return env;
}

/** True when residency indicates the model was evicted to disk. */
export function isEvicted(residency: Residency | null): boolean {
  if (!residency) return false;
  return residency.evicted || !residency.in_vram || residency.size_vram_bytes < residency.size_bytes;
}
