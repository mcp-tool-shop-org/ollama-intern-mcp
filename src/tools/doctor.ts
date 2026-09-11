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
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOG_STATS_MAX_BYTES, readLogSuffix } from "./logRead.js";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { normalizeOllamaHost } from "../ollama.js";
import { RoutingOllamaClient } from "../routing.js";
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
    /** Live log size in bytes. Absent when the file is missing. */
    log_bytes?: number;
    /** True when log_bytes exceeds LOG_STATS_MAX_BYTES (log_stats will refuse). */
    log_over_stats_cap?: boolean;
  };
  /**
   * Cloud-primary status. Present only when cloud is opted into
   * (OLLAMA_CLOUD_PRIMARY + OLLAMA_API_KEY). `reachable` = the cloud host
   * answered; `auth_ok` = the Bearer key was accepted (not 401/403);
   * `circuit_state` reflects the live routing breaker when available.
   */
  cloud?: {
    enabled: boolean;
    /**
     * 'primary' = cloud serves the generative tiers by default (v2.7.0);
     * 'standby' = local-primary, cloud serves only per-call backend:'cloud'
     * escalations (F2a, v2.9).
     */
    mode: "primary" | "standby";
    host: string;
    reachable: boolean;
    /**
     * 'failed' on a definitive 401/403; 'unverified' otherwise. NOTE: the
     * cloud /api/tags probe lists public models and does NOT gate on the key,
     * so a reachable host cannot confirm a GOOD key — the key is truly
     * validated on the first real generate call (where a bad key trips the
     * sticky breaker). We never claim 'ok' from a probe that can't prove it.
     */
    auth: "failed" | "unverified";
    models: { instant: string; workhorse: string; deep: string };
    /**
     * The LIVE cloud roster, sorted and capped at CLOUD_ROSTER_CAP. This
     * is the in-product answer to "which frontier models can my key
     * actually reach?" — the question the cloud
     * positioning invites and that previously required a browser trip to
     * ollama.com/search?c=cloud. Empty when the roster call failed; an
     * empty roster is NOT evidence that a configured model is gone.
     */
    models_available: string[];
    /** True when the roster was longer than CLOUD_ROSTER_CAP and `models_available` was trimmed. `models_missing` is always computed against the FULL roster. */
    models_available_truncated?: boolean;
    /**
     * Configured tier models the live roster does not list. Cloud ids are
     * VOLATILE — they rotate and retire server-side — so a typo'd or
     * retired INTERN_CLOUD_MODEL used to read as healthy right up to the
     * first real call, where it burned the cloud_model_missing cooldown.
     * Always `[]` when the roster came back empty (can't prove absence
     * from no data).
     */
    models_missing: string[];
    circuit_state?: string;
    error?: string;
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
 * Payload cap for `cloud.models_available`. The cloud roster is a few dozen
 * ids today; the cap exists so a future catalog explosion can't turn a
 * status snapshot into a multi-KB dump. Membership checks run against the
 * FULL roster, never the capped view.
 */
const CLOUD_ROSTER_CAP = 200;

/**
 * Fetch the LIVE Ollama Cloud model roster with an authenticated GET of
 * /api/tags.
 *
 * This replaces a `HttpOllamaClient.probe()` call that hit exactly this
 * endpoint (for a cloud client, probe's path IS /api/tags) and then threw
 * the body away to return `{ok}`. The body is the only thing in the product
 * that can answer "which frontier models can my key actually reach?", and
 * without it `cloud.models` was a verbatim echo of the configured strings —
 * validated against nothing.
 *
 * Reachability semantics are preserved byte-for-byte: any HTTP response
 * (even 401) proves the host answered, and only a definitive 401/403 proves
 * a bad key — /api/tags returns 200 for an invalid key because it lists
 * public models, so a 200 is 'unverified', never 'ok'.
 */
async function fetchCloudRoster(
  host: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ models: string[]; reachable: boolean; authFailed: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}/api/tags`, {
      // Mirrors HttpOllamaClient.headers() for a cloud client.
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        models: [],
        reachable: true,
        authFailed: res.status === 401 || res.status === 403,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const list = Array.isArray(body.models) ? body.models : [];
    return {
      models: list.map((m) => m.name ?? m.model ?? "").filter(Boolean),
      reachable: true,
      authFailed: false,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const msg = err instanceof Error ? err.message : String(err);
    return {
      models: [],
      reachable: false,
      authFailed: false,
      error: name === "AbortError" ? `timeout after ${timeoutMs}ms` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which env var sets a given cloud tier's model. instant + workhorse share
 * INTERN_CLOUD_MODEL; deep reads INTERN_CLOUD_DEEP_MODEL and falls back to
 * INTERN_CLOUD_MODEL when that is unset (profiles.ts). Naming the knob is
 * the difference between "a model is missing" and "here is what to edit".
 */
function cloudTierEnvVar(tier: "instant" | "workhorse" | "deep"): string {
  if (tier !== "deep") return "INTERN_CLOUD_MODEL";
  return process.env.INTERN_CLOUD_DEEP_MODEL ? "INTERN_CLOUD_DEEP_MODEL" : "INTERN_CLOUD_MODEL";
}

/**
 * Read a bounded suffix of the NDJSON log and return the last 10 events that
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
    body = await readLogSuffix(logPath);
  } catch {
    return [];
  }
  const lines = body.split("\n").filter((l) => l.length > 0);
  // Walk from the end so we cap collected errors; the read itself is a
  // bounded suffix (see readLogSuffix), not a whole-file slurp.
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

  // Cloud-primary probe (optional). A 401/403 means reachable-but-bad-key;
  // a timeout/network error means unreachable. Either way the server still
  // works via local fallback, so this is informational + a warning, never a
  // hard failure. Build a throwaway cloud client so the auth + /api/tags path
  // is exercised exactly as the real routing client would.
  let cloudStatus: DoctorResult["cloud"];
  // Cloud tier models that the live roster does not list, paired with the
  // env var that sets each — hoisted so the warning block below can name
  // them. Empty unless the roster actually came back with entries.
  const cloudMissing: Array<{ model: string; tiers: string[]; envVar: string }> = [];
  if (ctx.cloud) {
    // The roster call IS the reachability probe — same endpoint, same Bearer
    // header, same 401/403 semantics — except it keeps the body.
    const cr = await fetchCloudRoster(ctx.cloud.host, ctx.cloud.apiKey, 5_000);
    const reason = cr.error ?? "";
    const auth: "failed" | "unverified" = cr.authFailed ? "failed" : "unverified";

    // Validate the CONFIGURED tier models against the LIVE roster — the
    // cloud mirror of `missing` / `suggested_pulls` on the local side.
    // Absence is only provable from a non-empty roster: an outage or a
    // 401 must not be reported as "your models are gone".
    const cloudTiers: Array<["instant" | "workhorse" | "deep", string]> = [
      ["instant", ctx.cloud.tiers.instant],
      ["workhorse", ctx.cloud.tiers.workhorse],
      ["deep", ctx.cloud.tiers.deep],
    ];
    if (cr.models.length > 0) {
      // Dedupe by model id — instant/workhorse/deep commonly share one id,
      // and one rotated id must not read as three separate failures.
      const byModel = new Map<string, { model: string; tiers: string[]; envVar: string }>();
      for (const [tier, model] of cloudTiers) {
        if (isPresent(model, cr.models)) continue;
        const entry = byModel.get(model);
        if (entry) {
          entry.tiers.push(tier);
          continue;
        }
        byModel.set(model, { model, tiers: [tier], envVar: cloudTierEnvVar(tier) });
      }
      cloudMissing.push(...byModel.values());
    }

    const rosterSorted = [...cr.models].sort();
    cloudStatus = {
      enabled: true,
      mode: ctx.cloud.standby ? "standby" : "primary",
      host: ctx.cloud.host,
      reachable: cr.reachable,
      auth,
      models: {
        instant: ctx.cloud.tiers.instant,
        workhorse: ctx.cloud.tiers.workhorse,
        deep: ctx.cloud.tiers.deep,
      },
      models_available: rosterSorted.slice(0, CLOUD_ROSTER_CAP),
      ...(rosterSorted.length > CLOUD_ROSTER_CAP ? { models_available_truncated: true } : {}),
      models_missing: cloudMissing.map((m) => m.model),
      ...(ctx.client instanceof RoutingOllamaClient
        ? { circuit_state: ctx.client.breaker.currentState }
        : {}),
      ...(cr.error ? { error: reason || "unreachable" } : {}),
    };
  }

  const logPath = defaultLogPath();
  const recent_errors = await readRecentErrors(logPath);
  let logBytes: number | undefined;
  try {
    logBytes = (await stat(logPath)).size;
  } catch {
    logBytes = undefined;
  }

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
      ...(logBytes !== undefined
        ? {
            log_bytes: logBytes,
            log_over_stats_cap: logBytes > LOG_STATS_MAX_BYTES,
          }
        : {}),
    },
    ...(cloudStatus ? { cloud: cloudStatus } : {}),
    recent_errors,
    // healthy = "is this box actually set up?" — local reachable, required
    // models pulled, and (F5, v2.9) no DEFINITIVE cloud misconfiguration.
    // A bad key (auth 'failed' on the probe, or the sticky 'misconfigured'
    // breaker tripped by a live 401) is broken operator config and must
    // surface here; a cloud OUTAGE (unreachable host) is not the operator's
    // fault and does NOT flip healthy — local fallback keeps serving, and
    // the warning below says so.
    healthy:
      reachable &&
      missing.length === 0 &&
      !(cloudStatus && (cloudStatus.auth === "failed" || cloudStatus.circuit_state === "misconfigured")),
  };

  const warnings: string[] = [];
  if (!reachable) {
    warnings.push(
      `Ollama unreachable at ${host} (${probeError ?? "unknown"}). Start it with 'ollama serve' or set OLLAMA_HOST.`,
    );
  }
  if (cloudStatus && cloudStatus.auth === "failed") {
    warnings.push(
      `Ollama Cloud auth failed at ${cloudStatus.host} — check OLLAMA_API_KEY (https://ollama.com/settings/keys). Calls fall back to the local profile until fixed.`,
    );
  } else if (cloudStatus && !cloudStatus.reachable) {
    warnings.push(
      `Ollama Cloud unreachable at ${cloudStatus.host} (${cloudStatus.error ?? "unknown"}). Calls fall back to the local profile until cloud recovers.`,
    );
  }
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} required model(s) not pulled: ${missing.join(", ")}. Run: ${suggested_pulls.join(" && ")}`,
    );
  }
  // The cloud half of the same check. Deliberately does NOT flip `healthy`:
  // a rotated cloud id degrades to local (degrade_reason:
  // cloud_model_missing) and is not a broken box — the same reasoning this
  // file already applies to a cloud outage.
  if (cloudMissing.length > 0) {
    const detail = cloudMissing
      .map((m) => `${m.model} (${m.tiers.join("+")} tier — set ${m.envVar})`)
      .join("; ");
    warnings.push(
      `Ollama Cloud does not list ${cloudMissing.length} configured tier model(s): ${detail}. Cloud ids rotate and retire server-side; pick a current one from cloud.models_available. Calls on those tiers degrade to local (degrade_reason: cloud_model_missing) instead of failing.`,
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
  // F4 seam: the cloud roster fetch + its env-var attribution, so the
  // 401 / timeout / truncation branches are testable without standing up
  // a RunContext and a whole cloud config.
  fetchCloudRoster,
  cloudTierEnvVar,
  CLOUD_ROSTER_CAP,
};
