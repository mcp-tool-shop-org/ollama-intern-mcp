/**
 * Compile check — after ollama_draft produces code, run a cheap checker
 * and report {compiles, checker, stderr_tail} on the envelope.
 *
 * The stderr tail is the real value: a boolean tells you something broke,
 * the tail tells you *what* so review is useful instead of just binary.
 *
 * Never throws — compile failure is data, not an error. The tool handler
 * still returns the draft; the reviewer decides what to do.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SupportedLanguage = "typescript" | "javascript" | "python" | "rust" | "go";

export interface CompileCheckResult {
  compiles: boolean;
  checker: string;
  stderr_tail: string;
  skipped?: boolean;
  skip_reason?: string;
}

/** Last ~800 chars of stderr — enough for the interesting part without flooding the envelope. */
const STDERR_TAIL_CHARS = 800;
const CHECKER_TIMEOUT_MS = 15_000;

export async function compileCheck(
  code: string,
  language: string | undefined,
): Promise<CompileCheckResult> {
  if (!language) {
    return { compiles: false, checker: "none", stderr_tail: "", skipped: true, skip_reason: "no language specified" };
  }
  const lang = language.toLowerCase() as SupportedLanguage;
  switch (lang) {
    case "typescript":
      // `npx -p typescript -- tsc ...` tells npx WHICH package provides the tsc
      // binary. The old `npx -y typescript tsc` form treats "tsc" as an arg to
      // a nonexistent "typescript" binary and fails with "could not determine
      // executable to run" — found in the first live dogfood run.
      return runChecker(code, ".ts", "npx", ["-p", "typescript", "--", "tsc", "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "node"]);
    case "javascript":
      return runChecker(code, ".js", "node", ["--check"]);
    case "python":
      return runChecker(code, ".py", "python", ["-m", "py_compile"]);
    case "rust":
      return runChecker(code, ".rs", "rustc", ["--edition", "2021", "--emit=metadata", "-o", "/dev/null"]);
    case "go":
      return runChecker(code, ".go", "gofmt", ["-e"]);
    default:
      return { compiles: false, checker: "none", stderr_tail: "", skipped: true, skip_reason: `unsupported language: ${language}` };
  }
}

async function runChecker(
  code: string,
  ext: string,
  command: string,
  baseArgs: string[],
): Promise<CompileCheckResult> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "intern-check-"));
    const file = join(dir, `snippet${ext}`);
    await writeFile(file, code, "utf8");
    const args = [...baseArgs, file];
    const { code: exitCode, stdout, stderr } = await runProcess(command, args, CHECKER_TIMEOUT_MS);
    // tsc writes diagnostics to STDOUT, most other checkers to STDERR.
    // Merge both so the tail is useful regardless of the tool's habits.
    const diagnostics = [stderr, stdout].filter(Boolean).join("\n");
    return {
      compiles: exitCode === 0,
      checker: `${command} ${baseArgs.join(" ")}`.trim(),
      stderr_tail: tail(diagnostics, STDERR_TAIL_CHARS),
    };
  } catch (err) {
    return {
      compiles: false,
      checker: command,
      stderr_tail: "",
      skipped: true,
      skip_reason: `checker unavailable: ${(err as Error).message}`,
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // shell:true on Windows is required to resolve .cmd shims (npx, tsc).
    // Safe here because args are never user-controlled: cmd/baseArgs are hardcoded
    // above, and the only dynamic arg is a filename produced by mkdtemp + join,
    // which is a random OS-temp path — never untrusted input.
    const proc = spawn(cmd, args, { shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return "…" + s.slice(-n);
}

/**
 * Detail payload for an operator-facing structured event emitted after
 * the compile guardrail runs. Stage B audited compileCheck as emitting
 * NO event today — handlers got the result back as data and either
 * folded it into the envelope or ignored it. This helper closes that
 * gap so an operator reading log_tail can answer "did this draft
 * compile?" without inspecting the per-call envelope.
 *
 * Phase 7 / FT-001: `op` + `rule` stamped so jq filters uniformly with
 * `jq 'select(.op=="guardrail" and .detail.rule=="compile_check")'`.
 * `error_count` is a coarse signal — the full diagnostic still lives on
 * the envelope (`compile_check.stderr_tail`), the event just carries
 * enough for triage. The NDJSON logger auto-merges `run_id` from the
 * active AsyncLocalStorage `CorrelationContext` at write time
 * (see observability.withCorrelation).
 *
 * Pattern (wired by tools agent in src/tools/draft.ts):
 *
 *   const result = await compileCheck(draft, language);
 *   const detail = buildCompileCheckEvent({ result, file: snippet,
 *     language });
 *   await ctx.logger.log({ kind: 'guardrail', ts: ...,
 *     tool: 'ollama_draft', rule: detail.rule, action: detail.decision,
 *     detail });
 */
export interface CompileCheckEventDetail {
  /** Closed-enum op tag from observability.CorrelationOp. Always 'guardrail' here. */
  op: "guardrail";
  /** Stable rule identifier — greppable. */
  rule: "compile_check";
  /** Pass or fail — closed enum. */
  decision: "pass" | "fail";
  /** File path or snippet identifier the check ran against (caller-supplied). */
  file: string;
  /**
   * Language passed to compileCheck. May be undefined when the caller
   * didn't specify (in which case the check is skipped and decision
   * defaults to 'fail' with skipped:true on the underlying result).
   */
  language?: string;
  /**
   * Coarse count of compiler errors. Heuristic — derived from the
   * stderr_tail by counting lines containing "error" (case-insensitive)
   * or, if no such lines, by 1-when-failed / 0-when-passed. The full
   * diagnostic still lives on the envelope; this is for triage filters.
   */
  error_count: number;
  /** True when compileCheck skipped (no language, unsupported, or checker unavailable). */
  skipped?: boolean;
  /** Reason for skip when applicable. */
  skip_reason?: string;
  /** Identifier of the checker that ran (e.g. "tsc", "node --check"). */
  checker: string;
}

/**
 * Heuristic error counter — counts lines containing "error" in the
 * stderr tail. Falls back to 1 (failed) / 0 (passed) when no such lines
 * exist. Coarse on purpose — accurate counts would need per-checker
 * parsers and the full stderr is already on the envelope for callers
 * that care.
 */
function countErrorLines(stderrTail: string, compiles: boolean): number {
  if (!stderrTail) return compiles ? 0 : 1;
  const lines = stderrTail.split("\n");
  const matched = lines.filter((l) => /error/i.test(l)).length;
  if (matched > 0) return matched;
  return compiles ? 0 : 1;
}

/**
 * Build the structured-event detail for an operator log entry after the
 * compile-check guardrail ran. Always returns a detail (pass or fail)
 * so log_tail consumers can build a histogram of compile success rate
 * across drafts without scanning envelopes.
 *
 * Skipped checks are still emitted (with skipped:true) so an operator
 * can spot "this draft never got checked" and not confuse it with "this
 * draft compiled cleanly".
 */
export function buildCompileCheckEvent(args: {
  result: CompileCheckResult;
  file: string;
  language?: string;
}): CompileCheckEventDetail {
  const { result, file, language } = args;
  const detail: CompileCheckEventDetail = {
    op: "guardrail",
    rule: "compile_check",
    decision: result.compiles ? "pass" : "fail",
    file,
    error_count: countErrorLines(result.stderr_tail, result.compiles),
    checker: result.checker,
  };
  if (language !== undefined) detail.language = language;
  if (result.skipped) detail.skipped = true;
  if (result.skip_reason) detail.skip_reason = result.skip_reason;
  return detail;
}
