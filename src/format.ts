/**
 * Human-facing magnitude formatting.
 *
 * Operator-visible messages quote sizes in units a human can read at a
 * glance; the NDJSON `detail` payloads keep the raw integers (machines
 * read those). Before this helper existed the same 50 MB source cap was
 * spelled "50MB" in src/corpus/indexer.ts and "52428800-byte" in
 * src/sources.ts, and the rotation notice quoted "67108864 bytes" — the
 * operator had to count digits to learn whether they were 1.1x or 100x
 * over the line the message was asking them to act on.
 */

/**
 * Format a byte count as B / KB / MB / GB / TB.
 *
 * Divides by 1024 (matching `Math.round(x / 1024)` in src/tools/embed.ts
 * and the "50MB" spelling of the same binary cap in the corpus indexer)
 * and keeps one decimal, dropping a trailing `.0` so round caps read as
 * "50MB" rather than "50.0MB". Non-finite or negative input falls back to
 * the raw number so a bad call site can never throw inside an error path.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")}${units[unit]}`;
}
