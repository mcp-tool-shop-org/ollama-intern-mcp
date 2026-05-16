/**
 * Atomic JSON file write — write to <path>.tmp, fsync, rename, fsync(parent).
 *
 * Used by both saveCorpus (storage.ts) and saveManifest (manifest.ts) so
 * that the corpus JSON and manifest JSON paired under a single
 * indexCorpus/refreshCorpus call are individually durable. If the process
 * crashes mid-write, the original file is intact — rename on the same
 * filesystem is atomic on both POSIX and NTFS.
 *
 * Without this, a torn write on the manifest would leave a truncated JSON
 * on disk that loadManifest(...).catch(() => null) silently swallows,
 * making the per-corpus lock's "one logical state" guarantee a half-truth.
 *
 * Two humanization additions (Stage C):
 *   1. POSIX parent-dir fsync. rename(2)'s atomicity guarantee only
 *      promises the new dir-entry is visible immediately; for the entry
 *      change itself to survive a crash, the parent directory's journal
 *      must also be synced. See https://lwn.net/Articles/322823/ and the
 *      ext4/xfs documentation. We swallow failures here (some filesystems
 *      legitimately don't support dir-fsync) — the rename already happened
 *      and durability hardening is best-effort, not a correctness gate.
 *
 *   2. All-failure-path .tmp cleanup. The earlier version only cleaned up
 *      on rename failure; ENOSPC / EIO during writeFile or fsync leaked
 *      .tmp files indefinitely because listCorpora filters .tmp out so a
 *      growing collection of orphans was silently invisible until the disk
 *      filled. We now best-effort unlink the tmp on ANY throw between
 *      create and rename, and when the cleanup itself fails the supplied
 *      onOrphan callback (if any) fires so an operator-facing logger can
 *      record an `atomic_write_orphan` event for grep.
 */
import { open, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Optional callback invoked when a `.tmp` file orphan was left behind
 * because cleanup itself failed. Carries enough detail for an operator
 * to find the leak (path + the underlying cleanup error message).
 *
 * Callers wiring an NDJSON logger should map this to a structured event
 * built via `buildAtomicWriteOrphanEvent` so the resulting log line
 * carries the canonical Phase 7 / FT-001 shape (`op: 'pack_step'` is
 * the closest fit on the closed CorrelationOp enum — corpus writes are
 * pack-step-adjacent operations, not user-facing guardrails). The
 * NDJSON logger auto-merges `run_id` from the active AsyncLocalStorage
 * `CorrelationContext` at write time.
 */
export type OrphanCallback = (info: { path: string; cleanup_error: string }) => void;

/**
 * Detail payload for an operator-facing structured event emitted when
 * a `.tmp` file orphan was left behind because cleanup itself failed.
 *
 * Phase 7 / FT-001: `op` and `rule` are stamped so jq filtering is
 * uniform. The corpus atomicWrite path is a pack-step-adjacent
 * operation (it fires from index/refresh/amend pipelines), so we tag
 * it as `op: 'pack_step'` rather than minting a new op value — this
 * keeps the closed enum tight per the corpus-guards lock. If a future
 * integration surfaces standalone atomic-write events outside any pack
 * pipeline, that's the moment to revisit; today every reachable call
 * site is inside a pack-style multi-step operation.
 *
 * Wiring (callers with a logger should use this pattern):
 *
 *   await atomicWriteFile(path, payload, (info) => {
 *     void ctx.logger.log({
 *       kind: 'pack_step',
 *       ts: new Date().toISOString(),
 *       pack: '<incident|repo|change>',
 *       step: 'corpus_write',
 *       step_index: <n>,
 *       total_steps: <N>,
 *       // additive fields — NDJSON serializer accepts them, full
 *       // typing lands when backend-core widens LogEvent:
 *       ...buildAtomicWriteOrphanEvent(info),
 *     } as any);
 *   });
 *
 * For a corpus operation that's NOT inside a pack (e.g., a direct
 * corpus_index call from a non-pack tool), use `op: 'pack_step'` on a
 * synthetic step to keep filterability uniform. The closed-enum
 * discipline matters more than perfect semantic fit at this layer.
 */
export interface AtomicWriteOrphanEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. */
  op: "pack_step";
  /** Stable rule identifier — greppable. */
  rule: "atomic_write_orphan";
  /** Path of the .tmp file that could not be cleaned up. */
  path: string;
  /** Error message from the failed cleanup. */
  cleanup_error: string;
}

/**
 * Build the structured-event detail for an operator log entry when
 * `.tmp` cleanup failed. Pure shaping — does NOT call the logger
 * itself (atomicWrite is intentionally logger-free; the orphan
 * callback is the integration point).
 */
export function buildAtomicWriteOrphanEvent(info: {
  path: string;
  cleanup_error: string;
}): AtomicWriteOrphanEventDetail {
  return {
    op: "pack_step",
    rule: "atomic_write_orphan",
    path: info.path,
    cleanup_error: info.cleanup_error,
  };
}

/**
 * Write `payload` to `path` atomically:
 *   1. Ensure parent directory exists.
 *   2. Write to `<path>.tmp` and fsync the file handle so bytes hit disk.
 *      On ANY throw between create and rename, best-effort unlink the tmp
 *      so a partial write doesn't leak (ENOSPC, EIO, abort, etc.).
 *   3. Rename tmp → final (atomic on the same filesystem). On rename
 *      failure, best-effort unlink the tmp and rethrow.
 *   4. POSIX: fsync the parent directory so the rename's dir-entry change
 *      survives a crash. Failures here are logged-and-swallowed — the
 *      file rename already succeeded; dir-fsync is durability hardening,
 *      not a correctness invariant.
 *
 * `onOrphan` (optional) fires when a tmp cleanup itself fails (rare —
 * usually because the tmp never got created). Wire this from callers
 * that have a logger to emit `atomic_write_orphan` events.
 */
export async function atomicWriteFile(
  path: string,
  payload: string,
  onOrphan?: OrphanCallback,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;

  // Phase 1: write + fsync the tmp file. On ANY failure (ENOSPC during
  // writeFile, EIO during sync, fh.close itself throwing), best-effort
  // unlink the tmp before rethrowing so we don't accumulate orphans.
  // ENOENT-from-unlink is fine (means the file was never created); other
  // unlink failures get surfaced via onOrphan so the operator can find
  // and rm the leak by grep.
  try {
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(payload, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await cleanupTmp(tmpPath, onOrphan);
    throw err;
  }

  // Phase 2: atomic rename. Same disposition as Phase 1 — cleanup on
  // throw before propagating.
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await cleanupTmp(tmpPath, onOrphan);
    throw err;
  }

  // Phase 3: POSIX parent-dir fsync (durability hardening).
  // rename(2)'s atomicity guarantee promises the new dir-entry is visible
  // immediately, but for the dir-entry change to SURVIVE a crash, the
  // parent's directory journal must also be flushed. See:
  //   https://lwn.net/Articles/322823/
  // Skipped on Windows: NTFS doesn't expose a dir-fsync concept and the
  // operation isn't meaningful there (the journal is per-volume).
  // Failures are logged-and-swallowed: the file rename already succeeded;
  // some filesystems (tmpfs, some FUSE mounts) legitimately don't support
  // dir-fsync and surfacing EINVAL would be operator-hostile.
  if (process.platform !== "win32") {
    try {
      const dirFh = await open(dirname(path), "r");
      try {
        await dirFh.sync();
      } finally {
        await dirFh.close();
      }
    } catch (err) {
      // Don't throw — file is already renamed and durable; dir-fsync is
      // best-effort hardening. Emit one stderr warning so an operator who
      // cares about crash-survival on this filesystem can diagnose it.
      // eslint-disable-next-line no-console
      console.error(
        `ollama-intern: parent-dir fsync failed for ${dirname(path)} (${
          (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN"
        }: ${err instanceof Error ? err.message : String(err)}). File rename succeeded; durability hardening skipped on this filesystem.`,
      );
    }
  }
}

/**
 * Best-effort unlink of a `.tmp` orphan. ENOENT is normal (the tmp never
 * got created); any other failure fires `onOrphan` if provided so the
 * caller can record an `atomic_write_orphan` event.
 */
async function cleanupTmp(tmpPath: string, onOrphan?: OrphanCallback): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return; // never created, nothing to clean
    if (onOrphan) {
      try {
        onOrphan({
          path: tmpPath,
          cleanup_error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Logging callbacks must never make the original error worse.
      }
    }
  }
}
