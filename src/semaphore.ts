/**
 * Global concurrency gate around the local Ollama instance.
 * Local inference is bottlenecked on VRAM and compute; letting 20 calls
 * race into llama.cpp just thrashes. Default to 2 concurrent calls.
 */

export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.permits--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) next();
  }

  /** For tests. */
  get pending(): number {
    return this.queue.length;
  }
}

const DEFAULT_CONCURRENCY = Number(process.env.INTERN_MAX_CONCURRENT ?? 2);

export const ollamaSemaphore = new Semaphore(DEFAULT_CONCURRENCY);
