/**
 * Backend routing — cloud-primary, local-fallback.
 *
 * `RoutingOllamaClient` wraps two `OllamaClient`s (a cloud client with a
 * Bearer key and the existing local client) and implements the cloud→local
 * fallback policy behind the SAME `OllamaClient` interface. Because the whole
 * server touches Ollama through a single `ctx.client`, wrapping here means
 * every tool inherits cloud routing with zero per-tool change.
 *
 * Two axes of fallback exist and are ORTHOGONAL:
 *   - BACKEND fallback (this module): cloud→local, gated by a circuit breaker.
 *   - TIER degradation (guardrails/timeouts.ts): deep→workhorse→instant model
 *     downgrade on timeout, WITHIN whichever backend served.
 * Backend is resolved first (a near-instant breaker check); tier degradation
 * runs inside the chosen backend. They are not chained into a 6-timeout ladder.
 *
 * Failure classification (research-grounded — Hystrix + Google SRE):
 *   - transient (timeout / 5xx / 429 / network)  → count toward the breaker, fall to local.
 *   - auth (401/403, OLLAMA_AUTH_FAILED)          → sticky 'misconfigured' breaker that does NOT
 *                                                   auto-recover on a timer; serve local but surface loudly.
 *   - deterministic (404 model-missing)           → do NOT count; rethrow (a retired/typo'd cloud
 *                                                   model id must surface, not silently degrade).
 *
 * Observability: every response is tagged (non-enumerable Symbol) with which
 * backend served it + whether it was degraded, and a `backend_fallback` NDJSON
 * event is emitted on every cloud→local fallback. The runner lifts these onto
 * the envelope so a worse local answer is never silent.
 */

import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "./ollama.js";
import type { Residency } from "./envelope.js";
import type { Tier, TierConfig } from "./tiers.js";
import { resolveTier } from "./tiers.js";
import { InternError } from "./errors.js";
import type { Logger } from "./observability.js";
import { timestamp } from "./observability.js";

/** Why a call was served from local instead of cloud. */
export type DegradeReason =
  | "cloud_timeout"
  | "cloud_5xx"
  | "cloud_rate_limited"
  | "cloud_unreachable"
  | "cloud_auth_failed"
  | "circuit_open";

export type Backend = "cloud" | "local";

/** Routing provenance attached to each response and lifted onto the envelope. */
export interface RoutingInfo {
  backend: Backend;
  /** The model that actually served the call. */
  model: string;
  /** True when we wanted cloud but served local. */
  degraded: boolean;
  degrade_reason?: DegradeReason;
  circuit_state: BreakerState;
  /**
   * The `num_ctx` actually sent on the served request, if any. Cloud attempts
   * use the cloud cap (not the local VRAM-driven value); local serves keep the
   * runner's per-tier value. Absent when no num_ctx was sent. Lets the envelope
   * report the real context window per backend.
   */
  num_ctx?: number;
}

// Non-enumerable so it never serializes onto the wire / into JSON.stringify.
const ROUTING = Symbol("ollama_intern_routing");

function tag<T extends object>(resp: T, info: RoutingInfo): T {
  Object.defineProperty(resp, ROUTING, { value: info, enumerable: false, configurable: true });
  return resp;
}

/** Read routing provenance off a response. Undefined when not routed (local-only default). */
export function getRoutingInfo(resp: unknown): RoutingInfo | undefined {
  if (resp && typeof resp === "object" && ROUTING in resp) {
    return (resp as { [ROUTING]?: RoutingInfo })[ROUTING];
  }
  return undefined;
}

// ── Circuit breaker ────────────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half_open" | "misconfigured";

export interface BreakerOptions {
  /** Consecutive trip-worthy failures before OPEN. Default 3 (low-volume single tenant). */
  threshold?: number;
  /** OPEN→HALF-OPEN cooldown in ms. Default 20_000. */
  cooldownMs?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  now?: () => number;
}

/**
 * Single-backend circuit breaker. CLOSED → OPEN (after N consecutive trip-worthy
 * failures) → after cooldown → HALF-OPEN (one probe) → CLOSED on success / OPEN
 * on failure. Auth failures trip a SEPARATE sticky 'misconfigured' state that
 * never auto-recovers (a bad key fails deterministically forever).
 *
 * No locking: the global Ollama semaphore serializes calls, so single-probe
 * half-open + the consecutive-failure counter are race-free in this server.
 */
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenInFlight = false;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  get currentState(): BreakerState {
    return this.state;
  }

  /** Decide whether to attempt cloud now. May transition OPEN→HALF-OPEN. */
  allowCloud(): boolean {
    if (this.state === "misconfigured") return false;
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half_open";
        this.halfOpenInFlight = true;
        return true; // admit exactly one probe
      }
      return false;
    }
    // half_open — only one probe in flight at a time.
    if (this.halfOpenInFlight) return false;
    this.halfOpenInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = false;
  }

  /** A transient cloud failure (timeout/5xx/429/network). */
  recordFailure(): void {
    this.halfOpenInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === "half_open" || this.consecutiveFailures >= this.threshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  /** A deterministic auth failure — sticky, does not auto-recover. */
  recordAuthFailure(): void {
    this.state = "misconfigured";
    this.halfOpenInFlight = false;
  }
}

// ── Error classification ─────────────────────────────────────────────────────

type CloudErrorClass = "auth" | "deterministic" | "transient";

function classifyCloudError(err: unknown): CloudErrorClass {
  if (err instanceof InternError) {
    if (err.code === "OLLAMA_AUTH_FAILED") return "auth";
    // 404 model-missing (incl. a retired/typo'd cloud model id) must surface,
    // not silently degrade to a different local model.
    if (err.code === "OLLAMA_MODEL_MISSING") return "deterministic";
    // OLLAMA_TIMEOUT, OLLAMA_UNREACHABLE (5xx-exhausted / network / other 4xx)
    // → transient. OLLAMA_UNREACHABLE conflates "network down" (the common,
    // fall-back-worthy case) with a rare 400; we bias to falling back to local.
    return "transient";
  }
  // AbortError (our own cloud-attempt timeout) and raw network errors.
  return "transient";
}

function reasonFromError(err: unknown): DegradeReason {
  if (err instanceof Error && err.name === "AbortError") return "cloud_timeout";
  if (err instanceof InternError) {
    if (err.code === "OLLAMA_TIMEOUT") return "cloud_timeout";
    const m = /returned (\d{3})/.exec(err.message);
    if (m) {
      const status = Number(m[1]);
      if (status === 429) return "cloud_rate_limited";
      if (status >= 500) return "cloud_5xx";
    }
    return "cloud_unreachable";
  }
  return "cloud_unreachable";
}

// ── Routing client ───────────────────────────────────────────────────────────

export interface RoutingOllamaClientOptions {
  cloud: OllamaClient;
  local: OllamaClient;
  /** Cloud model per tier (instant/workhorse/deep). embed is always local. */
  cloudTiers: TierConfig;
  /** Local model per tier — used for the fallback request. */
  localTiers: TierConfig;
  /** Per-tier cloud-attempt timeout (ms). Cloud is far slower than local. */
  cloudTimeouts: Record<Tier, number>;
  /**
   * Context-window cap (tokens) for cloud requests. Cloud models have huge
   * windows (512K–1M) but are billed by GPU-time, so we cap by default rather
   * than inherit the local VRAM-driven num_ctx. Applied to every cloud attempt.
   */
  cloudNumCtx?: number;
  breaker?: CircuitBreaker;
  logger?: Logger;
}

export class RoutingOllamaClient implements OllamaClient {
  private readonly cloud: OllamaClient;
  private readonly local: OllamaClient;
  private readonly cloudTiers: TierConfig;
  private readonly localTiers: TierConfig;
  private readonly cloudTimeouts: Record<Tier, number>;
  private readonly cloudNumCtx?: number;
  readonly breaker: CircuitBreaker;
  private readonly logger?: Logger;

  constructor(opts: RoutingOllamaClientOptions) {
    this.cloud = opts.cloud;
    this.local = opts.local;
    this.cloudTiers = opts.cloudTiers;
    this.localTiers = opts.localTiers;
    this.cloudTimeouts = opts.cloudTimeouts;
    this.cloudNumCtx = opts.cloudNumCtx;
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.logger = opts.logger;
  }

  generate(req: GenerateRequest, signal?: AbortSignal, tier?: Tier): Promise<GenerateResponse> {
    return this.route(req, signal, tier, (c, r, s, t) => c.generate(r, s, t));
  }

  chat(req: ChatRequest, signal?: AbortSignal, tier?: Tier): Promise<ChatResponse> {
    return this.route(req, signal, tier, (c, r, s, t) => c.chat(r, s, t));
  }

  /** Embeddings are local-only — Ollama Cloud serves no embedding models. */
  embed(req: EmbedRequest, signal?: AbortSignal, tier?: Tier): Promise<EmbedResponse> {
    return this.local.embed(req, signal, tier);
  }

  /** Residency is a local-VRAM concept; delegate to local (cloud-served models return null). */
  residency(model: string): Promise<Residency | null> {
    return this.local.residency(model);
  }

  /** Reachability of the always-available local backend. Cloud auth is checked by `doctor`. */
  probe(timeoutMs?: number): Promise<{ ok: boolean; reason?: string }> {
    return this.local.probe(timeoutMs);
  }

  /**
   * Shared cloud-primary/local-fallback path for generate + chat. `req.model`
   * arrives set to the LOCAL model (the runner resolves local models, staying
   * cloud-agnostic); we override to the cloud model for the cloud attempt and
   * keep the local model for fallback.
   */
  private async route<
    TReq extends { model: string; options?: GenerateRequest["options"] },
    TRes extends object,
  >(
    req: TReq,
    signal: AbortSignal | undefined,
    tier: Tier | undefined,
    call: (c: OllamaClient, r: TReq, s?: AbortSignal, t?: Tier) => Promise<TRes>,
  ): Promise<TRes> {
    // No tier (shouldn't happen via runTool) → nothing to route; serve local.
    if (!tier) {
      const resp = await call(this.local, req, signal, tier);
      return tag(resp, {
        backend: "local",
        model: req.model,
        degraded: false,
        circuit_state: this.breaker.currentState,
        ...(req.options?.num_ctx !== undefined ? { num_ctx: req.options.num_ctx } : {}),
      });
    }

    const cloudModel = resolveTier(tier, this.cloudTiers);

    // Breaker says no cloud (OPEN within cooldown, or sticky misconfigured) →
    // straight to local, no cloud latency tax.
    if (!this.breaker.allowCloud()) {
      const reason: DegradeReason =
        this.breaker.currentState === "misconfigured" ? "cloud_auth_failed" : "circuit_open";
      return this.serveLocal(req, signal, tier, reason, call);
    }

    // Cloud attempt — own timeout so a cloud hang can fall to local BEFORE the
    // outer runner budget fires; also aborts if the outer signal fires.
    const cloudController = new AbortController();
    const timer = setTimeout(() => cloudController.abort(), this.cloudTimeouts[tier]);
    const onOuterAbort = (): void => cloudController.abort();
    if (signal?.aborted) cloudController.abort();
    else signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      // Override the model AND num_ctx: the runner set both for the LOCAL
      // model (VRAM-driven, e.g. 4096/8192). Cloud has no VRAM constraint, so
      // use the cloud cap to avoid crippling the big model's context window.
      const cloudOptions =
        this.cloudNumCtx !== undefined
          ? { ...(req.options ?? {}), num_ctx: this.cloudNumCtx }
          : req.options;
      const cloudReq = { ...req, model: cloudModel, options: cloudOptions } as TReq;
      const resp = await call(this.cloud, cloudReq, cloudController.signal, tier);
      this.breaker.recordSuccess();
      return tag(resp, {
        backend: "cloud",
        model: cloudModel,
        degraded: false,
        circuit_state: this.breaker.currentState,
        ...(cloudOptions?.num_ctx !== undefined ? { num_ctx: cloudOptions.num_ctx } : {}),
      });
    } catch (err) {
      const cls = classifyCloudError(err);
      if (cls === "deterministic") {
        // Surface the real error (e.g. retired cloud model id) — do NOT count
        // toward the breaker and do NOT silently serve a different local model.
        throw err;
      }
      if (cls === "auth") {
        this.breaker.recordAuthFailure();
        return this.serveLocal(req, signal, tier, "cloud_auth_failed", call);
      }
      this.breaker.recordFailure();
      return this.serveLocal(req, signal, tier, reasonFromError(err), call);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /** Serve from local, tagging the response degraded and emitting a backend_fallback event. */
  private async serveLocal<
    TReq extends { model: string; options?: GenerateRequest["options"] },
    TRes extends object,
  >(
    req: TReq,
    signal: AbortSignal | undefined,
    tier: Tier,
    reason: DegradeReason,
    call: (c: OllamaClient, r: TReq, s?: AbortSignal, t?: Tier) => Promise<TRes>,
  ): Promise<TRes> {
    const localModel = resolveTier(tier, this.localTiers);
    void this.logger?.log({
      kind: "backend_fallback",
      ts: timestamp(),
      from: "cloud",
      to: "local",
      reason,
      tier,
      model: localModel,
    });
    // Keep the runner's local num_ctx (it was sized for this local model).
    const localReq = { ...req, model: localModel } as TReq;
    const resp = await call(this.local, localReq, signal, tier);
    return tag(resp, {
      backend: "local",
      model: localModel,
      degraded: true,
      degrade_reason: reason,
      circuit_state: this.breaker.currentState,
      ...(localReq.options?.num_ctx !== undefined ? { num_ctx: localReq.options.num_ctx } : {}),
    });
  }
}
