/**
 * ollama_batch_proof_check — NO-LLM tool.
 *
 * Shells out to the caller-selected typecheck/lint/test CLIs in parallel and
 * aggregates the results into a stable shape. This is the "did it pass?"
 * primitive for any multi-file refactor workflow — proof_check gives you the
 * green light, it doesn't generate new plans.
 *
 * Behavior:
 *   - Each check runs in parallel under its own timeout (default 60s per check).
 *   - Missing tools (ENOENT or exit 127) are reported as status:"missing"
 *     rather than "fail" — not installing ruff is not a test failure.
 *   - Timeouts are surfaced as status:"timeout" with the elapsed budget.
 *   - stdout/stderr tails are capped so the envelope stays reviewable.
 *
 * Extensibility:
 *   Tests swap out the spawn implementation via the internal `__setSpawner`
 *   hook so unit tests never have to invoke real CLIs. Production uses
 *   node:child_process.spawn.
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import type { RunContext } from "../runContext.js";

export const batchProofCheckSchema = z.object({
  checks: z
    .array(z.enum(["typescript", "eslint", "pytest", "ruff", "cargo-check"]))
    .min(1)
    .describe(
      "Which proof tools to run. Each runs in parallel. Missing tools are reported as status:'missing', not 'fail'.",
    ),
  files: strictStringArray({ min: 1, fieldName: "files" })
    .optional()
    .describe(
      "Optional scope filter. When set, each tool is invoked with the file list appended (where the tool supports it). Tools that require whole-project invocation (e.g. tsc --noEmit) ignore this.",
    ),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Working directory for the spawned CLIs. Default: process.cwd()."),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe("Timeout per check in milliseconds. Default 60_000."),
});

export type BatchProofCheckInput = z.infer<typeof batchProofCheckSchema>;

export type CheckStatus = "pass" | "fail" | "timeout" | "missing";

export interface ProofFailure {
  file?: string;
  line?: number;
  message: string;
}

export interface CheckResult {
  check: string;
  status: CheckStatus;
  exit_code: number | null;
  stderr_tail: string;
  stdout_tail: string;
  elapsed_ms: number;
  failures?: ProofFailure[];
}

export interface BatchProofCheckResult {
  checks: CheckResult[];
  all_passed: boolean;
  any_missing: boolean;
}

// ── Spawner abstraction (swappable for tests) ─────────────────

export interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  /** Set when the process was terminated because the timeout fired. */
  timed_out: boolean;
  /** Set when the executable could not be found (ENOENT). */
  not_found: boolean;
  elapsed_ms: number;
}

export type Spawner = (cmd: string, args: string[], opts: { cwd: string; timeout_ms: number }) => Promise<SpawnOutcome>;

function defaultSpawner(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout_ms: number },
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let notFound = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, shell: process.platform === "win32" });
    } catch (err) {
      // Synchronous throw from spawn — treat as missing.
      resolve({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exit_code: 127,
        timed_out: false,
        not_found: true,
        elapsed_ms: Date.now() - started,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, opts.timeout_ms);
    child.stdout?.on("data", (buf) => {
      stdout += buf.toString("utf8");
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on("data", (buf) => {
      stderr += buf.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("error", (err) => {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") notFound = true;
      stderr += `\n${err.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exit_code: code,
        timed_out: timedOut,
        not_found: notFound,
        elapsed_ms: Date.now() - started,
      });
    });
  });
}

let activeSpawner: Spawner = defaultSpawner;

/** Test hook — swap the spawn implementation. Production code never touches this. */
export function __setSpawner(s: Spawner | null): void {
  activeSpawner = s ?? defaultSpawner;
}

// ── Per-check command builders ───────────────────────────────

interface CheckSpec {
  cmd: string;
  args: string[];
  acceptsFiles: boolean;
}

function specFor(check: BatchProofCheckInput["checks"][number], files: string[] | undefined): CheckSpec {
  switch (check) {
    case "typescript":
      // tsc --noEmit is whole-project; per-file invocation loses tsconfig.
      return { cmd: "npx", args: ["tsc", "--noEmit"], acceptsFiles: false };
    case "eslint":
      return {
        cmd: "npx",
        args: files && files.length > 0 ? ["eslint", ...files] : ["eslint", "."],
        acceptsFiles: true,
      };
    case "pytest":
      return {
        cmd: "pytest",
        args: files && files.length > 0 ? [...files] : [],
        acceptsFiles: true,
      };
    case "ruff":
      return {
        cmd: "ruff",
        args: files && files.length > 0 ? ["check", ...files] : ["check", "."],
        acceptsFiles: true,
      };
    case "cargo-check":
      return { cmd: "cargo", args: ["check"], acceptsFiles: false };
    default: {
      // Exhaustiveness — `check` is a closed union.
      const _exhaustive: never = check;
      throw new Error(`unhandled check: ${String(_exhaustive)}`);
    }
  }
}

// ── Lightweight failure parsers ──────────────────────────────

function tail(text: string, maxLines = 20): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function parseFailures(check: string, stdout: string, stderr: string): ProofFailure[] {
  const combined = `${stdout}\n${stderr}`;
  const out: ProofFailure[] = [];
  // file:line:col — message pattern (tsc, eslint, ruff all use it).
  const tscRe = /([^\s:]+\.(?:ts|tsx|js|jsx|py|rs)):(\d+)(?::(\d+))?(?::|\s*-\s*)?\s*(.*?)$/gm;
  if (check === "typescript" || check === "eslint" || check === "ruff") {
    let m: RegExpExecArray | null;
    let hits = 0;
    while ((m = tscRe.exec(combined)) !== null && hits < 50) {
      hits += 1;
      const [, file, lineStr, , message] = m;
      if (!message || message.trim().length === 0) continue;
      const lineNum = Number.parseInt(lineStr, 10);
      out.push({ file, line: Number.isFinite(lineNum) ? lineNum : undefined, message: message.trim() });
    }
  }
  if (check === "pytest") {
    const lines = combined.split(/\r?\n/);
    for (const l of lines) {
      // "FAILED tests/foo.py::test_bar - AssertionError"
      const m = /FAILED\s+([^\s]+?)(?:::[^\s]+)?\s*(?:-\s*(.*))?$/.exec(l);
      if (m) out.push({ file: m[1], message: (m[2] ?? l).trim() });
    }
  }
  if (check === "cargo-check") {
    const lines = combined.split(/\r?\n/);
    for (const l of lines) {
      const m = /^error(?:\[[^\]]+\])?:\s*(.*)$/.exec(l);
      if (m) out.push({ message: m[1].trim() });
    }
  }
  return out;
}

// ── Core runner ──────────────────────────────────────────────

async function runOne(
  check: BatchProofCheckInput["checks"][number],
  files: string[] | undefined,
  cwd: string,
  timeoutMs: number,
): Promise<CheckResult> {
  const spec = specFor(check, files);
  const outcome = await activeSpawner(spec.cmd, spec.args, { cwd, timeout_ms: timeoutMs });

  let status: CheckStatus;
  if (outcome.not_found || outcome.exit_code === 127) {
    status = "missing";
  } else if (outcome.timed_out) {
    status = "timeout";
  } else if (outcome.exit_code === 0) {
    status = "pass";
  } else {
    status = "fail";
  }

  const result: CheckResult = {
    check,
    status,
    exit_code: outcome.exit_code,
    stderr_tail: tail(outcome.stderr),
    stdout_tail: tail(outcome.stdout),
    elapsed_ms: outcome.elapsed_ms,
  };
  if (status === "fail") {
    const failures = parseFailures(check, outcome.stdout, outcome.stderr);
    if (failures.length > 0) result.failures = failures;
  }
  return result;
}

export async function handleBatchProofCheck(
  input: BatchProofCheckInput,
  ctx: RunContext,
): Promise<Envelope<BatchProofCheckResult>> {
  const startedAt = Date.now();
  const cwd = input.cwd ?? process.cwd();
  const timeoutMs = input.timeout_ms ?? 60_000;

  const checkResults = await Promise.all(
    input.checks.map((c) => runOne(c, input.files, cwd, timeoutMs)),
  );

  const result: BatchProofCheckResult = {
    checks: checkResults,
    all_passed: checkResults.every((c) => c.status === "pass"),
    any_missing: checkResults.some((c) => c.status === "missing"),
  };

  const envelope = buildEnvelope<BatchProofCheckResult>({
    result,
    tier: "instant", // no model call — bucketed as instant so residency stays null
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
  });
  await ctx.logger.log(callEvent("ollama_batch_proof_check", envelope));
  return envelope;
}
