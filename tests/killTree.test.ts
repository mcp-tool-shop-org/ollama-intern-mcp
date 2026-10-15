import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/guardrails/compileCheck.js";
import { defaultSpawner } from "../src/tools/batchProofCheck.js";
import { KILL_GRACE_MS } from "../src/killTree.js";

// A command that starts a grandchild sharing its stdio, then both sleep.
// Before the fix a timeout killed only the direct child (cmd.exe on Windows,
// node elsewhere), and the call waited the whole sleep for the grandchild to
// let go of the pipes: the compile check's 15 s limit was never enforced on
// Windows, and a hung batch_proof_check command hung the call with it.
const SLEEP_MS = 20_000;
const TIMEOUT_MS = 3_000;
// Deadline + grace + room for a slow runner, and still well short of SLEEP_MS.
const SETTLE_BOUND_MS = TIMEOUT_MS + KILL_GRACE_MS + 2_500;
const HOLDER = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, ${SLEEP_MS})"], { stdio: "inherit" });
writeFileSync(process.argv[2], String(g.pid));
setTimeout(() => {}, ${SLEEP_MS});
`;

let dir: string | null = null;
let pids: number[] = [];

afterEach(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  pids = [];
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  dir = null;
});

async function holder(): Promise<{ script: string; pidFile: string }> {
  dir = await mkdtemp(join(tmpdir(), "killtree-"));
  const script = join(dir, "holder.cjs");
  await writeFile(script, HOLDER, "utf8");
  return { script, pidFile: join(dir, "grandchild.pid") };
}

/** The grandchild's pid, registered for cleanup; null if the holder never got that far. */
async function grandchild(pidFile: string): Promise<number | null> {
  try {
    const pid = Number(await readFile(pidFile, "utf8"));
    pids.push(pid);
    return pid;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("a timed-out command settles at its deadline, even when a grandchild holds the pipes", () => {
  it("compileCheck's runProcess", async () => {
    const { script, pidFile } = await holder();
    const started = Date.now();
    const r = await runProcess("node", [script, pidFile], TIMEOUT_MS);
    const elapsed = Date.now() - started;
    await grandchild(pidFile);
    expect(r.code).not.toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(SETTLE_BOUND_MS);
  });

  it("batch_proof_check's defaultSpawner", async () => {
    const { script, pidFile } = await holder();
    const r = await defaultSpawner("node", [script, pidFile], { cwd: dir!, timeout_ms: TIMEOUT_MS });
    await grandchild(pidFile);
    expect(r.timed_out).toBe(true);
    expect(r.elapsed_ms).toBeLessThan(SETTLE_BOUND_MS);
  });

  it.skipIf(process.platform !== "win32")("[win32] the timeout ends the whole tree, grandchild included", async () => {
    const { script, pidFile } = await holder();
    const started = Date.now();
    await runProcess("node", [script, pidFile], TIMEOUT_MS);
    const elapsed = Date.now() - started;
    const pid = await grandchild(pidFile);
    expect(pid, "the holder never started its grandchild").not.toBeNull();
    // Settling early is what proves the tree was ended: had the call waited out
    // SLEEP_MS, the grandchild would be gone on its own.
    expect(elapsed).toBeLessThan(SETTLE_BOUND_MS);
    // taskkill runs on its own; give it a moment to finish.
    await new Promise((r) => setTimeout(r, 1_000));
    expect(alive(pid!)).toBe(false);
  });
});
