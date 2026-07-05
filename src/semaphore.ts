/**
 * Global concurrency gate around the local Ollama instance.
 * Local inference is bottlenecked on VRAM and compute; letting 20 calls
 * race into llama.cpp just thrashes. Default to 2 concurrent calls.
 *
 * When the semaphore has to make a caller wait, we want the operator
 * reading the log to see "yes this was slow because the queue was full,
 * and here's a rough wait estimate" — not the default "why is Ollama slow?"
 * shrug. See `observeWait` and the `semaphore:wait` LogEvent for that path.
 */

import { InternError } from "./errors.js";

/**
 * Build an AbortError-named Error for a cancelled acquire. The name matches
 * the DOMException the fetch path throws on abort, so ollama.ts's
 * `err.name === "AbortError"` mapping treats a permit-queue cancellation
 * exactly like a fetch-abort (→ OLLAMA_TIMEOUT).
 */
function makeAbortError(): Error {
  const err = new Error("Semaphore acquire aborted before a permit was free");
  err.name = "AbortError";
  return err;
}

export class Semaphore {
  private permits: number;
  private maxPermits: number;
  private queue: Array<() => void> = [];
  /**
   * Start timestamps of in-flight holders, keyed by a monotonic ticket id.
   * A Map (not a FIFO array) is required so out-of-order release — which is
   * the common case once tier timeouts and heterogeneous call durations enter
   * the picture — deletes the correct entry. An earlier FIFO `shift()` would
   * drop the oldest marker regardless of which holder actually released,
   * corrupting the `expected_wait_ms` estimate in `snapshot()`.
   */
  private inFlightStartedAt = new Map<number, number>();
  private nextTicket = 0;

  constructor(permits: number) {
    this.permits = permits;
    this.maxPermits = permits;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    // H1: already cancelled before we even try — take no permit.
    if (signal?.aborted) throw makeAbortError();
    if (this.permits > 0) {
      this.permits--;
      const ticket = this.nextTicket++;
      this.inFlightStartedAt.set(ticket, Date.now());
      return () => this.release(ticket);
    }
    // Out of permits — queue. H1: make the wait abortable so a tier timeout
    // (or any caller signal) can DEQUEUE this waiter instead of leaving it
    // stuck until an unrelated holder releases far past its budget. A
    // cancelled waiter must never consume a permit.
    return new Promise<() => void>((resolve, reject) => {
      let cleanup = (): void => {};
      const grant = (): void => {
        cleanup();
        this.permits--;
        const ticket = this.nextTicket++;
        this.inFlightStartedAt.set(ticket, Date.now());
        resolve(() => this.release(ticket));
      };
      if (signal) {
        const onAbort = (): void => {
          // Remove this waiter so a later release() never runs it (which
          // would consume a permit for a call that already gave up), and
          // settle NOW rather than when an unrelated holder frees.
          const idx = this.queue.indexOf(grant);
          if (idx !== -1) this.queue.splice(idx, 1);
          cleanup();
          reject(makeAbortError());
        };
        cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(grant);
    });
  }

  private release(ticket: number): void {
    this.permits++;
    this.inFlightStartedAt.delete(ticket);
    const next = this.queue.shift();
    if (next) next();
  }

  /** For tests. */
  get pending(): number {
    return this.queue.length;
  }

  /** True if a caller attempting to acquire right now would have to wait. */
  get wouldBlock(): boolean {
    return this.permits <= 0;
  }

  /**
   * Snapshot for observability: queue depth, in-flight count, and a rough
   * expected-wait estimate based on the oldest in-flight request's age
   * (clamped at 0). Not precise — inference latency varies wildly — but
   * it's grounded in real state, not a guess.
   */
  snapshot(): { queue_depth: number; in_flight: number; expected_wait_ms: number } {
    const now = Date.now();
    // Oldest remaining in-flight start — smallest timestamp across all live
    // tickets. Map iteration order is insertion order, but out-of-order
    // release means the earliest insert may already be gone, so scan.
    let oldest: number | undefined;
    for (const started of this.inFlightStartedAt.values()) {
      if (oldest === undefined || started < oldest) oldest = started;
    }
    const typical = oldest !== undefined ? Math.max(0, now - oldest) : 0;
    return {
      queue_depth: this.queue.length,
      in_flight: this.maxPermits - this.permits,
      expected_wait_ms: typical,
    };
  }
}

/**
 * Parse INTERN_MAX_CONCURRENT with validation. `Number("abc")` silently
 * returns NaN, which produced a semaphore that blocked every acquire — the
 * operator saw "Ollama is slow" with no hint the concurrency cap was
 * misconfigured. Reject NaN, non-integers, and values < 1.
 */
function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return 2;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new InternError(
      "CONFIG_INVALID",
      `Invalid INTERN_MAX_CONCURRENT: '${raw}'`,
      `INTERN_MAX_CONCURRENT must be a positive integer; got '${raw}'`,
      false,
    );
  }
  return parsed;
}

/**
 * Lazily resolve the permit count the first time `ollamaSemaphore` is
 * touched, not at module load. Throwing at import time turned a malformed
 * INTERN_MAX_CONCURRENT into an unhelpful stack trace before main() had a
 * chance to catch it and print a human-readable message. Deferring to first
 * use lets main() / the test harness see a CONFIG_INVALID InternError at a
 * controllable point. Result is cached after first resolve so the semaphore
 * doesn't shape-shift if env changes mid-run.
 */
let _ollamaSemaphore: Semaphore | null = null;
function getOllamaSemaphore(): Semaphore {
  if (_ollamaSemaphore === null) {
    _ollamaSemaphore = new Semaphore(parseConcurrency(process.env.INTERN_MAX_CONCURRENT));
  }
  return _ollamaSemaphore;
}

/**
 * Exported proxy — forwards property access to the lazily-resolved singleton.
 * Lets existing `ollamaSemaphore.acquire()` / `.snapshot()` call sites keep
 * working without threading a resolver everywhere.
 */
export const ollamaSemaphore: Semaphore = new Proxy({} as Semaphore, {
  get(_t, prop: keyof Semaphore) {
    const sem = getOllamaSemaphore();
    const v = sem[prop];
    return typeof v === "function" ? v.bind(sem) : v;
  },
}) as Semaphore;

/** Exported for tests. */
export { parseConcurrency };
