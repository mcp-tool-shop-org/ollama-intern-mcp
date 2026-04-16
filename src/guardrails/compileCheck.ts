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
      return runChecker(code, ".ts", "npx", ["-y", "typescript", "tsc", "--noEmit", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext"]);
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
    const { code: exitCode, stderr } = await runProcess(command, args, CHECKER_TIMEOUT_MS);
    return {
      compiles: exitCode === 0,
      checker: `${command} ${baseArgs.join(" ")}`.trim(),
      stderr_tail: tail(stderr, STDERR_TAIL_CHARS),
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
