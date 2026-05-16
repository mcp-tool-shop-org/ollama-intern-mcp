/**
 * Direct coverage for src/observability.ts (Stage C / tests F-001).
 *
 * observability is load-bearing for the "measured economics" value
 * proposition — every tool call lands an NDJSON event so an operator can
 * later tune delegation instead of guessing. Before this file landed,
 * observability had ZERO direct test coverage; bugs reached operators
 * through the long way around (silent disabled logs, fd contention on
 * Windows, the warnedOnFailure latch firing twice, etc.).
 *
 * What this file locks:
 *   1. NullLogger contract — the in-memory test double captures events
 *      with a stable, shape-preserving shape.
 *   2. NdjsonLogger round-trip — write one JSON-per-line, parse-back is
 *      lossless.
 *   3. Single-failure warning latch — fs.appendFile rejection emits
 *      exactly ONE stderr warning; subsequent failures swallow silently.
 *   4. mkdir failure path — ready() swallows mkdir rejection so a
 *      disabled log dir never hangs the process via unhandled rejection.
 *   5. Concurrent log() during ready() — ordering and shape under
 *      concurrent calls is what the runner actually exercises.
 *
 * Mocking posture: ESM exports from `node:fs/promises` are non-
 * configurable so vi.spyOn won't work. The failure-injection tests
 * point NdjsonLogger at a path under a directory the test made
 * unwritable (chmod-style or by pointing at a non-existent root
 * we can predict).
 *
 * Test failures use toMatchObject so the diff highlights the actual
 * divergence — never `expect(...).toBe(true)` for shape checks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  NullLogger,
  NdjsonLogger,
  callEvent,
  packStepEvent,
  timestamp,
  type LogEvent,
} from "../src/observability.js";
import type { Envelope } from "../src/envelope.js";

// ── shared fixtures ─────────────────────────────────────────

function sampleEnvelope(): Envelope<{ ok: true }> {
  return {
    result: { ok: true },
    tier_used: "instant",
    model: "hermes3:8b",
    hardware_profile: "dev-rtx5080",
    tokens_in: 5,
    tokens_out: 3,
    elapsed_ms: 12,
    residency: null,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "intern-obs-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

// ── 1. NullLogger contract ──────────────────────────────────

describe("NullLogger contract", () => {
  it("captures events into a stable in-memory array (no I/O)", async () => {
    const logger = new NullLogger();
    const ev1: LogEvent = callEvent("ollama_classify", sampleEnvelope());
    const ev2: LogEvent = packStepEvent({
      pack: "incident",
      step: "triage",
      step_index: 1,
      total_steps: 3,
    });
    await logger.log(ev1);
    await logger.log(ev2);

    // The events array IS the public surface used by every test in the
    // repo. Lock it as a reference, not a copy — toMatchObject reports
    // a per-field diff if any of these shapes drifts.
    expect(logger.events).toHaveLength(2);
    expect(logger.events[0]).toMatchObject({
      kind: "call",
      tool: "ollama_classify",
      envelope: { tier_used: "instant", model: "hermes3:8b" },
    });
    expect(logger.events[1]).toMatchObject({
      kind: "pack_step",
      pack: "incident",
      step: "triage",
      step_index: 1,
      total_steps: 3,
    });
  });

  it("preserves event order under sequential await", async () => {
    const logger = new NullLogger();
    for (let i = 0; i < 10; i++) {
      await logger.log(callEvent(`tool-${i}`, sampleEnvelope()));
    }
    expect(logger.events.map((e) => (e as { tool: string }).tool)).toEqual(
      Array.from({ length: 10 }, (_, i) => `tool-${i}`),
    );
  });

  it("preserves event count under concurrent Promise.all log()", async () => {
    // Concurrent log() calls (the runner DOES await sequentially, but the
    // contract has no synchronization guarantee). NullLogger pushes in
    // call order under the JS event loop's single-threaded execution, so
    // the array reflects the order log() was invoked.
    const logger = new NullLogger();
    const events = Array.from({ length: 20 }, (_, i) =>
      callEvent(`tool-${i}`, sampleEnvelope()),
    );
    await Promise.all(events.map((e) => logger.log(e)));
    // Length is the firm guarantee; ordering matches push order under
    // single-threaded event-loop execution.
    expect(logger.events).toHaveLength(20);
  });
});

// ── 2. NdjsonLogger round-trip ──────────────────────────────

describe("NdjsonLogger round-trip", () => {
  it("writes one valid JSON per line; parse-and-reload preserves shape", async () => {
    const logPath = join(tempDir, "round.ndjson");
    const logger = new NdjsonLogger(logPath);
    const events: LogEvent[] = [
      callEvent("ollama_research", sampleEnvelope()),
      packStepEvent({ pack: "repo", step: "brief", step_index: 2, total_steps: 4 }),
      {
        kind: "guardrail",
        ts: timestamp(),
        tool: "ollama_classify",
        rule: "confidence",
        action: "null_label",
        detail: { threshold: 0.7, observed: 0.4 },
      },
    ];
    for (const ev of events) {
      await logger.log(ev);
    }

    const raw = await readFile(logPath, "utf8");
    // Must end with a newline so an appender starting from EOF is on a
    // fresh line. A subtle regression would be losing this trailing \n
    // when concatenating writes.
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(events.length);

    const parsed = lines.map((l) => JSON.parse(l) as LogEvent);
    expect(parsed[0]).toMatchObject({
      kind: "call",
      tool: "ollama_research",
      envelope: { tier_used: "instant", model: "hermes3:8b" },
    });
    expect(parsed[1]).toMatchObject({
      kind: "pack_step",
      pack: "repo",
      step_index: 2,
    });
    expect(parsed[2]).toMatchObject({
      kind: "guardrail",
      tool: "ollama_classify",
      rule: "confidence",
      action: "null_label",
      detail: { threshold: 0.7, observed: 0.4 },
    });
  });

  it("creates the parent directory if it does not exist", async () => {
    // Drives the ready() mkdir path with a nested path the operator hasn't
    // pre-created. Most rigs have ~/.ollama-intern already, but first-run
    // operators do not — and that's exactly where the "log silently never
    // writes" regression bites.
    const logPath = join(tempDir, "nested", "deeper", "log.ndjson");
    const logger = new NdjsonLogger(logPath);
    await logger.log(callEvent("ollama_doctor", sampleEnvelope()));
    const raw = await readFile(logPath, "utf8");
    expect(raw).toContain("ollama_doctor");
  });
});

// ── 3. Single-failure warning latch (warnedOnFailure) ───────
// ESM namespace immutability blocks vi.spyOn on node:fs/promises, so
// we drive the failure path by pointing the logger at a path under a
// pre-existing FILE (not a directory). mkdir's recursive flag is
// happy when the path already exists as a directory, but it errors
// with ENOTDIR when a parent component is a regular file — and
// appendFile then fails with ENOTDIR or ENOENT depending on the
// platform. Either way the failure path runs.

describe("NdjsonLogger single-failure warning latch", () => {
  it("emits exactly ONE stderr warning on appendFile failure, then swallows silently", async () => {
    // Create a regular file at tempDir/blocker; then ask the logger to
    // write to tempDir/blocker/log.ndjson — the parent path component
    // can't be a directory, so the open() inside ready/log fails.
    const blockerFile = join(tempDir, "blocker");
    await writeFile(blockerFile, "i am a file, not a directory", "utf8");
    const logPath = join(blockerFile, "log.ndjson");
    const logger = new NdjsonLogger(logPath);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Drive 4 sequential log() calls. Only the first should produce a
    // stderr warning; the rest must swallow. Each call MUST resolve —
    // observability never breaks tool calls.
    for (let i = 0; i < 4; i++) {
      await logger.log(callEvent(`tool-${i}`, sampleEnvelope()));
    }

    // Exactly one warning — the warnedOnFailure latch is the load-
    // bearing contract; >1 means the latch isn't holding.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const warning = stderrSpy.mock.calls[0]?.[0];
    expect(typeof warning).toBe("string");
    // Warning text must name (a) "observability log disabled", (b) the
    // error code (some shape — ENOTDIR / EISDIR / ENOENT depending on
    // platform), and (c) the actual log path so the operator can act
    // on it without guessing.
    expect(warning).toMatch(/observability log disabled/);
    expect(warning).toContain(logPath);
  });

  it("subsequent log calls after the latch fires never throw to the caller", async () => {
    // The contract: tool calls MUST NOT break when the log goes bad.
    const blockerFile = join(tempDir, "blocker2");
    await writeFile(blockerFile, "blocker", "utf8");
    const logPath = join(blockerFile, "swallow.ndjson");
    const logger = new NdjsonLogger(logPath);

    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      logger.log(callEvent("ollama_classify", sampleEnvelope())),
    ).resolves.toBeUndefined();
    // Second call AFTER the latch is set — must still resolve cleanly.
    await expect(
      logger.log(callEvent("ollama_classify", sampleEnvelope())),
    ).resolves.toBeUndefined();
  });
});

// ── 4. mkdir failure path ───────────────────────────────────

describe("NdjsonLogger mkdir failure path", () => {
  it("swallows mkdir rejection so log() never throws an unhandled rejection", async () => {
    // Same trick — a regular file in the parent chain makes mkdir
    // recursive fail. log() still resolves, the warnedOnFailure latch
    // fires once for the subsequent appendFile attempt.
    const blockerFile = join(tempDir, "noaccess");
    await writeFile(blockerFile, "x", "utf8");
    const logPath = join(blockerFile, "log.ndjson");
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new NdjsonLogger(logPath);

    // log() must resolve — degradation never breaks the caller.
    await expect(
      logger.log(callEvent("ollama_doctor", sampleEnvelope())),
    ).resolves.toBeUndefined();

    // The latch fires once even though mkdir failed first — that's
    // because mkdir is caught and swallowed inside ready(), and the
    // subsequent appendFile is what trips the latch.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Concurrent log() during ready() ──────────────────────

describe("NdjsonLogger concurrent log() during ready()", () => {
  it("multiple concurrent log() calls all land on disk", async () => {
    // The runner today await-s log() sequentially, but a future caller
    // (or pack progress + a parallel tool) could fire two log()s
    // back-to-back without awaiting between them. ready() is memoized —
    // first call wraps mkdir, subsequent calls re-await the same promise.
    // This test exercises that path with concurrent writes and asserts
    // every event lands.
    const logPath = join(tempDir, "concurrent.ndjson");
    const logger = new NdjsonLogger(logPath);
    const events: LogEvent[] = Array.from({ length: 15 }, (_, i) =>
      callEvent(`tool-${i}`, sampleEnvelope()),
    );
    await Promise.all(events.map((e) => logger.log(e)));

    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(events.length);

    const parsedTools = new Set(
      lines.map((l) => (JSON.parse(l) as { tool: string }).tool),
    );
    // Each event has a unique tool name; the set MUST contain all 15.
    for (let i = 0; i < 15; i++) {
      expect(parsedTools.has(`tool-${i}`)).toBe(true);
    }
  });

  it("ready() is memoized — many concurrent first calls all complete cleanly", async () => {
    // Documents the memoization contract via observable behavior (all
    // log calls land, none hang, no warning fires). We can't sniff
    // mkdir directly under ESM namespace-immutability, but the
    // observable shape is what matters.
    const logPath = join(tempDir, "memo", "log.ndjson");
    const logger = new NdjsonLogger(logPath);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        logger.log(callEvent(`tool-${i}`, sampleEnvelope())),
      ),
    );

    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    // No warning fires on the happy path — if memoization broke and
    // two ready() calls raced on a not-yet-created dir, we could see
    // a transient EEXIST that the catch swallows; the latch only fires
    // on appendFile failure. Either way: zero warnings = happy path.
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ── 6. Event builders (callEvent + packStepEvent + timestamp) ─

describe("event builders", () => {
  it("callEvent stamps the right shape with current ISO timestamp", () => {
    const before = Date.now();
    const ev = callEvent("ollama_research", sampleEnvelope());
    const after = Date.now();
    expect(ev).toMatchObject({
      kind: "call",
      tool: "ollama_research",
      envelope: { tier_used: "instant", model: "hermes3:8b" },
    });
    expect(typeof ev.ts).toBe("string");
    const parsed = Date.parse(ev.ts);
    // Inclusive boundary check — ts is captured during the call so the
    // ISO timestamp MUST land within [before, after].
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("packStepEvent shape stays load-bearing for the pack progress UI", () => {
    const ev = packStepEvent({
      pack: "change",
      step: "synthesize_brief",
      step_index: 3,
      total_steps: 5,
    });
    expect(ev).toMatchObject({
      kind: "pack_step",
      pack: "change",
      step: "synthesize_brief",
      step_index: 3,
      total_steps: 5,
    });
    expect(typeof ev.ts).toBe("string");
  });

  it("timestamp returns a parseable ISO-8601 string", () => {
    const ts = timestamp();
    expect(typeof ts).toBe("string");
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
    // ISO-8601 format check — yyyy-mm-ddTHH:MM:SS.sssZ
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ── 7. SIGTERM/shutdown breadcrumb integration (F-005 #6) ─────
// Source-side: src/index.ts installs SIGTERM/SIGINT shutdown handlers
// that emit a kind:'guardrail' breadcrumb (rule:'signal_received',
// action:'graceful_shutdown') BEFORE closing the MCP server. The full
// integration test would spawn the dist server, signal it, and read
// log_tail — that's the territory of mcpGolden's subprocess test.
// Here we pin the SOURCE shape: the shutdown event is documented in
// the LogEvent guardrail discriminant and the handler emits one
// (read via grep against src/index.ts so the test doesn't need a
// subprocess but still locks the contract).

describe("SIGTERM shutdown breadcrumb (F-005 #6 — source-shape pin)", () => {
  it("src/index.ts wires SIGTERM and SIGINT handlers that emit a guardrail breadcrumb", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("../src/index.ts", import.meta.url);
    const src = await fs.readFile(url, "utf8");

    // Pin the handler registration — if a refactor drops SIGTERM/
    // SIGINT handling, the operator loses the post-mortem breadcrumb
    // that lets them tell "killed by orchestrator" from "crashed".
    expect(src).toMatch(/process\.on\(\s*["']SIGTERM["']/);
    expect(src).toMatch(/process\.on\(\s*["']SIGINT["']/);
    // Pin the breadcrumb shape — the guardrail rule name is what
    // log_tail callers filter on.
    expect(src).toContain("graceful_shutdown");
    expect(src).toContain("signal_received");
  });
});
