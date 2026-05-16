/**
 * CLI surface tests (FT-001 / Phase 7) — exercises the four CLI verbs
 * wired in src/index.ts:runCli (--version / --help / doctor / init) and
 * the default no-args MCP-stdio behavior.
 *
 * Pattern: spawn `node dist/index.js <args>` as a subprocess, capture
 * stdout/stderr/exit-code, assert. Identical spawn machinery to
 * mcpGolden / mcp.integration but with a CLI-side timeout (5-8s) and
 * the no-stdin → exit-clean expectation for the verb subcommands.
 *
 * The default no-args case is the tricky one: with no CLI verb, the
 * process MUST enter MCP-stdio mode and stay alive waiting for stdin.
 * We assert this by spawning, sending NO messages, and observing the
 * process is still alive after 250ms (then killing it).
 *
 * Build prerequisite: `npm run build` must have produced dist/index.js.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST = resolve(__dirname, "../dist/index.js");

beforeAll(() => {
  if (!existsSync(DIST)) {
    throw new Error(
      `dist/index.js not built. Run \`npm run build\` before the CLI tests.`,
    );
  }
});

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if we killed the process because it stayed alive past `waitMs`. */
  killedAlive: boolean;
}

interface CliOptions {
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Override env for the spawned process. */
  env?: NodeJS.ProcessEnv;
  /** Max wait time before forcing kill. Default 8s. */
  waitMs?: number;
  /** Send this to stdin then close (default: don't write, close immediately). */
  stdin?: string;
  /**
   * Expect the process to STAY ALIVE (MCP stdio mode). When true, the spawn
   * fn waits `waitMs`, kills the proc, and returns `killedAlive: true`.
   * When false (default), expects the proc to exit on its own.
   */
  expectAlive?: boolean;
}

async function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  return new Promise((resolveFn, reject) => {
    const proc: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [DIST, ...args],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          // Default to m5-max (prewarm:[]) so the CLI subcommands don't
          // try to prewarm — they shouldn't anyway because they exit
          // before reaching main(), but defensive.
          INTERN_PROFILE: "m5-max",
          INTERN_SKIP_STARTUP_PROBE: "1",
          INTERN_LOG_PATH: join(
            tmpdir(),
            `intern-cli-${process.pid}-${Date.now()}.ndjson`,
          ),
          ...options.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const waitMs = options.waitMs ?? 8_000;
    let killedAlive = false;
    let timer: NodeJS.Timeout | null = null;

    if (options.expectAlive) {
      // The MCP stdio default — process MUST stay alive.
      timer = setTimeout(() => {
        killedAlive = true;
        proc.kill("SIGKILL");
      }, 500);
    } else {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(
          new Error(
            `CLI test timed out (${waitMs}ms). args=${JSON.stringify(args)}. stdout=${stdout.slice(0, 300)} stderr=${stderr.slice(0, 300)}`,
          ),
        );
      }, waitMs);
    }

    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    proc.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      resolveFn({ stdout, stderr, exitCode: code, killedAlive });
    });

    if (options.stdin !== undefined) {
      proc.stdin.write(options.stdin);
    }
    // Closing stdin signals EOF to the MCP transport which intentionally
    // shuts the server down (client disconnected). When testing the
    // stays-alive contract we must keep stdin open so the process can't
    // exit on EOF before our 500ms kill timer fires.
    if (!options.expectAlive) {
      proc.stdin.end();
    }
  });
}

// Opt-out for CI / low-resource environments.
const SKIP = process.env.SKIP_MCP_GOLDEN === "1";
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip("CLI surface — src/index.ts:runCli", () => {
  it("--version prints the package version and exits 0", async () => {
    const r = await runCli(["--version"]);
    expect(r.exitCode).toBe(0);
    // Output is the bare semver line.
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 15_000);

  it("-V is the short alias for --version", async () => {
    const r = await runCli(["-V"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 15_000);

  it("--help prints usage banner with COMMANDS section + exits 0", async () => {
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ollama-intern-mcp");
    expect(r.stdout).toContain("COMMANDS");
    expect(r.stdout).toContain("doctor");
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("--version");
    expect(r.stdout).toContain("--help");
  }, 15_000);

  it("-h is the short alias for --help", async () => {
    const r = await runCli(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("COMMANDS");
  }, 15_000);

  it("doctor subcommand runs ollama_doctor and exits 0 with a status report", async () => {
    // Even on a box without Ollama running, the doctor reports unreachable
    // cleanly — exit code stays 0 because doctor's job is REPORT, not GATE.
    const r = await runCli(["doctor"]);
    expect(r.exitCode).toBe(0);
    // The structured report names the active profile, tier models, host.
    expect(r.stdout).toContain("Profile:");
    expect(r.stdout).toContain("Tiers:");
    expect(r.stdout).toContain("Ollama:");
    expect(r.stdout).toContain("Models:");
    expect(r.stdout).toMatch(/Healthy:\s+(yes|no)/);
  }, 20_000);

  it("init subcommand scaffolds hermes.config.yaml in a fresh temp dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-cli-init-"));
    try {
      const r = await runCli(["init"], { cwd: dir });
      expect(r.exitCode).toBe(0);
      // The file lands in cwd as hermes.config.yaml.
      const target = join(dir, "hermes.config.yaml");
      expect(existsSync(target)).toBe(true);
      const content = await readFile(target, "utf8");
      // The scaffold should at least contain the profile reference —
      // any non-empty YAML scaffold suffices for this surface test.
      expect(content.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("init refuses to overwrite an existing hermes.config.yaml (exits 1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-cli-init-skip-"));
    try {
      // Pre-create the file — the init scaffold should refuse with exit 1.
      const target = join(dir, "hermes.config.yaml");
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(target, "preexisting: true\n", "utf8"),
      );
      const r = await runCli(["init"], { cwd: dir });
      expect(r.exitCode).toBe(1);
      // The error message points at the conflict and the recovery
      // (move or delete the existing file).
      expect(r.stderr).toContain("already exists");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("unknown subcommand exits 1 with a help pointer", async () => {
    const r = await runCli(["totally-not-a-command"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command");
    expect(r.stderr).toContain("--help");
  }, 15_000);

  it("no args — process enters MCP stdio mode and stays alive for stdin", async () => {
    // The default behavior is "be an MCP server" — process must stay
    // alive waiting for stdin. We spawn, give it 500ms to settle, kill
    // it, and assert it was killed by us (not exited on its own).
    const r = await runCli([], { expectAlive: true });
    // expectAlive mode kills the process after 500ms; killedAlive = true
    // means it was alive at kill time (we got the SIGKILL exit path).
    expect(r.killedAlive).toBe(true);
    // Exit code is null on Windows kill, or the signal code on POSIX
    // — both indicate kill, not voluntary exit. The contract is "did
    // not exit on its own before we killed it."
    // (Some Node versions surface signal as a non-zero code, others null.)
  }, 15_000);
});
