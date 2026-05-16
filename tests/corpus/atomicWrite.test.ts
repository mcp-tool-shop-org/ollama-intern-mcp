/**
 * Direct coverage for src/corpus/atomicWrite.ts (Stage C / tests F-003).
 *
 * atomicWriteFile is the durability primitive both saveCorpus
 * (storage.ts) and saveManifest (manifest.ts) depend on. ZERO direct
 * tests before this file — bugs landed via downstream corpus/manifest
 * pairs going out of sync.
 *
 * What this file locks:
 *   1. Happy path — payload reaches disk, no .tmp file left behind.
 *   2. Parent dir auto-created when missing.
 *   3. Rename failure — .tmp cleaned up AND original file untouched.
 *      Drives the failure via a real-fs collision (rename to a path
 *      where a regular FILE blocks the target). ESM namespace immut-
 *      ability prevents vi.spyOn on node:fs/promises.
 *   4. Concurrent same-path writes — both callers settle, no torn
 *      bytes, no .tmp residue.
 *   5. Edge cases — empty payload, large payload, unicode, deep dirs.
 *
 * Cross-domain note: corpus-guards is hardening atomicWrite in parallel.
 * Tests document the OBSERVABLE contract via real-fs failure modes
 * rather than fragile spies — that keeps the assertions valid through
 * either implementation revision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "../../src/corpus/atomicWrite.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-atomic-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

/** Async existence check — fs.existsSync is fine, but using stat keeps the suite async-uniform. */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("atomicWriteFile — happy path (F-003)", () => {
  it("writes the payload to disk and leaves no .tmp residue", async () => {
    const path = join(tempDir, "out.json");
    const payload = JSON.stringify({ hello: "world" }, null, 2);
    await atomicWriteFile(path, payload);

    expect(await readFile(path, "utf8")).toBe(payload);
    expect(await exists(`${path}.tmp`)).toBe(false);
  });

  it("overwrites an existing file atomically (rename is the swap)", async () => {
    const path = join(tempDir, "existing.json");
    await writeFile(path, '{"old":true}', "utf8");
    await atomicWriteFile(path, '{"new":true}');
    expect(await readFile(path, "utf8")).toBe('{"new":true}');
    expect(await exists(`${path}.tmp`)).toBe(false);
  });

  it("writes UTF-8 content losslessly (non-ASCII)", async () => {
    const path = join(tempDir, "utf8.json");
    const payload = JSON.stringify({
      multilingual: "中文 — éèà — 🚀",
    });
    await atomicWriteFile(path, payload);
    expect(await readFile(path, "utf8")).toBe(payload);
  });

  it("returns the same value across N sequential writes (no truncation between)", async () => {
    const path = join(tempDir, "seq-many.json");
    const payloads = [`{"i":0}`, `{"i":1}`, `{"i":2}`, `{"i":3}`];
    for (const p of payloads) {
      await atomicWriteFile(path, p);
    }
    // Final state is the last write — pin it.
    expect(await readFile(path, "utf8")).toBe(`{"i":3}`);
    expect(await exists(`${path}.tmp`)).toBe(false);
  });
});

describe("atomicWriteFile — parent dir creation (F-003)", () => {
  it("creates a missing parent directory before writing", async () => {
    // The tmp file lives next to the final path; if the parent doesn't
    // exist, the open() call would ENOENT. mkdir({recursive:true})
    // inside atomicWriteFile is what unblocks first-run flows.
    const nested = join(tempDir, "a", "b", "c", "log.json");
    await atomicWriteFile(nested, '{"ok":true}');
    expect(await readFile(nested, "utf8")).toBe('{"ok":true}');
  });

  it("handles deeply nested parent paths (5+ levels)", async () => {
    const deep = join(tempDir, "1", "2", "3", "4", "5", "out.json");
    await atomicWriteFile(deep, "payload");
    expect(await readFile(deep, "utf8")).toBe("payload");
  });
});

describe("atomicWriteFile — rename / open failure (F-003)", () => {
  it("rejects loudly when the parent path contains a regular file (cannot create dir under file)", async () => {
    // Create tempDir/blocker as a regular file, then try to atomic-
    // write to tempDir/blocker/log.json. mkdir(recursive) hits ENOTDIR
    // on the blocker; atomicWriteFile propagates the error (it's
    // unrelated to durability — there's just no valid target). The
    // load-bearing assertion is that we throw, not that we leak.
    const blockerFile = join(tempDir, "blocker");
    await writeFile(blockerFile, "i am a file, not a directory", "utf8");
    const blockedPath = join(blockerFile, "log.json");

    await expect(atomicWriteFile(blockedPath, "payload")).rejects.toThrow();
    // No .tmp residue (under the would-be parent).
    expect(await exists(`${blockedPath}.tmp`)).toBe(false);
  });

  it("rename failure cleanup — when target path is a non-empty directory, the .tmp is cleaned up and the original survives", async () => {
    // POSIX: rename() refuses to overwrite a non-empty directory with
    // a regular file (EISDIR/ENOTEMPTY). We pre-create a directory at
    // the final path, then call atomicWriteFile against it. The write
    // and fsync succeed (tmp file created); rename fails; the catch
    // unlinks .tmp; the directory survives intact.
    //
    // On Windows, rename behavior over a directory differs but still
    // rejects — the cleanup path runs the same way.
    const targetPath = join(tempDir, "target.json");
    // Make the target a NON-EMPTY directory so rename can't replace it.
    const targetAsDir = targetPath;
    const sentinel = join(targetAsDir, "sentinel.txt");
    await writeFile(sentinel, "must survive the failed rename", "utf8").catch(
      async () => {
        // mkdir may be required first depending on platform — make the
        // dir explicitly, then drop sentinel into it.
        const { mkdir } = await import("node:fs/promises");
        await mkdir(targetAsDir, { recursive: true });
        await writeFile(sentinel, "must survive the failed rename", "utf8");
      },
    );

    await expect(atomicWriteFile(targetPath, '{"new":true}')).rejects.toThrow();

    // Original directory + sentinel still present.
    expect(await exists(targetPath)).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("must survive the failed rename");
    // .tmp must be cleaned up — atomicWriteFile's catch unlinks it.
    expect(await exists(`${targetPath}.tmp`)).toBe(false);
  });
});

describe("atomicWriteFile — concurrent writes (F-003, contract pin)", () => {
  it("two concurrent writes to the same path both settle; final file (if any) is ONE of the payloads (no torn bytes)", async () => {
    // atomicWriteFile is documented as "single-process, single-file";
    // there's no built-in lock against TWO concurrent atomicWriteFile
    // calls to the same path. The .tmp path collides; rename order
    // decides what's on disk. The test pins the OBSERVABLE contract:
    // both callers resolve (neither hangs), the final file content
    // is ONE of the two payloads (never a torn mix), and no .tmp
    // residue remains.
    const path = join(tempDir, "race.json");
    const payloads = [JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 })];

    const results = await Promise.allSettled(
      payloads.map((p) => atomicWriteFile(path, p)),
    );

    // Both calls MUST settle (neither hangs forever). One may reject
    // if the .tmp collision surfaces an EPERM/EBUSY rename on Windows;
    // the load-bearing guarantee is "no hang", not "both succeed".
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(["fulfilled", "rejected"]).toContain(r.status);
    }

    // The final file content (if any rename succeeded) must be ONE of
    // the two complete payloads — never a torn mix. If both rejected,
    // the file may not exist — that's still a consistency win.
    if (await exists(path)) {
      const final = await readFile(path, "utf8");
      expect(payloads, `final file content was: ${final}`).toContain(final);
    }
    // .tmp residue is best-effort — on a same-path race the unlink in
    // the catch may have already run. Best-effort assert; the load-
    // bearing piece is "no torn final file".
    expect(await exists(`${path}.tmp`)).toBe(false);
  });

  it("sequential writes are byte-identical to a single direct write", async () => {
    // Pin a back-to-back invariant: A then await; B then await produces
    // exactly B on disk. No interleaving, no .tmp leak.
    const path = join(tempDir, "seq.json");
    await atomicWriteFile(path, '{"first":true}');
    await atomicWriteFile(path, '{"second":true}');
    expect(await readFile(path, "utf8")).toBe('{"second":true}');
    expect(await exists(`${path}.tmp`)).toBe(false);
  });
});

describe("atomicWriteFile — path edge cases (F-003)", () => {
  it("handles a path whose dirname is the temp dir itself", async () => {
    // Edge case — the parent dir already exists; mkdir(recursive) must
    // be a no-op rather than an error.
    const path = join(tempDir, "flat.json");
    await atomicWriteFile(path, "ok");
    expect(await readFile(path, "utf8")).toBe("ok");
  });

  it("writes empty-string payload (zero-length file is valid)", async () => {
    const path = join(tempDir, "empty.json");
    await atomicWriteFile(path, "");
    expect(await readFile(path, "utf8")).toBe("");
    expect(await exists(`${path}.tmp`)).toBe(false);
  });

  it("writes a large payload (~1 MB) without truncation", async () => {
    const path = join(tempDir, "big.json");
    const payload = "A".repeat(1024 * 1024); // 1 MB
    await atomicWriteFile(path, payload);
    const back = await readFile(path, "utf8");
    expect(back.length).toBe(payload.length);
    // Compare a sentinel rather than the full string to keep the diff
    // readable when the test does break.
    expect(back.slice(0, 16)).toBe("AAAAAAAAAAAAAAAA");
    expect(back.slice(-16)).toBe("AAAAAAAAAAAAAAAA");
  });
});

// ── F-003 #6 — fsync contract (source-shape pin) ──────────────
// vi.spyOn on the node:fs/promises namespace is not configurable in
// ESM, so we can't observe the fsync call at runtime here. Instead we
// pin the source shape: atomicWrite.ts MUST call fh.sync() before
// rename. A future "optimization" that drops fsync silently would
// downgrade the durability promise — this source-grep test catches it
// cheaply, mirroring the pattern used in tests/startupProbe.test.ts
// for INTERN_SKIP_STARTUP_PROBE.

describe("atomicWriteFile — fsync contract (source-shape pin)", () => {
  it("src/corpus/atomicWrite.ts calls fh.sync() before the rename", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("../../src/corpus/atomicWrite.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");
    // Must reference fh.sync() — exact token is the durability
    // primitive. If a refactor renames the variable, update this test
    // along with the change.
    expect(src).toMatch(/await\s+fh\.sync\(\)/);
    // sync() must appear BEFORE the FIRST `await rename(` call —
    // textual ordering check that fsync happens before swap. Use
    // word-boundary-precise tokens so the parent-dir fsync (dirFh.sync)
    // doesn't false-match the file-handle fsync check.
    const fhSyncMatch = src.match(/await\s+fh\.sync\(\)/);
    const renameMatch = src.match(/await\s+rename\(/);
    expect(fhSyncMatch?.index, "expected `await fh.sync()` in atomicWrite.ts").toBeDefined();
    expect(renameMatch?.index, "expected `await rename(` in atomicWrite.ts").toBeDefined();
    expect(fhSyncMatch!.index!).toBeLessThan(renameMatch!.index!);
  });

  it("src/corpus/atomicWrite.ts unlinks the .tmp on rename failure", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("../../src/corpus/atomicWrite.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");
    // The cleanup path must reference unlink + tmpPath.
    expect(src).toMatch(/unlink\(tmpPath\)/);
  });
});
