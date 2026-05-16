/**
 * stringifiedArrayGuard — diagnostic schema helper.
 *
 * Problem:
 *   Some callers (observed in the repo-dataset marketing swarm, 2026-04-17)
 *   serialize nested array params as JSON strings before the MCP transport
 *   sees them. `source_paths: ["file.md"]` arrives at the server as
 *   `"[\"file.md\"]"` — a string. Strict `z.array(z.string())` then fails
 *   with a generic "expected array, received string", which hides the real
 *   cause (upstream stringification) behind a schema error the caller can't
 *   act on.
 *
 * Decision (user-directed, 2026-04-17):
 *   Keep the public contract strict — do NOT silently coerce. Instead, when
 *   a string arrives where an array is required, emit a diagnostic error
 *   that explicitly names the upstream-stringification case and tells the
 *   caller to fix their tool-call path. This keeps the product honest while
 *   giving the offending caller a fast signal. If later evidence shows
 *   multiple uncontrolled callers, a compatibility-coercion path can be
 *   added behind an explicit, warning-counted flag — but not yet.
 *
 * Parent doc: memory/ollama-intern-output-quality-report-2026-04-17.md
 * Runbook:    memory/ollama-intern-phase-a-runbook-2026-04-17.md
 */

import { z } from "zod";

export interface StrictStringArrayOpts {
  min?: number;
  max?: number;
  minItemLen?: number;
  fieldName?: string;
}

function buildStringDiagnostic(
  value: string,
  fieldName: string | undefined,
): string {
  const field = fieldName ?? "field";
  const trimmed = value.trim();
  const looksLikeJsonArray =
    trimmed.startsWith("[") && trimmed.endsWith("]");
  const preview =
    trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;

  if (looksLikeJsonArray) {
    return (
      `Stringified array detected on \`${field}\`. ` +
      `Expected array<string>, received a string containing JSON: "${preview}". ` +
      `The caller serialized the array before the MCP transport saw it — ` +
      `fix the caller, not the server. ` +
      `If you are a subagent, swarm, or custom tool-call path, ` +
      `your serializer is JSON-encoding nested params; pass the array as a native array.`
    );
  }
  return (
    `Expected array<string> on \`${field}\`, got string "${preview}". ` +
    `Wrap single values as an array: ["value"], not "value".`
  );
}

/**
 * Detail payload for an operator-facing structured event emitted when
 * the strict-string-array schema rejects upstream-stringified input.
 *
 * Stage B audited this guardrail as stderr-only — the diagnostic landed
 * in the MCP host's stderr capture but never in the structured NDJSON
 * log, so an operator triaging from log_tail couldn't see WHICH caller
 * had a broken serializer. This helper gives callers (or a thin wrapper
 * — see below) a path to emit the same signal as a structured event.
 *
 * Phase 7 / FT-001: `op` + `rule` stamped so jq filters uniformly with
 * `jq 'select(.op=="guardrail" and
 * .detail.rule=="stringified_array_guard")'`. The NDJSON logger
 * auto-merges `run_id` from the active AsyncLocalStorage
 * `CorrelationContext` at write time
 * (see observability.withCorrelation).
 *
 * The pre-existing stderr emit is preserved for back-compat with any
 * operator who already greps stderr; the new event is additive.
 */
export interface StringifiedArrayEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. Always 'guardrail' here. */
  op: "guardrail";
  /** Stable rule identifier — greppable. */
  rule: "stringified_array_guard";
  /** The schema field that was misformed (caller-supplied). */
  field: string;
  /**
   * True when the offending value's contents look like a JSON-encoded
   * array (starts with [ and ends with ]). Lets an operator filter for
   * the most common cause (caller serializer JSON-encoding nested
   * params) versus a caller passing a single value where an array was
   * expected.
   */
  looks_like_json_array: boolean;
  /**
   * Truncated preview of the offending value (first 80 chars). Enough
   * to recognize the shape; not enough to leak large inputs into the
   * log.
   */
  value_preview: string;
}

/** Shared truncation budget — must match the in-line preview built above. */
const VALUE_PREVIEW_CHARS = 80;

/**
 * Build the structured-event detail for an operator log entry when the
 * strict-string-array guard rejected a stringified value. Callers with
 * access to the offending input and field name pass them in; the helper
 * does not have a logger of its own (Stage B kept it stderr-only and
 * the schema layer can't reach into the request handler's logger).
 *
 * Wrappers in src/tools/* that catch the schema error can call this
 * with the original `value` and `fieldName` to wire the structured
 * event alongside the existing stderr line.
 */
export function buildStringifiedArrayEvent(args: {
  value: unknown;
  fieldName?: string;
}): StringifiedArrayEventDetail {
  const { value, fieldName } = args;
  const stringValue = typeof value === "string" ? value : String(value ?? "");
  const trimmed = stringValue.trim();
  const looksLikeJsonArray =
    trimmed.startsWith("[") && trimmed.endsWith("]");
  const preview =
    trimmed.length > VALUE_PREVIEW_CHARS
      ? `${trimmed.slice(0, VALUE_PREVIEW_CHARS)}...`
      : trimmed;
  return {
    op: "guardrail",
    rule: "stringified_array_guard",
    field: fieldName ?? "?",
    looks_like_json_array: looksLikeJsonArray,
    value_preview: preview,
  };
}

/**
 * Strict array<string> schema with diagnostic for upstream-stringified input.
 *
 * Behavior:
 * - array<string> matching min/max/minItemLen: pass
 * - string (any shape): fail with specific diagnostic naming the
 *   stringification case when the string looks like a JSON array,
 *   or with a "wrap in array" hint otherwise
 * - anything else: fail with zod's normal messages
 *
 * Output type is `string[]`. Chain `.optional()` for optional fields.
 */
export function strictStringArray(
  opts: StrictStringArrayOpts = {},
): z.ZodType<string[]> {
  const min = opts.min ?? 1;
  const max = opts.max;
  const minItemLen = opts.minItemLen ?? 1;
  const fieldName = opts.fieldName;

  const real = (() => {
    let s = z.array(z.string().min(minItemLen)).min(min);
    if (max !== undefined) s = s.max(max);
    return s;
  })();

  return z
    .any()
    .transform((v, ctx): string[] => {
      if (typeof v === "string") {
        // Log to stderr so MCP host captures the diagnostic event even
        // though the handler never runs. Tagged for grep.
        // eslint-disable-next-line no-console
        console.error(
          `[ollama-intern:stringified-array-guard] field=${
            fieldName ?? "?"
          } received=string looks_like_json_array=${
            v.trim().startsWith("[") && v.trim().endsWith("]")
          }`,
        );
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: buildStringDiagnostic(v, fieldName),
        });
        return z.NEVER;
      }
      const res = real.safeParse(v);
      if (!res.success) {
        for (const issue of res.error.issues) ctx.addIssue({ ...issue });
        return z.NEVER;
      }
      return res.data;
    }) as unknown as z.ZodType<string[]>;
}
