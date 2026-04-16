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
