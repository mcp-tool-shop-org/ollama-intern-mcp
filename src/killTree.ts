/**
 * Ending a timed-out child process, everywhere.
 *
 * Both spawners (the compile check and batch_proof_check) run their command
 * with `shell: true` on Windows, so the child they hold is cmd.exe and the
 * real command is cmd.exe's child. `child.kill()` ends cmd.exe only: the
 * command keeps running and keeps the stdio pipes open, and Node's 'close'
 * event waits for those pipes. The timeout fired, but the call still waited
 * for the command to finish on its own.
 *
 * `killTree` ends the whole tree on Windows (`taskkill /T /F`). Elsewhere the
 * child is the command itself, so SIGKILL ends it; anything the command
 * started can still hold the pipes, so callers also settle KILL_GRACE_MS after
 * the kill instead of waiting for 'close'.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** How long a caller waits for 'close' after killing a timed-out child before settling anyway. */
export const KILL_GRACE_MS = 2_000;

export function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    tk.on("error", () => killChild(child));
    return;
  }
  killChild(child);
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}
