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
import { resolve, relative, isAbsolute } from "node:path";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { strictStringArray } from "../guardrails/stringifiedArrayGuard.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

/**
 * Reject file paths containing shell metacharacters.
 *
 * Why this exists: defaultSpawner runs with `shell: true` on Windows so npm
 * shims (npx.cmd / pytest.exe / ruff.exe) resolve through cmd.exe's PATHEXT
 * lookup — without it the spawn ENOENTs even when the tool is installed.
 * The trade-off is that cmd.exe expands metacharacters inside arguments
 * (& | ; ^ " > < ` \n \r ! % $), turning a caller-supplied path like
 * `foo & calc.exe` into a command-injection vector.
 *
 * `strictStringArray` validates type and emptiness but not content. We
 * reject any path containing a metacharacter BEFORE building argv. Spaces,
 * dots, parentheses, brackets, hyphens, and Unicode are all legitimate in
 * Windows paths and are NOT rejected — only the characters cmd.exe parses.
 *
 * Reference test cases:
 *   "C:\\Users\\me\\My Project\\file.ts"   — passes (legitimate)
 *   "src/(legacy)/foo.ts"                  — passes (legitimate)
 *   "foo & calc.exe"                       — rejects (& is cmd separator)
 *   "evil.ts; rm -rf /"                    — rejects (; is cmd separator)
 *   "x | y.ts"                             — rejects (| is cmd pipe)
 *   "%PATH%\\foo.ts"                       — rejects (% is cmd var expansion)
 */
const SHELL_METACHARACTERS = /[&|;^"><`\r\n!%$]/;

export function assertSafeFilePath(p: string, fieldName = "files"): void {
  // Leading dashes are CLI flags, not operands — `--config=...` must not
  // ride in the files[] slot even though hyphens mid-path are legitimate.
  if (p.startsWith("-")) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${fieldName}[]: path must not start with "-": ${p}`,
      "Leading-dash entries are forwarded as CLI flags to eslint/pytest/ruff (e.g. --config=...). Pass a relative or absolute path that does not begin with a dash.",
      false,
    );
  }
  const m = SHELL_METACHARACTERS.exec(p);
  if (m !== null) {
    throw new InternError(
      "SCHEMA_INVALID",
      `${fieldName}[]: path contains shell metacharacter ${JSON.stringify(m[0])}: ${p}`,
      `Paths passed to batch_proof_check are forwarded to a Windows shell to resolve npm shims. Strip or escape the metacharacter before calling — legitimate paths with spaces, dots, parens, or hyphens are fine.`,
      false,
    );
  }
}

/**
 * Canonical "is child contained in root" check — mirrors export.ts's
 * allowed_roots gate. After resolving both, path.relative() from root to
 * child must not climb out ("..") and must not be absolute (a different
 * Windows drive resolves to an absolute relative path). Pure path math —
 * does not touch the filesystem.
 */
function isContained(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * H7-res: OPTIONAL operator-declared exec-surface cap. Caller-declared
 * allowed_roots is self-satisfiable — a prompt-injected caller can declare any
 * root and a matching cwd. When the operator sets INTERN_BATCH_PROOF_ALLOWED_ROOTS
 * (mirroring INTERN_CORPUS_ALLOWED_ROOTS), the cwd must ALSO be contained in an
 * operator root, so a caller cannot widen the surface. Returns null (no cap)
 * when unset — caller-declared roots govern, preserving prior behavior.
 */
function operatorAllowedRoots(): string[] | null {
  const raw = process.env.INTERN_BATCH_PROOF_ALLOWED_ROOTS;
  if (!raw) return null;
  const sep = process.platform === "win32" ? ";" : ":";
  const roots = raw
    .split(sep)
    .map((r) => r.trim())
    .filter(Boolean);
  return roots.length > 0 ? roots : null;
}

/**
 * H7: refuse a caller-supplied cwd that isn't contained in a caller-declared
 * allowed_root. batch_proof_check shells out to eslint/pytest/etc., which
 * execute config + plugins FROM the cwd — an undeclared cwd is an
 * arbitrary-code-execution surface. Throws SCHEMA_INVALID (before any child
 * is spawned) when allowed_roots is missing/empty or the cwd escapes. H7-res:
 * ALSO enforce the operator env cap (a caller can't widen it).
 */
function assertCwdContained(cwd: string, allowedRoots: string[] | undefined): void {
  if (!allowedRoots || allowedRoots.length === 0) {
    throw new InternError(
      "SCHEMA_INVALID",
      "batch_proof_check: a custom cwd requires a non-empty allowed_roots.",
      "When you pass an explicit cwd, also declare allowed_roots (absolute directories the proof run may launch from) — the run executes tool config (eslint.config.js, plugins, pytest conftest) from the cwd, so an undeclared cwd is a code-execution surface. Omit cwd to run in the server's own working directory.",
      false,
    );
  }
  if (!allowedRoots.some((root) => isContained(cwd, root))) {
    throw new InternError(
      "SCHEMA_INVALID",
      `batch_proof_check: cwd is not contained in any allowed_roots: ${cwd}`,
      `Allowed roots: ${allowedRoots.join(", ")}. Add the cwd's parent to allowed_roots, or pick a cwd inside a declared root.`,
      false,
    );
  }
  // H7-res: the operator cap wins over the (self-satisfiable) caller roots.
  assertCwdWithinOperatorCap(cwd);
}

/**
 * H7-res: enforce ONLY the optional operator cap (INTERN_BATCH_PROOF_ALLOWED_ROOTS).
 * Split out from assertCwdContained so it can ALSO gate the DEFAULT cwd
 * (`process.cwd()`) when the caller omits `cwd` — otherwise an operator who
 * restricts the exec surface is bypassed by simply omitting the parameter (the
 * jury caught exactly this). No-op when the cap is unset.
 */
function assertCwdWithinOperatorCap(cwd: string): void {
  const opRoots = operatorAllowedRoots();
  if (opRoots && !opRoots.some((root) => isContained(cwd, root))) {
    throw new InternError(
      "SCHEMA_INVALID",
      `batch_proof_check: cwd is outside the operator-declared INTERN_BATCH_PROOF_ALLOWED_ROOTS: ${cwd}`,
      `The operator restricted proof runs to: ${opRoots.join(", ")}. A caller cannot widen this — pick a cwd inside an operator-allowed root, or ask the operator to adjust INTERN_BATCH_PROOF_ALLOWED_ROOTS.`,
      false,
    );
  }
}

/**
 * files[] are appended onto eslint/pytest/ruff argv, so they must sit
 * under the spawn cwd or a caller-declared allowed_root — same
 * containment math as the cwd/export gates. Relative entries resolve
 * against the spawn cwd (not process.cwd()), matching how the child
 * will see them.
 */
function assertFileContained(p: string, cwd: string, allowedRoots: string[] | undefined): void {
  const resolvedFile = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const roots = [cwd, ...(allowedRoots ?? [])];
  if (!roots.some((root) => isContained(resolvedFile, root))) {
    throw new InternError(
      "SCHEMA_INVALID",
      `batch_proof_check: files[] path is not contained in cwd/allowed_roots: ${p}`,
      `Resolved to ${resolvedFile}. Allowed roots: ${roots.join(", ")}. Pass a path inside the proof cwd or a declared allowed_root.`,
      false,
    );
  }
}

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
    .describe("Working directory for the spawned CLIs. Default: process.cwd(). When set, must be contained in allowed_roots."),
  allowed_roots: z
    .array(
      z
        .string()
        .min(1)
        .refine((p) => isAbsolute(p), {
          message: "allowed_roots entries must be absolute paths (a relative root is a moving target)",
        }),
    )
    .optional()
    .describe(
      "Absolute directories a custom `cwd` may launch from. REQUIRED when `cwd` is set — the proof run executes tool config (eslint.config.js, plugins, pytest conftest) FROM the cwd, so an undeclared cwd is a code-execution surface. Entries must be absolute. Omit both to run in the server's own working directory.",
    ),
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
        args: files && files.length > 0 ? ["eslint", "--", ...files] : ["eslint", "."],
        acceptsFiles: true,
      };
    case "pytest":
      return {
        cmd: "pytest",
        args: files && files.length > 0 ? ["--", ...files] : [],
        acceptsFiles: true,
      };
    case "ruff":
      return {
        cmd: "ruff",
        args: files && files.length > 0 ? ["check", "--", ...files] : ["check", "."],
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
  // H7: a caller-supplied cwd must be contained in a caller-declared
  // allowed_roots — the proof run executes tool config (eslint.config.js,
  // plugins, pytest conftest) FROM the cwd, so an undeclared cwd is an
  // arbitrary-code-execution surface (SECURITY.md #8). Validate BEFORE
  // spawning any child. Omitting cwd uses the server's own trusted cwd.
  // H7-res: resolve the cwd ONCE and use the same absolute value for both the
  // containment check and spawn. A relative input.cwd would otherwise be
  // re-resolved against process.cwd() at spawn time — so the path validated
  // wouldn't be byte-identical to the path the child actually launches from.
  const cwd = input.cwd !== undefined ? resolve(input.cwd) : process.cwd();
  if (input.cwd !== undefined) {
    assertCwdContained(cwd, input.allowed_roots);
  } else {
    // H7-res follow-up (jury finding): no caller cwd, but the operator cap (if
    // set) still bounds the exec surface — an operator restricting proof runs
    // must not be bypassed by omitting cwd. The default is the server's own
    // process.cwd(); a cap that excludes it is honored.
    assertCwdWithinOperatorCap(cwd);
  }
  const timeoutMs = input.timeout_ms ?? 60_000;

  // Pre-validate every file path BEFORE building argv. defaultSpawner runs
  // with `shell: true` on Windows (required for npm-shim resolution); cmd.exe
  // would otherwise expand & | ; ^ " > < and friends inside arguments,
  // turning a caller-controlled file path into a command-injection vector.
  if (input.files) {
    for (const p of input.files) {
      assertSafeFilePath(p, "files");
      assertFileContained(p, cwd, input.allowed_roots);
    }
  }

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
