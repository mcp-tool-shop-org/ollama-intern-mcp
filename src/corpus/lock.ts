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
