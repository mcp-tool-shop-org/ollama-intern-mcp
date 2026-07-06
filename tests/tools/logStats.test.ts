/**
 * ollama_log_stats — F4 (Phase 3b, Slice B). No-LLM NDJSON aggregation.
 *
 * The tagline sells "measured economics"; every envelope logs tokens,
 * elapsed, backend, degraded — but until this tool the only consumer was
 * log_tail (raw events). This suite pins the kickoff invariants: every
 * aggregate arithmetically correct against a fixture log, partial tail
 * line tolerated, empty/absent log returns zeros (never throws), `since`
 * filters, malformed middle lines skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLogStats, logStatsSchema } from "../../src/tools/logStats.js";
import { makeFakeCtx } from "../_helpers/index.js";

let dir: string;
let logPath: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "intern-logstats-"));
  logPath = join(dir, "log.ndjson");
  savedEnv = process.env.INTERN_LOG_PATH;
  process.env.INTERN_LOG_PATH = logPath;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.INTERN_LOG_PATH;
  else process.env.INTERN_LOG_PATH = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

function callLine(args: {
  ts: string;
  tool: string;
  tier: string;
  tin: number;
  tout: number;
  elapsed: number;
  backend?: "cloud" | "local";
  degraded?: boolean;
}): string {
  return JSON.stringify({
    kind: "call",
    ts: args.ts,
    tool: args.tool,
    envelope: {
      result: {},
      tier_used: args.tier,
      model: "m",
      hardware_profile: "dev-rtx5080",
      tokens_in: args.tin,
      tokens_out: args.tout,
      elapsed_ms: args.elapsed,
      residency: null,
      ...(args.backend ? { backend: args.backend } : {}),
      ...(args.degraded ? { degraded: true, degrade_reason: "cloud_5xx" } : {}),
    },
  });
}

/** 6 calls + 1 backend_fallback + 1 timeout + 1 tier-fallback + noise. */
const FIXTURE_LINES = [
  callLine({ ts: "2026-07-06T10:00:01Z", tool: "ollama_research", tier: "deep", tin: 100, tout: 10, elapsed: 100, backend: "cloud" }),
  callLine({ ts: "2026-07-06T10:00:02Z", tool: "ollama_research", tier: "deep", tin: 100, tout: 10, elapsed: 200, backend: "cloud" }),
  JSON.stringify({ kind: "backend_fallback", ts: "2026-07-06T10:00:02.5Z", from: "cloud", to: "local", reason: "cloud_5xx", tier: "deep" }),
  callLine({ ts: "2026-07-06T10:00:03Z", tool: "ollama_research", tier: "deep", tin: 100, tout: 10, elapsed: 300, backend: "local", degraded: true }),
  callLine({ ts: "2026-07-06T10:00:04Z", tool: "ollama_classify", tier: "instant", tin: 50, tout: 5, elapsed: 10 }),
  callLine({ ts: "2026-07-06T10:00:05Z", tool: "ollama_classify", tier: "instant", tin: 50, tout: 5, elapsed: 20 }),
  JSON.stringify({ kind: "timeout", ts: "2026-07-06T10:00:05.5Z", tool: "ollama_chat", tier: "workhorse", timeout_ms: 100 }),
  JSON.stringify({ kind: "fallback", ts: "2026-07-06T10:00:05.6Z", tool: "ollama_chat", from: "workhorse", to: "instant", reason: "timeout" }),
  "%%% not json — malformed middle line must be skipped %%%",
  callLine({ ts: "2026-07-06T10:00:06Z", tool: "ollama_chat", tier: "workhorse", tin: 30, tout: 3, elapsed: 1000, backend: "cloud" }),
];

async function writeFixture(extraTail = ""): Promise<void> {
  await writeFile(logPath, FIXTURE_LINES.join("\n") + "\n" + extraTail, "utf8");
}

describe("handleLogStats — aggregates are arithmetically correct", () => {
  it("totals / by_tool / by_tier / backend split / fallback rate / percentiles", async () => {
    await writeFixture();
    const env = await handleLogStats({}, makeFakeCtx());
    const r = env.result;

    expect(r.log_present).toBe(true);
    expect(r.totals.calls).toBe(6);
    expect(r.totals.tokens_in).toBe(430);
    expect(r.totals.tokens_out).toBe(43);

    // by_tool — research: 3 calls, 2 cloud + 1 degraded, elapsed [100,200,300].
    const research = r.by_tool["ollama_research"];
    expect(research.calls).toBe(3);
    expect(research.tokens_in).toBe(300);
    expect(research.cloud_calls).toBe(2);
    expect(research.degraded_calls).toBe(1);
    expect(research.p50_elapsed_ms).toBe(200);
    expect(research.p95_elapsed_ms).toBe(300);
    // classify: elapsed [10,20] → nearest-rank p50=10, p95=20.
    const classify = r.by_tool["ollama_classify"];
    expect(classify.calls).toBe(2);
    expect(classify.p50_elapsed_ms).toBe(10);
    expect(classify.p95_elapsed_ms).toBe(20);

    // by_tier
    expect(r.by_tier["deep"].calls).toBe(3);
    expect(r.by_tier["instant"].calls).toBe(2);
    expect(r.by_tier["workhorse"].calls).toBe(1);
    expect(r.by_tier["deep"].tokens_in).toBe(300);

    // backend split: 3 cloud, 1 degraded (wanted cloud, served local),
    // 0 explicit-local, 2 unrouted (local-only calls carry no backend).
    expect(r.backend.cloud_calls).toBe(3);
    expect(r.backend.degraded_calls).toBe(1);
    expect(r.backend.local_calls).toBe(0);
    expect(r.backend.unrouted_calls).toBe(2);
    expect(r.backend.backend_fallback_events).toBe(1);
    // fallback_rate = degraded / (cloud + degraded) = 1/4.
    expect(r.backend.fallback_rate).toBe(0.25);

    // tier-degradation events (orthogonal to backend fallback).
    expect(r.tier_events.timeouts).toBe(1);
    expect(r.tier_events.fallbacks).toBe(1);

    // overall percentiles over [10,20,100,200,300,1000].
    expect(r.elapsed_ms.p50).toBe(100);
    expect(r.elapsed_ms.p95).toBe(1000);

    // events_scanned counts parsed events (9 valid lines; malformed skipped).
    expect(r.events_scanned).toBe(9);
  });

  it("a partial (torn) final line is tolerated — append-only log mid-write", async () => {
    await writeFixture('{"kind":"call","ts":"2026-07-06T10:00:07Z","tool":"ollama_chat","enve');
    const env = await handleLogStats({}, makeFakeCtx());
    expect(env.result.totals.calls).toBe(6); // torn line ignored, no throw
  });

  it("`since` filters events before the cutoff", async () => {
    await writeFixture();
    const env = await handleLogStats({ since: "2026-07-06T10:00:03.5Z" }, makeFakeCtx());
    const r = env.result;
    // Only classify ×2 + chat call (+ timeout/fallback events) remain.
    expect(r.totals.calls).toBe(3);
    expect(r.totals.tokens_in).toBe(130);
    expect(r.by_tool["ollama_research"]).toBeUndefined();
    expect(r.backend.cloud_calls).toBe(1);
    expect(r.since).toBe("2026-07-06T10:00:03.5Z");
  });

  it("rejects an invalid `since` with SCHEMA_INVALID (logTail parity)", async () => {
    await writeFixture();
    await expect(handleLogStats({ since: "not-a-date" }, makeFakeCtx())).rejects.toThrow(
      /Invalid ISO timestamp/,
    );
  });

  it("absent log → zeros + log_present:false, never throws", async () => {
    // No file written at logPath.
    const env = await handleLogStats({}, makeFakeCtx());
    const r = env.result;
    expect(r.log_present).toBe(false);
    expect(r.totals.calls).toBe(0);
    expect(r.totals.tokens_in).toBe(0);
    expect(r.by_tool).toEqual({});
    expect(r.backend.fallback_rate).toBeNull();
    expect(r.elapsed_ms.p50).toBeNull();
  });

  it("empty log file → zeros, never throws", async () => {
    await writeFile(logPath, "", "utf8");
    const env = await handleLogStats({}, makeFakeCtx());
    expect(env.result.log_present).toBe(true);
    expect(env.result.totals.calls).toBe(0);
    expect(env.result.elapsed_ms.p95).toBeNull();
  });

  it("malformed envelopes inside call events are skipped, not summed as NaN", async () => {
    await writeFile(
      logPath,
      [
        JSON.stringify({ kind: "call", ts: "2026-07-06T10:00:01Z", tool: "ollama_chat", envelope: null }),
        JSON.stringify({ kind: "call", ts: "2026-07-06T10:00:02Z", tool: "ollama_chat", envelope: { tokens_in: "forty" } }),
        callLine({ ts: "2026-07-06T10:00:03Z", tool: "ollama_chat", tier: "workhorse", tin: 10, tout: 1, elapsed: 5 }),
      ].join("\n") + "\n",
      "utf8",
    );
    const env = await handleLogStats({}, makeFakeCtx());
    // The two malformed call events still COUNT as calls for the honest
    // count, but contribute 0 tokens / no elapsed sample — never NaN.
    expect(env.result.totals.calls).toBe(3);
    expect(env.result.totals.tokens_in).toBe(10);
    expect(Number.isNaN(env.result.totals.tokens_in)).toBe(false);
    expect(env.result.elapsed_ms.p50).toBe(5);
  });

  it("schema accepts {} and an ISO since; the tool is a no-LLM read (zero wire calls)", async () => {
    expect(() => logStatsSchema.parse({})).not.toThrow();
    expect(() => logStatsSchema.parse({ since: "2026-07-06T00:00:00Z" })).not.toThrow();
    await writeFixture();
    const ctx = makeFakeCtx();
    await handleLogStats({}, ctx);
    const client = ctx.client as unknown as { callCount: { generate: number; chat: number; embed: number } };
    expect(client.callCount.generate).toBe(0);
    expect(client.callCount.chat).toBe(0);
    expect(client.callCount.embed).toBe(0);
  });
});
