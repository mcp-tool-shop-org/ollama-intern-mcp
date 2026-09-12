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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

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
  /**
   * Remove these keys from the inherited env. The doctor report branches on
   * OLLAMA_API_KEY / OLLAMA_CLOUD_* presence, so the "no cloud configured"
   * case has to be asserted on a box whose operator may well have a key
   * exported — inheriting one silently turns a negative test green.
   */
  deleteEnv?: string[];
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
    const env: NodeJS.ProcessEnv = {
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
    };
    for (const key of options.deleteEnv ?? []) delete env[key];
    const proc: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [DIST, ...args],
      {
        cwd: options.cwd,
        env,
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

/**
 * Minimal Ollama stand-in on an ephemeral port. Doctor probes exactly two
 * endpoints — `/api/ps` (reachability + residency) and `/api/tags` (pulled
 * models) — so a stub that answers both with `{ models }` is enough to drive
 * the "everything is pulled" branch of the report, and `status: 401` drives
 * the cloud bad-key branch (`/api/tags` is the cloud probe path).
 */
async function withStubOllama(
  opts: { models?: string[]; status?: number },
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const models = (opts.models ?? []).map((name) => ({ name }));
  const server = createServer((_req, res) => {
    const status = opts.status ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? JSON.stringify({ models }) : JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/**
 * Flags this file already exercises BEHAVIORALLY (`doctor --json`,
 * `doctor --fail-unhealthy`, `init --claude`). A flag worth a test is worth a
 * line in `--help`: drop `--fail-unhealthy` from COMMANDS and the CI gate
 * becomes undiscoverable from the product itself while every behavioral test
 * stays green (F-ce9e0304). Add a flag here when you add a test for it.
 */
const FLAGS_UNDER_TEST = ["--json", "--fail-unhealthy", "--claude"] as const;

/**
 * Env vars the CLI's own tests set and the ENVIRONMENT block must therefore
 * document. OLLAMA_API_KEY in particular gates the entire cloud path.
 */
const ENV_VARS_DOCUMENTED = ["OLLAMA_HOST", "INTERN_PROFILE", "OLLAMA_API_KEY"] as const;

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

  it("--help documents every flag this file tests, and the ENVIRONMENT block (F-ce9e0304)", async () => {
    // Behavior was pinned; discoverability was not. These three flags each
    // have a sibling test below asserting what they DO — this asserts the
    // operator can find them without reading our test suite.
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    for (const flag of FLAGS_UNDER_TEST) {
      expect(
        r.stdout.includes(flag),
        `--help must document ${flag} — this file tests its behavior, so dropping it from COMMANDS makes a live contract invisible. Help text:\n${r.stdout}`,
      ).toBe(true);
    }
    expect(r.stdout).toContain("ENVIRONMENT");
    for (const name of ENV_VARS_DOCUMENTED) {
      expect(
        r.stdout.includes(name),
        `--help ENVIRONMENT block must name ${name}. Help text:\n${r.stdout}`,
      ).toBe(true);
    }
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

  // ── doctor prose report — the product's only rendered operator UI ──────
  //
  // F-d8e0e443: the five section labels above were the whole of the render
  // coverage. Every CONDITIONAL line — the `fix:` recovery command, the Cloud
  // block, Recent errors, the `(none)` empty states — had data coverage at the
  // handler level (tests/tools/doctor.test.ts, tests/doctorCloud.test.ts) and
  // ZERO render coverage, so deleting the matching `out.push()` left the whole
  // suite green and the operator with a report that no longer names the fix.
  // src/index.ts is excluded from the coverage gate (vitest.config.ts) for a
  // documented reason, which makes CLI-level assertions the only cover there is.
  //
  // These assert the rendered CONTRACT (a line that names the recovery command,
  // a cloud block that names the auth state) rather than the exact byte layout,
  // so a renderer that grows lines — e.g. surfacing env.warnings — still passes.

  it("doctor prose names the recovery command when required models are missing (fix: ollama pull …)", async () => {
    // Dead port → unreachable → nothing pulled → every required model missing
    // → suggested_pulls populated. This line is the single piece of the report
    // that hands the operator a command to run.
    const r = await runCli(["doctor"], { env: { OLLAMA_HOST: "http://127.0.0.1:9" } });
    expect(r.exitCode).toBe(0);
    expect(
      /^\s+fix:\s+ollama pull \S/m.test(r.stdout),
      `doctor report must render the 'fix: ollama pull …' recovery line when models are missing. Got:\n${r.stdout}`,
    ).toBe(true);
  }, 20_000);

  it("doctor prose renders the (none) empty state and drops the fix line when every model is pulled", async () => {
    const models = ["stub-instant:1b", "stub-workhorse:8b", "stub-deep:70b", "stub-embed:1b"];
    await withStubOllama({ models }, async (baseUrl) => {
      const r = await runCli(["doctor"], {
        env: {
          OLLAMA_HOST: baseUrl,
          INTERN_TIER_INSTANT: models[0],
          INTERN_TIER_WORKHORSE: models[1],
          INTERN_TIER_DEEP: models[2],
          INTERN_EMBED_MODEL: models[3],
        },
      });
      expect(r.exitCode).toBe(0);
      expect(
        /^\s+missing:\s+\(none\)\s*$/m.test(r.stdout),
        `expected the '(none)' empty state on the missing: line. Got:\n${r.stdout}`,
      ).toBe(true);
      // Symmetry: no missing models means no recovery command to offer.
      expect(
        /^\s+fix:\s+ollama pull /m.test(r.stdout),
        `the fix: line must NOT render when nothing is missing. Got:\n${r.stdout}`,
      ).toBe(false);
    });
  }, 25_000);

  it("doctor prose renders the Cloud block with auth: FAILED when the key is rejected (401)", async () => {
    // Mirrors tests/doctorCloud.test.ts:94 (which pins cloud.auth === 'failed'
    // in the DATA) at the render level — nothing previously spawned the CLI
    // doctor with cloud env at all.
    await withStubOllama({ status: 401 }, async (cloudUrl) => {
      const r = await runCli(["doctor"], {
        env: {
          OLLAMA_HOST: "http://127.0.0.1:9",
          OLLAMA_CLOUD_PRIMARY: "1",
          OLLAMA_API_KEY: "bad-key-for-the-401-stub",
          OLLAMA_CLOUD_HOST: cloudUrl,
        },
      });
      expect(r.exitCode).toBe(0);
      expect(
        /^Cloud \((primary|standby)\):\s*$/m.test(r.stdout),
        `expected a 'Cloud (<mode>):' section header. Got:\n${r.stdout}`,
      ).toBe(true);
      expect(
        /^\s+auth:\s+FAILED \(bad key\)\s*$/m.test(r.stdout),
        `a 401 from the cloud host must render as 'auth: FAILED (bad key)', not the 'unverified' default. Got:\n${r.stdout}`,
      ).toBe(true);
      expect(
        /^\s+models:\s+instant=\S+\s+workhorse=\S+\s+deep=\S+/m.test(r.stdout),
        `the Cloud block must name the per-tier cloud models. Got:\n${r.stdout}`,
      ).toBe(true);
      // NOTE: `circuit:` renders only when ctx.client is a RoutingOllamaClient,
      // which runCliDoctor never builds — it is an MCP-path field, not a CLI one.
    });
  }, 25_000);

  it("doctor prose omits the Cloud block entirely when no key is configured", async () => {
    const r = await runCli(["doctor"], {
      env: { OLLAMA_HOST: "http://127.0.0.1:9" },
      deleteEnv: [
        "OLLAMA_API_KEY",
        "OLLAMA_CLOUD_PRIMARY",
        "OLLAMA_CLOUD_HOST",
        "INTERN_CLOUD_MODEL",
        "INTERN_CLOUD_DEEP_MODEL",
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(
      /^Cloud \(/m.test(r.stdout),
      `no key means zero egress and no cloud section at all. Got:\n${r.stdout}`,
    ).toBe(false);
  }, 20_000);

  it("doctor prose renders the Recent errors block from the NDJSON log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-cli-doctorlog-"));
    try {
      const logPath = join(dir, "log.ndjson");
      await writeFile(
        logPath,
        `${JSON.stringify({
          ts: "2026-09-11T12:00:00.000Z",
          kind: "timeout",
          tool: "ollama_summarize_deep",
        })}\n`,
        "utf8",
      );
      const r = await runCli(["doctor"], {
        env: { OLLAMA_HOST: "http://127.0.0.1:9", INTERN_LOG_PATH: logPath },
      });
      expect(r.exitCode).toBe(0);
      expect(
        /^Recent errors \(last 1\):\s*$/m.test(r.stdout),
        `expected the 'Recent errors (last N):' header for a log with one error event. Got:\n${r.stdout}`,
      ).toBe(true);
      // The row names when, what and which tool — all three or it is not a lead.
      expect(
        /^\s+2026-09-11T12:00:00\.000Z\s+TIER_TIMEOUT\s+ollama_summarize_deep\s*$/m.test(r.stdout),
        `expected the error row to render ts + code + tool. Got:\n${r.stdout}`,
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("doctor --json emits parseable DoctorResult JSON (no prose), exit 0 without the gate flag (F5)", async () => {
    const r = await runCli(["doctor", "--json"], {
      env: { OLLAMA_HOST: "http://127.0.0.1:9" }, // dead port → unreachable, fast + deterministic
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("Profile:"); // prose renderer must not fire
    const parsed = JSON.parse(r.stdout) as { healthy?: boolean; ollama?: { reachable?: boolean } };
    expect(parsed.ollama?.reachable).toBe(false);
    expect(parsed.healthy).toBe(false);
  }, 20_000);

  it("doctor --fail-unhealthy exits 1 when unhealthy — the CI gate the old comment told users to grep for (F5)", async () => {
    const r = await runCli(["doctor", "--fail-unhealthy"], {
      env: { OLLAMA_HOST: "http://127.0.0.1:9" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/Healthy:\s+no/);
  }, 20_000);

  it("doctor --json --fail-unhealthy combines: JSON on stdout, exit 1 (F5)", async () => {
    const r = await runCli(["doctor", "--json", "--fail-unhealthy"], {
      env: { OLLAMA_HOST: "http://127.0.0.1:9" },
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout) as { healthy?: boolean };
    expect(parsed.healthy).toBe(false);
  }, 20_000);

  it("doctor rejects an unknown flag with exit 1 (typo never silently reports)", async () => {
    const r = await runCli(["doctor", "--bogus"], {
      env: { OLLAMA_HOST: "http://127.0.0.1:9" },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--bogus");
  }, 20_000);

  it("init --claude prints a valid paste-ready .mcp.json fragment + the standby note, writes NO file (F3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-cli-initclaude-"));
    try {
      const r = await runCli(["init", "--claude"], { cwd: dir });
      expect(r.exitCode).toBe(0);
      // Print-only: pasting beats clobbering an existing .mcp.json.
      expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
      expect(existsSync(join(dir, "hermes.config.yaml"))).toBe(false);
      // The JSON block parses and carries the server entry.
      const start = r.stdout.indexOf("{");
      const end = r.stdout.lastIndexOf("}");
      expect(start).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(r.stdout.slice(start, end + 1)) as {
        mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
      };
      const server = parsed.mcpServers?.["ollama-intern"];
      expect(server?.command).toBe("npx");
      expect(server?.args).toContain("ollama-intern-mcp");
      expect(server?.env?.INTERN_PROFILE).toBeDefined();
      // Cloud lines ride as COMMENTED guidance (JSON has no comments) with
      // the correct current default + the standby semantics named.
      expect(r.stdout).toContain("OLLAMA_API_KEY");
      expect(r.stdout).toMatch(/standby/i);
      expect(r.stdout).toContain("mistral-large-3:675b-cloud");
      expect(r.stdout).not.toContain("minimax-m3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("init rejects an unknown flag with exit 1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intern-cli-initbogus-"));
    try {
      const r = await runCli(["init", "--bogus"], { cwd: dir });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--bogus");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
