/**
 * M7 (2026-07 health pass) — loadSources must not buffer an arbitrarily large
 * file into a JS string before slicing. A multi-hundred-MB log (incident_pack's
 * advertised workload) previously OOM'd or surfaced a misleading
 * SOURCE_PATH_NOT_FOUND "check the path exists" hint. It now checks the byte
 * size (via the already-open handle, before any read) and throws a distinct,
 * size-specific SOURCE_FILE_TOO_LARGE — never buffering the whole file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSources } from "../src/sources.js";
import { InternError } from "../src/errors.js";

describe("loadSources — byte-size cap (M7)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "intern-sources-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a file over the byte cap throws a distinct SOURCE_FILE_TOO_LARGE (not SOURCE_PATH_NOT_FOUND)", async () => {
    const p = join(dir, "big.log");
    await writeFile(p, "x".repeat(1000), "utf8"); // 1000 bytes
    let thrown: unknown = null;
    try {
      await loadSources([p], 100, 100); // maxBytes cap = 100 < 1000
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InternError);
    expect((thrown as InternError).code).toBe("SOURCE_FILE_TOO_LARGE");
    // Honest, size-specific message + hint — NOT the generic "check the path".
    expect((thrown as InternError).message).toMatch(/exceeds|too large|cap|bytes/i);
    expect((thrown as InternError).hint).not.toMatch(/check the path exists/i);
  });

  it("a file within the cap loads normally, sliced to perFileMax chars", async () => {
    const p = join(dir, "ok.md");
    await writeFile(p, "hello world body", "utf8");
    const [s] = await loadSources([p], 5, 1000);
    expect(s.body).toBe("hello"); // sliced to perFileMax=5
    expect(s.path).toBe(p);
  });

  it("a missing path still throws SOURCE_PATH_NOT_FOUND (distinct from the size cap)", async () => {
    let thrown: unknown = null;
    try {
      await loadSources([join(dir, "nope.md")], 100, 100);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InternError);
    expect((thrown as InternError).code).toBe("SOURCE_PATH_NOT_FOUND");
  });
});
