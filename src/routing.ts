/**
 * Backend routing — cloud-primary, local-fallback.
 *
 * `RoutingOllamaClient` wraps two `OllamaClient`s (a cloud client with a
 * Bearer key and the existing local client) and implements the cloud→local
 * fallback policy behind the SAME `OllamaClient` interface. Because the whole
 * server touches Ollama through a single `ctx.client`, wrapping here means
 * every tool inherits cloud routing with zero per-tool change.
 *
 * Two ROUTING MODES (F2, v2.9):
 *   - cloud-primary (v2.7.0): every tiered call tries cloud first.
 *   - STANDBY: local-primary; cloud serves ONLY calls carrying an explicit
 *     per-call `backend:'cloud'` route directive. Zero egress otherwise —
 *     the deterministic guarantee the model never overrides.
 * Per-call route directives ride the REQUEST as a non-enumerable Symbol
 * (mirror of the response provenance tag below) so they can never serialize
 * onto the wire: `backend` escalates one call (standby) or pins one local
 * (primary); `modelExplicit` marks req.model as a caller override the cloud
 * attempt must honor instead of clobbering with the tier map.
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
 *   - deterministic (404 model-missing)           → do NOT count toward the breaker; release the
 *                                                   half-open probe and fall back to local with a
 *                                                   loud `cloud_model_missing` degrade reason + a
 *                                                   cloud-specific hint (a retired/typo'd cloud model
 *                                                   id degrades visibly, never a silent swap nor a
 *                                                   total outage), and arm a short auto-expiring
 *                                                   cooldown so a persistently-missing model isn't
 *                                                   re-probed on every call. See H2/H3 (2026-07).
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
  | "cloud_model_missing"
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

// ── Per-call route directive (F2b) ──────────────────────────────────────────

/**
 * Per-call routing instruction, attached to a REQUEST by the runner (or a
 * handler like chat) right before the client call. Carried on a
 * non-enumerable Symbol — JSON.stringify and the object spreads at the HTTP
 * layer never see it, so it cannot leak onto the wire.
 */
export interface RouteDirective {
  /**
   * 'cloud' escalates this one call to the cloud backend (the only way a
   * call reaches cloud in standby mode); 'local' pins this one call local
   * (zero egress) even under cloud-primary.
   */
  backend?: Backend;
  /**
   * True when req.model is an explicit caller override (per-call `model`,
   * v2.3.0) — the cloud attempt must send req.model verbatim instead of
   * the tier→cloud-model map. Absent for tier-resolved models.
   */
  modelExplicit?: boolean;
}

const ROUTE_DIRECTIVE = Symbol("ollama_intern_route_directive");

/** Attach a route directive to a request. Returns the same object for chaining. */
export function setRouteDirective<T extends object>(req: T, directive: RouteDirective): T {
  Object.defineProperty(req, ROUTE_DIRECTIVE, {
    value: directive,
    enumerable: false,
    configurable: true,
  });
  return req;
}

/** Read a request's route directive. Undefined when none was attached. */
export function getRouteDirective(req: unknown): RouteDirective | undefined {
  if (req && typeof req === "object" && ROUTE_DIRECTIVE in req) {
    return (req as { [ROUTE_DIRECTIVE]?: RouteDirective })[ROUTE_DIRECTIVE];
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
  /**
   * Deterministic-failure (cloud 404 model-missing) cooldown in ms. During this
   * window after a cloud 404, cloud attempts are suppressed so a retired/typo'd
   * cloud model doesn't pay a round-trip on every call. Auto-expires (NOT sticky
   * like auth) so a restored model / fixed id recovers on its own. Default 60_000.
   */
  deterministicCooldownMs?: number;
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
  /** Wall-clock (via `now`) until which cloud is suppressed after a 404 (H3). */
  private deterministicCooldownUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly deterministicCooldownMs: number;
  private readonly now: () => number;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 20_000;
    this.deterministicCooldownMs = opts.deterministicCooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get currentState(): BreakerState {
    return this.state;
  }

  /** True while the deterministic-failure (cloud 404) cooldown is active (H3). */
  inDeterministicCooldown(): boolean {
    return this.now() < this.deterministicCooldownUntil;
  }

  /** Decide whether to attempt cloud now. May transition OPEN→HALF-OPEN. */
  allowCloud(): boolean {
    if (this.state === "misconfigured") return false;
    // H3: a recent cloud 404 (model-missing) suppresses cloud attempts briefly,
    // independent of the transient breaker state, so a retired model doesn't tax
    // every call. Auto-expires — not sticky.
    if (this.inDeterministicCooldown()) return false;
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

  /**
   * Release a half-open probe that neither succeeded nor is a countable
   * failure — used when the probe threw a DETERMINISTIC error (e.g. a 404
   * model-missing) that must not count toward the breaker but also must not
   * wedge it in half_open forever. Clears the in-flight flag and, if we were
   * probing, restores OPEN + re-arms the cooldown so a later probe can run.
   */
  releaseProbe(): void {
    this.halfOpenInFlight = false;
    if (this.state === "half_open") {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  /**
   * A deterministic cloud failure (404 model-missing). Does NOT count toward the
   * transient breaker (it's an external config/availability fact, not a cloud
   * outage) and is NOT sticky like auth. Releases any half-open probe (so a 404
   * can't wedge half_open — H2) and arms a short cooldown during which cloud is
   * skipped (H3), so a persistently-retired model isn't re-probed on every call.
   */
  recordDeterministicFailure(): void {
    this.releaseProbe();
    this.deterministicCooldownUntil = this.now() + this.deterministicCooldownMs;
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
  /**
   * Standby mode (F2a): local-primary; cloud serves only per-call
   * backend:'cloud' escalations. Default false = cloud-primary (v2.7.0).
   */
  standby?: boolean;
  /** Cloud host, named in the first-egress disclosure line. */
  cloudHost?: string;
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
  private readonly standby: boolean;
  private readonly cloudHost?: string;
  /** True once the standby first-egress disclosure has been emitted. */
  private egressDisclosed = false;

  constructor(opts: RoutingOllamaClientOptions) {
    this.cloud = opts.cloud;
    this.local = opts.local;
    this.cloudTiers = opts.cloudTiers;
    this.localTiers = opts.localTiers;
    this.cloudTimeouts = opts.cloudTimeouts;
    this.cloudNumCtx = opts.cloudNumCtx;
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.logger = opts.logger;
    this.standby = opts.standby ?? false;
    this.cloudHost = opts.cloudHost;
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

    const directive = getRouteDirective(req);

    // Per-call local pin (cloud-primary), or standby without an explicit
    // escalation → serve local AS-IS. NOT a degradation: the caller (or the
    // standby default) chose local, so no degrade_reason, no breaker touch,
    // and — load-bearing for the standby zero-egress guarantee — no cloud
    // attempt of any kind.
    if (directive?.backend === "local" || (this.standby && directive?.backend !== "cloud")) {
      const resp = await call(this.local, req, signal, tier);
      return tag(resp, {
        backend: "local",
        model: req.model,
        degraded: false,
        circuit_state: this.breaker.currentState,
        ...(req.options?.num_ctx !== undefined ? { num_ctx: req.options.num_ctx } : {}),
      });
    }

    // F2b: an explicit caller model override (per-call `model`, v2.3.0) is
    // honored on the cloud attempt — previously the tier map clobbered it,
    // silently substituting the tier's cloud model for the one the caller
    // named (the verify-claims jury depends on per-juror model identity).
    const modelExplicit = directive?.modelExplicit === true;
    const cloudModel = modelExplicit ? req.model : resolveTier(tier, this.cloudTiers);

    // Breaker says no cloud (OPEN within cooldown, or sticky misconfigured) →
    // straight to local, no cloud latency tax.
    if (!this.breaker.allowCloud()) {
      // Report WHY cloud was skipped: sticky auth misconfig, the H3 deterministic
      // (cloud-404) cooldown, or the transient breaker being OPEN — never a
      // misleading circuit_open when the real cause is a missing cloud model.
      const reason: DegradeReason =
        this.breaker.currentState === "misconfigured"
          ? "cloud_auth_failed"
          : this.breaker.inDeterministicCooldown()
            ? "cloud_model_missing"
            : "circuit_open";
      return this.serveLocal(req, signal, tier, reason, call);
    }

    // First-egress disclosure (standby): the first call that actually leaves
    // the machine says so loudly AT THE POINT of egress — not only in docs
    // (the Homebrew #142 lesson; GDPR Art. 25 privacy-by-default). Once per
    // client. Cloud-primary discloses at startup instead.
    if (this.standby && !this.egressDisclosed) {
      this.egressDisclosed = true;
      const host = this.cloudHost ?? "Ollama Cloud";
      // eslint-disable-next-line no-console
      console.error(
        `ollama-intern: CLOUD ESCALATION — this call is being sent to ${host} (model ${cloudModel}, tier ${tier}). Standby mode sends ONLY calls that request backend:'cloud'; everything else stays local.`,
      );
      void this.logger?.log({
        kind: "cloud_egress",
        ts: timestamp(),
        host,
        model: cloudModel,
        mode: "standby",
        tier,
      });
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
      // Prefer the backend's own served-model echo over what we requested —
      // live cloud strips the tag suffix (deepseek-v4-pro:cloud → served
      // "deepseek-v4-pro"), and any divergence beyond that is exactly the
      // substitution a caller-side served-model check (verify_claims) must
      // see. Fall back to the requested model when the echo is absent.
      const servedModel = (resp as { model?: unknown }).model;
      return tag(resp, {
        backend: "cloud",
        model: typeof servedModel === "string" && servedModel.length > 0 ? servedModel : cloudModel,
        degraded: false,
        circuit_state: this.breaker.currentState,
        ...(cloudOptions?.num_ctx !== undefined ? { num_ctx: cloudOptions.num_ctx } : {}),
      });
    } catch (err) {
      // M4: an abort from the OUTER signal (the runner's tier budget expired, or
      // the caller cancelled) is NOT a cloud failure — the whole attempt is being
      // torn down from outside. Don't count it toward the breaker (operator/caller
      // config must never trip the cloud breaker) and don't serve local on the
      // already-dead signal; rethrow so the outer runWithTimeoutAndFallback drives
      // the tier cascade / TIER_TIMEOUT. A cloud-attempt-timer abort, by contrast,
      // leaves the outer signal live and falls through to the transient path below.
      if (signal?.aborted) throw err;
      const cls = classifyCloudError(err);
      if (cls === "deterministic") {
        if (modelExplicit) {
          // A per-call override 404 is CALL-scoped config: release any
          // half-open probe (H2) but do NOT arm the process-wide H3
          // cooldown — one caller's typo'd/retired model must not suppress
          // cloud for every other call for 60s (a verify-claims juror that
          // goes retired would otherwise degrade the whole panel's process).
          this.breaker.releaseProbe();
        } else {
          // H2: release the half-open probe so a deterministic 404 can't wedge
          // the breaker in half_open forever (it neither succeeds nor counts as
          // a transient failure). H3-res: also arm a short deterministic cooldown
          // so a persistently-retired model isn't re-probed on every call.
          this.breaker.recordDeterministicFailure();
        }
        // H3: a retired/typo'd cloud model id is EXTERNAL and out of the
        // operator's control — hard-failing every generative call while a
        // healthy local sat idle was a total outage. Fall back to local with a
        // DISTINCT, loud degrade_reason (the same posture as an auth misconfig,
        // which also serves local). The reason rides every envelope + a
        // backend_fallback event, so the misconfiguration surfaces WITHOUT
        // breaking the server. Deterministic → not counted toward the breaker.
        return this.serveLocal(req, signal, tier, "cloud_model_missing", call);
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
