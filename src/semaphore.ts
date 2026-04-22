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

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      const ticket = this.nextTicket++;
      this.inFlightStartedAt.set(ticket, Date.now());
      return () => this.release(ticket);
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.permits--;
        const ticket = this.nextTicket++;
        this.inFlightStartedAt.set(ticket, Date.now());
        resolve(() => this.release(ticket));
      });
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

const DEFAULT_CONCURRENCY = parseConcurrency(process.env.INTERN_MAX_CONCURRENT);

export const ollamaSemaphore = new Semaphore(DEFAULT_CONCURRENCY);

/** Exported for tests. */
export { parseConcurrency };
