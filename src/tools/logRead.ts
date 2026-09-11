/**
 * Bounded intern-log I/O for log_tail / log_stats / doctor.
 *
 * The NDJSON log is append-only with no rotation in this domain. A full
 * readFile + split('\n') of INTERN_LOG_PATH can stall or OOM the MCP
 * process after a long session. Tail/doctor read only a suffix; stats
 * streams line-by-line and refuses files past a hard byte cap.
 */

import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { InternError } from "../errors.js";

/** Last 8 MiB — enough for hundreds of envelopes; drops older head on huge logs. */
export const LOG_TAIL_SUFFIX_BYTES = 8 * 1024 * 1024;

/** Hard cap for log_stats. Streamed, but unbounded files are refused loud. */
export const LOG_STATS_MAX_BYTES = 64 * 1024 * 1024;

function logReadFailed(logPath: string, err: unknown): InternError {
  return new InternError(
    "LOG_READ_FAILED",
    `Cannot read log at ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
    "Check filesystem permissions on ~/.ollama-intern/ or override with INTERN_LOG_PATH.",
    false,
  );
}

/**
 * Read at most `suffixBytes` from the end of `logPath`. When the file is
 * larger, the first (possibly torn) line of the window is discarded so
 * JSON.parse never sees a mid-line prefix.
 */
export async function readLogSuffix(
  logPath: string,
  suffixBytes: number = LOG_TAIL_SUFFIX_BYTES,
): Promise<string> {
  const fh = await open(logPath, "r");
  try {
    const size = (await fh.stat()).size;
    if (size === 0) return "";
    const start = size > suffixBytes ? size - suffixBytes : 0;
    const length = size - start;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } finally {
    await fh.close();
  }
}

/**
 * Yield each NDJSON line without materializing the file as one string.
 * Throws LOG_READ_FAILED if the file exceeds LOG_STATS_MAX_BYTES.
 * ENOENT propagates so callers can map it to the missing-log soft-empty case.
 */
export async function* iterateLogLines(logPath: string): AsyncGenerator<string> {
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    throw logReadFailed(logPath, err);
  }
  if (size > LOG_STATS_MAX_BYTES) {
    throw new InternError(
      "LOG_READ_FAILED",
      `Log at ${logPath} is ${size} bytes, exceeding the ${LOG_STATS_MAX_BYTES}-byte stats cap.`,
      `ollama_doctor.paths.log_bytes reports the size. Rename or truncate ${logPath} (the writer also rotates log.ndjson → log.ndjson.1 once it crosses this cap on the next append). Then retry log_stats. log_tail still returns a bounded suffix without this cap.`,
      false,
    );
  }
  const stream = createReadStream(logPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    throw logReadFailed(logPath, err);
  }
}
