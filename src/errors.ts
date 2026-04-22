/**
 * Structured error shape — code / message / hint / retryable.
 * Matches shipcheck hard gate B: no raw stacks, always a hint, always a retry signal.
 */

export type ErrorCode =
  | "OLLAMA_UNREACHABLE"
  | "OLLAMA_MODEL_MISSING"
  | "OLLAMA_TIMEOUT"
  | "TIER_TIMEOUT"
  | "PROTECTED_PATH_WRITE"
  | "CITATION_INVALID"
  | "COMPILE_FAILED"
  | "EXTRACT_UNPARSEABLE"
  | "SOURCE_PATH_NOT_FOUND"
  | "SCHEMA_INVALID"
  | "DRAFT_BANNED_PHRASE"
  | "EMBED_COUNT_MISMATCH"
  | "EMBED_DIMENSION_MISMATCH"
  | "SYMLINK_NOT_ALLOWED"
  | "CONFIG_INVALID"
  | "INTERNAL";

export class InternError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "InternError";
  }
}

export interface ErrorShape {
  error: true;
  code: ErrorCode;
  message: string;
  hint: string;
  retryable: boolean;
}

export function toErrorShape(err: unknown): ErrorShape {
  if (err instanceof InternError) {
    return { error: true, code: err.code, message: err.message, hint: err.hint, retryable: err.retryable };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    error: true,
    code: "INTERNAL",
    message,
    hint: "Unexpected error. Check ~/.ollama-intern/log.ndjson for details.",
    retryable: false,
  };
}
