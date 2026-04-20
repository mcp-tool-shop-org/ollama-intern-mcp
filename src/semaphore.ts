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

export class Semaphore {
  private permits: number;
  private maxPermits: number;
  private queue: Array<() => void> = [];
  /** Start timestamps of in-flight holders — used to estimate wait time. */
  private inFlightStartedAt: number[] = [];

  constructor(permits: number) {
    this.permits = permits;
    this.maxPermits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      this.inFlightStartedAt.push(Date.now());
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.permits--;
        this.inFlightStartedAt.push(Date.now());
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.permits++;
    // Remove the oldest in-flight marker — we don't track per-release identity,
    // so drain FIFO. Good enough for wait estimation.
    this.inFlightStartedAt.shift();
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
    const oldest = this.inFlightStartedAt[0];
    // Assume the oldest call finishes soon; remaining queue ahead of us waits
    // queue_depth * typical-duration. Use oldest-age as a proxy for typical.
    const typical = oldest !== undefined ? Math.max(0, now - oldest) : 0;
    return {
      queue_depth: this.queue.length,
      in_flight: this.maxPermits - this.permits,
      expected_wait_ms: typical,
    };
  }
}

const DEFAULT_CONCURRENCY = Number(process.env.INTERN_MAX_CONCURRENT ?? 2);

export const ollamaSemaphore = new Semaphore(DEFAULT_CONCURRENCY);
