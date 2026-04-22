/**
 * ollama_doctor — first-run prerequisites + status snapshot (no-LLM).
 *
 * Probes Ollama reachability, lists loaded (/api/ps) + pulled (/api/tags)
 * models, compares them against the active profile's tier models, reports
 * allowed roots / artifact root / log path, and surfaces the last 10 errors
 * from the NDJSON log. Returns a single envelope with `healthy: boolean`
 * so a caller can gate follow-up work on "is this box actually set up?"
 *
 * Pure introspection — no model calls, no writes. Safe to call on every
 * session start to decide whether to nag the operator about a missing pull.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { normalizeOllamaHost } from "../ollama.js";
import type { RunContext } from "../runContext.js";

export const doctorSchema = z.object({});

export type DoctorInput = z.infer<typeof doctorSchema>;

export interface DoctorResult {
  ollama: { reachable: boolean; host: string; error?: string };
  models: {
    required: string[];
    pulled: string[];
    loaded: string[];
    missing: string[];
    suggested_pulls: string[];
  };
  profile: {
    name: string;
    tiers: { instant: string; workhorse: string; deep: string; embed: string };
  };
  paths: {
    allowed_roots: string[];
    artifact_root: string;
    log_path: string;
  };
  recent_errors: Array<{ ts: string; code: string; tool: string }>;
  healthy: boolean;
}

/** Default log path — mirrors observability.ts. */
function defaultLogPath(): string {
  return process.env.INTERN_LOG_PATH || join(homedir(), ".ollama-intern", "log.ndjson");
}

/** Default artifact root — mirrors artifacts/scan.ts. */
function defaultArtifactRoot(): string {
  return process.env.INTERN_ARTIFACT_DIR ?? join(homedir(), ".ollama-intern", "artifacts");
}

/** Parse `allowed_roots` from INTERN_ALLOWED_ROOTS (comma/semicolon separated). */
function resolveAllowedRoots(): string[] {
  const raw = process.env.INTERN_ALLOWED_ROOTS;
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Fetch /api/tags (pulled models) and /api/ps (loaded models) with a short
 * timeout. Any failure collapses to empty arrays — the caller reports them
 * as "unknown" via the healthy flag.
 */
async function fetchModelState(
  host: string,
  timeoutMs: number,
): Promise<{ pulled: string[]; loaded: string[]; error?: string }> {
  async function fetchJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${host}${path}`, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    const [tags, ps] = await Promise.all([fetchJson("/api/tags"), fetchJson("/api/ps")]);
    const tagsModels = Array.isArray((tags as { models?: unknown }).models)
      ? ((tags as { models: Array<{ name?: string; model?: string }> }).models)
      : [];
    const psModels = Array.isArray((ps as { models?: unknown }).models)
      ? ((ps as { models: Array<{ name?: string; model?: string }> }).models)
      : [];
    const pulled = tagsModels.map((m) => m.name ?? m.model ?? "").filter(Boolean);
    const loaded = psModels.map((m) => m.name ?? m.model ?? "").filter(Boolean);
    return { pulled, loaded };
  } catch (err) {
    return {
      pulled: [],
      loaded: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read the last N lines of the NDJSON log and return the last 10 events that
 * look like errors — envelope calls whose result shape carries an error flag,
 * guardrail denials, or known error kinds. Silent on any read failure; a
 * missing log file isn't a doctor problem, just a quiet operator.
 */
async function readRecentErrors(
  logPath: string,
  cap: number = 10,
): Promise<Array<{ ts: string; code: string; tool: string }>> {
  if (!existsSync(logPath)) return [];
  let body: string;
  try {
    body = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const lines = body.split("\n").filter((l) => l.length > 0);
  // Walk from the end so we cap reads on big logs, but parse best-effort.
  const errors: Array<{ ts: string; code: string; tool: string }> = [];
  for (let i = lines.length - 1; i >= 0 && errors.length < cap; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue; // truncated tail or malformed line — skip
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as Record<string, unknown>;
    const ts = typeof ev.ts === "string" ? ev.ts : "";
    const tool = typeof ev.tool === "string" ? ev.tool : "?";
    const kind = typeof ev.kind === "string" ? ev.kind : "";
    // A tool-call envelope with error-shape result counts as an error.
    if (kind === "call" && ev.envelope && typeof ev.envelope === "object") {
      const env = ev.envelope as { result?: unknown };
      const result = env.result as { error?: unknown; code?: unknown } | null | undefined;
      if (result && typeof result === "object" && result.error === true && typeof result.code === "string") {
        errors.push({ ts, code: result.code, tool });
        continue;
      }
    }
    // Timeout or guardrail events count too.
    if (kind === "timeout") {
      errors.push({ ts, code: "TIER_TIMEOUT", tool });
      continue;
    }
    if (kind === "guardrail" && typeof ev.rule === "string") {
      errors.push({ ts, code: `GUARDRAIL:${ev.rule}`, tool });
      continue;
    }
  }
  return errors;
}

export async function handleDoctor(
  _input: DoctorInput,
  ctx: RunContext,
): Promise<Envelope<DoctorResult>> {
  const startedAt = Date.now();
  const host = normalizeOllamaHost(process.env.OLLAMA_HOST);

  let reachable = false;
  let probeError: string | undefined;
  try {
    const probe = await ctx.client.probe(5_000);
    reachable = probe.ok;
    if (!probe.ok) probeError = probe.reason ?? "unreachable";
  } catch (err) {
    reachable = false;
    probeError = err instanceof Error ? err.message : String(err);
  }

  let pulled: string[] = [];
  let loaded: string[] = [];
  if (reachable) {
    const state = await fetchModelState(host, 5_000);
    pulled = state.pulled;
    loaded = state.loaded;
    if (state.error && !probeError) probeError = state.error;
  }

  const tiers = ctx.tiers;
  // Unique models required across tiers.
  const required = Array.from(
    new Set<string>([tiers.instant, tiers.workhorse, tiers.deep, tiers.embed]),
  );

  // Model-tag matching: Ollama's /api/tags returns `name` with an explicit
  // tag (e.g. `hermes3:8b`). Treat a required `name` (with or without tag)
  // as present if any pulled entry equals it OR its base-name (before `:`)
  // matches AND the tag matches the required tag.
  function isPresent(model: string, pool: string[]): boolean {
    if (pool.includes(model)) return true;
    // `hermes3` (no tag) should match `hermes3:latest`.
    if (!model.includes(":")) {
      return pool.some((p) => p === `${model}:latest` || p.startsWith(`${model}:`));
    }
    return false;
  }

  const missing = required.filter((m) => !isPresent(m, pulled));
  const suggested_pulls = missing.map((m) => `ollama pull ${m}`);

  const logPath = defaultLogPath();
  const recent_errors = await readRecentErrors(logPath);

  const result: DoctorResult = {
    ollama: {
      reachable,
      host,
      ...(probeError ? { error: probeError } : {}),
    },
    models: {
      required,
      pulled,
      loaded,
      missing,
      suggested_pulls,
    },
    profile: {
      name: ctx.hardwareProfile,
      tiers: {
        instant: tiers.instant,
        workhorse: tiers.workhorse,
        deep: tiers.deep,
        embed: tiers.embed,
      },
    },
    paths: {
      allowed_roots: resolveAllowedRoots(),
      artifact_root: defaultArtifactRoot(),
      log_path: logPath,
    },
    recent_errors,
    healthy: reachable && missing.length === 0,
  };

  const warnings: string[] = [];
  if (!reachable) {
    warnings.push(
      `Ollama unreachable at ${host} (${probeError ?? "unknown"}). Start it with 'ollama serve' or set OLLAMA_HOST.`,
    );
  }
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} required model(s) not pulled: ${missing.join(", ")}. Run: ${suggested_pulls.join(" && ")}`,
    );
  }

  const envelope = buildEnvelope<DoctorResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
  await ctx.logger.log(callEvent("ollama_doctor", envelope));
  return envelope;
}

// Test seams — surface the helpers without requiring the full Ollama client.
export const __doctorInternals = {
  readRecentErrors,
  resolveAllowedRoots,
  defaultLogPath,
  defaultArtifactRoot,
};
