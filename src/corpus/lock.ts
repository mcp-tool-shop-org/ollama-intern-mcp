/**
 * Per-corpus serialization lock.
 *
 * The corpus JSON (<name>.json) and manifest JSON (<name>.manifest.json)
 * are two separate files written under a single indexCorpus/refreshCorpus
 * call. Two concurrent mutators racing on the same corpus name can
 * interleave those writes — one saves corpus, the other saves manifest,
 * the pair no longer describes the same state.
 *
 * The fix is to serialize every mutating operation per corpus name. This
 * in-process lock is enough: the corpus files live under a single
 * ~/.ollama-intern/corpora/ directory shared by a single running server
 * process. Multi-process access (two servers, same corpus dir) is not a
 * supported configuration.
 *
 * Implementation: one Promise<void> per corpus name. Each caller awaits
 * the prior promise, then registers its own. Released in a `finally` so a
 * throw inside `fn` doesn't strand the lock.
 *
 * Phase 7 / FT-001 event-emission policy: `withCorpusLock` is silent
 * by default. A future wave can wire an optional `onWait` callback for
 * operators who want lock-contention visibility; today the only
 * structured surface is `buildCorpusLockWaitEvent` below for consumers
 * that detect contention through other means (timing on a wrapped
 * call). Tagged `op: 'pack_step'` to keep the closed CorrelationOp
 * enum tight; corpus mutation is pack-step-adjacent.
 */

const LOCKS = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while serialized against other calls for the same `name`.
 * Resolves (or rejects) with whatever `fn` returns. Other callers queued
 * on the same name wait until this one finishes.
 */
export async function withCorpusLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prior = LOCKS.get(name);
  // Chain onto the prior lock, swallowing its result so our own fn runs
  // regardless of whether the prior call succeeded or threw. This keeps
  // one failed index from permanently poisoning the lock for that name.
  const next = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(fn);
  LOCKS.set(name, next);
  try {
    return await next;
  } finally {
    // If the current lock is still the head of the chain, clear it so
    // the Map doesn't grow unbounded across many distinct corpus names.
    // A newer waiter may have already replaced us — in that case, leave
    // the newer promise in place.
    if (LOCKS.get(name) === next) {
      LOCKS.delete(name);
    }
  }
}

/**
 * Detail payload for an operator-facing structured event emitted when
 * a corpus lock acquire had to wait (a prior mutator was in flight on
 * the same name). Lock contention is rare in single-process operation
 * but nonzero — concurrent index/refresh on the same corpus serializes
 * here, and an operator debugging "why was this slow?" benefits from
 * a wait_ms readout.
 *
 * Phase 7 / FT-001: tagged `op: 'pack_step'` (corpus mutation is
 * pack-step-adjacent; a separate corpus_lock op would inflate the
 * closed CorrelationOp enum). The NDJSON logger auto-merges `run_id`
 * from ALS at write time.
 *
 * `withCorpusLock` does NOT call this helper itself — wiring is the
 * caller's responsibility (a tool handler that times the lock and
 * emits the event when wait_ms exceeds its threshold).
 */
export interface CorpusLockWaitEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. */
  op: "pack_step";
  /** Stable rule identifier — greppable. */
  rule: "corpus_lock_wait";
  /** Corpus name being acquired. */
  name: string;
  /** Wait duration in milliseconds. */
  wait_ms: number;
}

/**
 * Build the structured-event detail for a corpus lock wait. Pure
 * shaping — does NOT call the logger itself.
 */
export function buildCorpusLockWaitEvent(args: {
  name: string;
  wait_ms: number;
}): CorpusLockWaitEventDetail {
  return {
    op: "pack_step",
    rule: "corpus_lock_wait",
    name: args.name,
    wait_ms: args.wait_ms,
  };
}
