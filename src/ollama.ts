/**
 * Ollama HTTP client — generate, embed, residency probe (/api/ps).
 *
 * Every call is guarded by the global semaphore. Timeouts via AbortController.
 * Residency probe runs on every call so the envelope can surface eviction
 * without the caller asking. This is what prevents silent 5–10× slowdowns
 * from hiding behind polished output.
 */

import { ollamaSemaphore } from "./semaphore.js";
import { InternError } from "./errors.js";
import type { Residency } from "./envelope.js";
import type { Logger } from "./observability.js";
import { timestamp } from "./observability.js";

const API_TIMEOUT_MS = 10_000;

/**
 * Transient-failure retry policy. Local Ollama normally responds in a few ms;
 * the one-in-a-while failure is a cold-load race, a momentary 5xx while the
 * server is loading a model, or a transient connection reset. Three attempts
 * with exponential backoff (200ms, 400ms, 800ms) plus ±20% jitter is enough
 * to smooth those out without letting a truly-dead Ollama hide behind "please
 * wait" — total worst case ~1.4s before the caller sees the error.
 *
 * Do NOT retry 4xx (including the 404 OLLAMA_MODEL_MISSING path) except 429,
 * which is rare on a local instance but safe to treat as transient.
 */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAYS_MS = [200, 400, 800];
const RETRY_JITTER_PCT = 0.2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test seam — when set (via setTestBackoff), the retry wrapper uses this
 * delay instead of the production ladder. Keeps retry tests fast without
 * monkeypatching global setTimeout.
 */
let testBackoffMs: number | null = null;
export function setTestBackoff(ms: number | null): void {
  testBackoffMs = ms;
}

/** Test seam — pass 0 for deterministic tests. Jitter is ±RETRY_JITTER_PCT. */
function backoffDelayMs(attemptIdx: number, jitterPct: number = RETRY_JITTER_PCT): number {
  const base = RETRY_BASE_DELAYS_MS[attemptIdx] ?? RETRY_BASE_DELAYS_MS[RETRY_BASE_DELAYS_MS.length - 1];
  const jitter = base * jitterPct * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * True if the error should cause a retry. Transient buckets:
 *   - 5xx response from Ollama
 *   - 429 Too Many Requests
 *   - Low-level connection errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE,
 *     fetch "TypeError: fetch failed" chain, etc.)
 * 4xx (other than 429) and AbortError are not retried — the caller already
 * has a definitive signal.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof TransientHttpError) return true;
  if (err instanceof InternError) {
    // InternError thrown below for non-transient paths (404 model missing) —
    // retry only those we flagged retryable=true AND marked transient.
    return false;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const code = (err as NodeJS.ErrnoException).code;
    if (code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"].includes(code)) return true;
    // `fetch` wraps network errors in a generic "fetch failed" TypeError.
    if (err.message && /fetch failed|network|socket hang up/i.test(err.message)) return true;
  }
  return false;
}

/** Internal signal from post() to the retry wrapper — HTTP 5xx/429 responses. */
class TransientHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyPreview: string,
  ) {
    super(`Ollama returned ${status}: ${bodyPreview}`);
    this.name = "TransientHttpError";
  }
}

/**
 * Optional logger for HTTP-level observability events (semaphore waits,
 * residency probe failures). Set once at startup from index.ts; remains
 * null in tests, where those events aren't meaningful. Keeping this as a
 * module-level hook avoids threading a logger through every fetch call
 * site — these events are environmental, not per-request.
 */
let sideLogger: Logger | null = null;
export function setClientLogger(logger: Logger | null): void {
  sideLogger = logger;
}

/**
 * Active profile name for side-event enrichment (semaphore:wait). Set once
 * at startup alongside the logger; nullable because tests don't need it.
 */
let sideProfileName: string | null = null;
export function setClientProfileName(name: string | null): void {
  sideProfileName = name;
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  format?: "json";
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
  };
  /**
   * Thinking-mode toggle (Ollama 2026 API, added for Qwen 3 / DeepSeek R1 / etc.).
   * `false` suppresses CoT and keeps the `response` field tight; `true` lets
   * the model reason before answering (CoT goes into the `thinking` response
   * field, not `response`). Non-thinking models (e.g. hermes3:8b) ignore it.
   *
   * Load-bearing on Qwen 3: leaving thinking on for short-output tasks
   * (classify/extract/triage/summarize) causes `response` to come back empty
   * when num_predict gets consumed by thinking tokens. The prompt-level
   * `/no_think` soft-switch is IGNORED by Ollama — only this field works.
   */
  think?: boolean;
  /** Keep model resident for this long. "-1" = forever. */
  keep_alive?: string | number;
}

export interface GenerateResponse {
  model: string;
  response: string;
  /**
   * CoT content, populated when the request had think=true and the model
   * supports thinking. Separate from `response` — never concatenate.
   */
  thinking?: string;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  eval_duration?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  format?: "json";
  stream?: boolean;
  options?: GenerateRequest["options"];
  keep_alive?: string | number;
}

export interface ChatResponse {
  model: string;
  message: ChatMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface EmbedRequest {
  model: string;
  input: string | string[];
  keep_alive?: string | number;
}

export interface EmbedResponse {
  model: string;
  embeddings: number[][];
}

export interface PsModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  digest: string;
  expires_at: string;
}

export interface PsResponse {
  models: PsModel[];
}

export interface OllamaClient {
  generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse>;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse>;
  residency(model: string): Promise<Residency | null>;
  /** Reachability probe — no retry, short timeout. Used at startup. */
  probe(timeoutMs?: number): Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Normalize an OLLAMA_HOST value.
 *
 * Ollama's CLI accepts `127.0.0.1:11434` (no scheme) and routes Windows users
 * often set it that way. fetch() requires a full URL, so we coerce anything
 * that looks like host[:port] into a proper http:// URL, and strip trailing
 * slashes so path concatenation stays clean.
 */
// By design, arbitrary host URLs are permitted for local-first MCP usage.
// Scoping `OLLAMA_HOST` (private network, loopback, tunnel, etc.) is an
// operator responsibility — no SSRF-style validation is applied here.
export function normalizeOllamaHost(raw: string | undefined): string {
  const fallback = "http://127.0.0.1:11434";
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  const trimmed = withScheme.replace(/\/+$/, "");
  // Validate port range if one is present. An out-of-range port lands as a
  // 'Invalid URL' error deep inside fetch() which turns into a generic
  // "Failed to reach Ollama" — CONFIG_INVALID at startup is the honest signal.
  try {
    const url = new URL(trimmed);
    if (url.port !== "") {
      const port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new InternError(
          "CONFIG_INVALID",
          `Invalid OLLAMA_HOST port: '${url.port}' (got from '${raw}')`,
          "OLLAMA_HOST port must be an integer between 1 and 65535. Example: http://127.0.0.1:11434",
          false,
        );
      }
    }
  } catch (err) {
    if (err instanceof InternError) throw err;
    throw new InternError(
      "CONFIG_INVALID",
      `Invalid OLLAMA_HOST URL: '${raw}'`,
      "OLLAMA_HOST must be a host[:port] or full http(s):// URL. Example: http://127.0.0.1:11434",
      false,
    );
  }
  return trimmed;
}

export class HttpOllamaClient implements OllamaClient {
  private baseUrl: string;
  constructor(baseUrl?: string) {
    this.baseUrl = normalizeOllamaHost(baseUrl ?? process.env.OLLAMA_HOST);
  }

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    return this.post<GenerateRequest, GenerateResponse>("/api/generate", { ...req, stream: false }, signal);
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.post<ChatRequest, ChatResponse>("/api/chat", { ...req, stream: false }, signal);
  }

  async embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse> {
    return this.post<EmbedRequest, EmbedResponse>("/api/embed", req, signal);
  }

  async residency(model: string): Promise<Residency | null> {
    try {
      const ps = await this.get<PsResponse>("/api/ps");
      const hit = ps.models.find((m) => m.name === model || m.model === model);
      if (!hit) return null;
      const evicted = hit.size_vram < hit.size;
      return {
        in_vram: !evicted,
        size_bytes: hit.size,
        size_vram_bytes: hit.size_vram,
        evicted,
        expires_at: hit.expires_at ?? null,
      };
    } catch (err) {
      // Silent probe failure here is what poisoned tier selection in
      // Stage B: operator sees a weird tier choice and has no hint why.
      // Emit a single console.error (stderr, not the envelope — the caller
      // already got a null, which is load-bearing behavior) so the reason
      // (network, auth, 404, malformed JSON) is visible.
      const endpoint = `${this.baseUrl}/api/ps`;
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(
        `ollama-intern: residency probe failed for model="${model}" at ${endpoint} — ${message}`,
      );
      return null;
    }
  }

  private async post<TReq, TRes>(path: string, body: TReq, signal?: AbortSignal): Promise<TRes> {
    // Before acquiring, peek at the gate. If we'd block, emit a single
    // semaphore:wait event with queue depth + rough wait estimate so an
    // operator debugging "why was this slow?" has the context they need.
    if (sideLogger !== null && ollamaSemaphore.wouldBlock) {
      const snap = ollamaSemaphore.snapshot();
      void sideLogger.log({
        kind: "semaphore:wait",
        ts: timestamp(),
        tier: "unknown",
        queue_depth: snap.queue_depth,
        in_flight: snap.in_flight,
        expected_wait_ms: snap.expected_wait_ms,
        ...(sideProfileName ? { profile_name: sideProfileName } : {}),
      });
    }
    const release = await ollamaSemaphore.acquire();
    try {
      return await this.postWithRetry<TReq, TRes>(path, body, signal);
    } finally {
      release();
    }
  }

  /**
   * Retry wrapper around one HTTP attempt. Transient errors (5xx, 429,
   * connection resets) retry up to RETRY_MAX_ATTEMPTS with exponential
   * backoff + jitter. Definitive failures (4xx model missing, AbortError from
   * a tier timeout) throw immediately. The final thrown InternError includes
   * the attempt count in its hint so operators know retries happened.
   */
  private async postWithRetry<TReq, TRes>(
    path: string,
    body: TReq,
    signal?: AbortSignal,
  ): Promise<TRes> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt < RETRY_MAX_ATTEMPTS) {
      try {
        return await this.postOnce<TReq, TRes>(path, body, signal);
      } catch (err) {
        lastErr = err;
        // Definitive — no retry.
        if (err instanceof InternError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new InternError(
            "OLLAMA_TIMEOUT",
            "Ollama request aborted",
            "Tier timeout fired — see fallback in envelope. Increase the tier's timeout via INTERN_TIER_*_TIMEOUT_MS if the cause is cold-load.",
            true,
          );
        }
        if (!isTransient(err)) break;
        attempt++;
        if (attempt >= RETRY_MAX_ATTEMPTS) break;
        // Respect an abort signal between attempts — don't sleep if the
        // caller's tier timeout already fired.
        if (signal?.aborted) break;
        await sleep(testBackoffMs ?? backoffDelayMs(attempt - 1));
      }
    }
    // All attempts exhausted (or single definitive non-Intern failure that
    // isn't transient). Map to InternError with the attempt count surfaced.
    if (lastErr instanceof TransientHttpError) {
      throw new InternError(
        "OLLAMA_UNREACHABLE",
        `Ollama returned ${lastErr.status}: ${lastErr.bodyPreview}`,
        `Check that Ollama is running ('ollama serve') and reachable at OLLAMA_HOST (default http://127.0.0.1:11434). Retried ${attempt}× with backoff; Ollama unreachable.`,
        true,
      );
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new InternError(
      "OLLAMA_UNREACHABLE",
      `Failed to reach Ollama: ${msg}`,
      `Check that Ollama is running ('ollama serve') and reachable at OLLAMA_HOST (default http://127.0.0.1:11434). Retried ${attempt}× with backoff; Ollama unreachable.`,
      true,
    );
  }

  /** One HTTP attempt — raises InternError for definitive 4xx, TransientHttpError for 5xx/429, raw for network. */
  private async postOnce<TReq, TRes>(path: string, body: TReq, signal?: AbortSignal): Promise<TRes> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 404) {
        throw new InternError(
          "OLLAMA_MODEL_MISSING",
          `Model not found (404): ${text}`,
          "Run 'ollama pull <model>' for the model named by your INTERN_PROFILE (check tiers in README or `intern profile`). See the full tier list in the README.",
          false,
        );
      }
      // 5xx and 429 are transient — signal the retry wrapper with a typed
      // error so it can back off rather than failing immediately.
      if (res.status >= 500 || res.status === 429) {
        throw new TransientHttpError(res.status, text.slice(0, 200));
      }
      // Other 4xx — definitive.
      throw new InternError(
        "OLLAMA_UNREACHABLE",
        `Ollama returned ${res.status}: ${text}`,
        "Check that Ollama is running ('ollama serve') and reachable at OLLAMA_HOST (default http://127.0.0.1:11434).",
        true,
      );
    }
    return (await res.json()) as TRes;
  }

  /**
   * Lightweight reachability probe used at server startup. Hits /api/ps with
   * a short timeout — if Ollama isn't up yet, we want a clear stderr message
   * without blocking server startup. Returns true if reachable, false on any
   * error (including 4xx/5xx/connection/timeout).
   */
  async probe(timeoutMs: number = 5000): Promise<{ ok: boolean; reason?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/ps`, { signal: controller.signal });
      if (res.ok) return { ok: true };
      return { ok: false, reason: `HTTP ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "Error";
      return { ok: false, reason: name === "AbortError" ? `timeout after ${timeoutMs}ms` : msg };
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) {
        throw new InternError(
          "OLLAMA_UNREACHABLE",
          `Ollama GET ${path} → ${res.status}`,
          "Check that 'ollama serve' is running and OLLAMA_HOST is reachable (default http://127.0.0.1:11434).",
          true,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function countTokens(resp: { prompt_eval_count?: number; eval_count?: number }): {
  in: number;
  out: number;
} {
  return { in: resp.prompt_eval_count ?? 0, out: resp.eval_count ?? 0 };
}

// Test seams — export retry internals so a fetch-mocked test can verify the
// full attempt ladder without waiting real backoff.
export const __retryInternals = {
  RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAYS_MS,
  backoffDelayMs,
  isTransient,
  TransientHttpError,
};
