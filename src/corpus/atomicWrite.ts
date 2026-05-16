/**
 * Atomic JSON file write — write to <path>.tmp, fsync, then rename.
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
 */
import { open, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write `payload` to `path` atomically:
 *   1. Ensure parent directory exists.
 *   2. Write to `<path>.tmp` and fsync the file handle so bytes hit disk.
 *   3. Rename tmp → final (atomic on the same filesystem).
 *   4. On rename failure, best-effort unlink the tmp and rethrow.
 */
export async function atomicWriteFile(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(payload, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the temp file if rename failed.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
