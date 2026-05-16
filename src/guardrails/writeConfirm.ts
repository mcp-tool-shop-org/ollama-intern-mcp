/**
 * Write-confirm guardrail — refuses drafts targeting protected paths
 * unless the caller explicitly sets confirm_write: true.
 *
 * Uses the versioned list in ../protectedPaths.ts. Never accept a
 * path-list argument here — that would let callers sidestep the policy.
 */

import { InternError } from "../errors.js";
import { matchesProtectedPath, PROTECTED_PATHS_VERSION } from "../protectedPaths.js";

export interface WriteConfirmCheckInput {
  target_path: string | undefined;
  confirm_write: boolean | undefined;
}

export interface WriteConfirmResult {
  /** True when a write was blocked; handler must refuse. */
  blocked: boolean;
  /** Reason for block, for logging. */
  reason?: string;
  /** Matched protected pattern, for logging. */
  pattern?: string;
  /** Version of the protected-path list that evaluated this call. */
  rules_version: number;
}

export function checkWriteConfirm(input: WriteConfirmCheckInput): WriteConfirmResult {
  if (!input.target_path) {
    return { blocked: false, rules_version: PROTECTED_PATHS_VERSION };
  }
  const match = matchesProtectedPath(input.target_path);
  if (!match.protected) {
    return { blocked: false, rules_version: PROTECTED_PATHS_VERSION };
  }
  if (input.confirm_write === true) {
    return { blocked: false, rules_version: PROTECTED_PATHS_VERSION };
  }
  return {
    blocked: true,
    reason: match.rule?.reason ?? "Protected path",
    pattern: match.rule?.pattern,
    rules_version: PROTECTED_PATHS_VERSION,
  };
}

/** Throw the structured error to refuse. Handlers call this after logging. */
export function assertWriteAllowed(input: WriteConfirmCheckInput): void {
  const r = checkWriteConfirm(input);
  if (r.blocked) {
    throw new InternError(
      "PROTECTED_PATH_WRITE",
      `Refusing draft targeting protected path "${input.target_path}" (${r.pattern}): ${r.reason}`,
      "If you really mean to touch this path, re-call with confirm_write: true and review the diff carefully.",
      false,
    );
  }
}

/**
 * Detail payload for an operator-facing structured event emitted when
 * the write-confirm guardrail decides whether to allow a draft against
 * a protected path.
 *
 * Phase 7 / FT-001: includes the `rules_version` field that Stage B
 * audited as missing from emitted events. With it, an operator reading
 * log_tail can correlate "this allow happened under the v3 rule list"
 * to a known protected-paths bump and explain post-hoc why an earlier
 * call denied while a later one allowed.
 *
 * `op` + `rule` are stamped so jq filtering is uniform across all
 * guardrail events (`jq 'select(.op=="guardrail" and
 * .detail.rule=="write_confirm_decision")'`). The NDJSON logger
 * auto-merges `run_id` from the active AsyncLocalStorage
 * `CorrelationContext` at write time
 * (see observability.withCorrelation).
 *
 * Pattern (wired by tools agent at draft.ts call sites):
 *
 *   const result = checkWriteConfirm({ target_path, confirm_write });
 *   const detail = buildWriteConfirmEvent(target_path, result);
 *   await ctx.logger.log({ kind: 'guardrail', ts: ...,
 *     tool: 'ollama_draft', rule: detail.rule, action: detail.decision,
 *     detail });
 */
export interface WriteConfirmEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. Always 'guardrail' here. */
  op: "guardrail";
  /** Stable rule identifier — greppable. */
  rule: "write_confirm_decision";
  /** Allow or deny — closed enum. */
  decision: "allow" | "deny";
  /** Version of the protected-path list that evaluated this call. */
  rules_version: number;
  /**
   * Path the draft targeted (the literal value from the call). May be
   * empty/undefined when the caller didn't pass a target_path; the
   * decision is still recorded as 'allow' (no path → no protection).
   */
  target_path: string;
  /** Matched protected pattern, when decision is 'deny'. Omitted on allow. */
  pattern?: string;
  /** Reason string from the matched rule, when decision is 'deny'. */
  reason?: string;
}

/**
 * Build the structured-event detail for an operator log entry recording
 * the write-confirm decision. Always returns an event (allow OR deny) —
 * an "allow" record on a protected-path call is just as load-bearing
 * for audit as a deny, since it documents that confirm_write was
 * explicitly set by the caller.
 *
 * Returns null only when the input had no target_path AND the result
 * wasn't blocked — i.e., the guardrail had nothing to say. Callers can
 * skip the log call without an extra branch.
 */
export function buildWriteConfirmEvent(
  target_path: string | undefined,
  result: WriteConfirmResult,
): WriteConfirmEventDetail | null {
  // Nothing to log when there was no path AND no block. Avoids spamming
  // log_tail with one event per guardrail call on draft requests that
  // never targeted a protected path in the first place.
  if (!target_path && !result.blocked) return null;
  const detail: WriteConfirmEventDetail = {
    op: "guardrail",
    rule: "write_confirm_decision",
    decision: result.blocked ? "deny" : "allow",
    rules_version: result.rules_version,
    target_path: target_path ?? "",
  };
  if (result.pattern) detail.pattern = result.pattern;
  if (result.reason) detail.reason = result.reason;
  return detail;
}
