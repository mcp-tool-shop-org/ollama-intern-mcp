/**
 * Hardware profiles — pick the right tier ladder for the machine running Ollama.
 *
 * The same code runs against very different hardware. This module encodes
 * the "which model belongs on which tier for which box" decision explicitly
 * so it's a product choice, not an env-var scavenger hunt.
 *
 * - dev-rtx5080 (default): hermes3:8b ladder. Validated Hermes Agent
 *   integration path — Nous Research's hermes3:8b emits clean tool_calls
 *   over Ollama's /v1 chat endpoint and is the proven default for driving
 *   this MCP from an external agent (2026-04-19).
 * - dev-rtx5080-qwen3: Qwen 3 alternate rail. Same-family top-to-bottom
 *   Qwen 3 ladder for users who prefer Qwen tooling or want to compare.
 *   Picks up the `think` / THINK_BY_SHAPE plumbing in tiers.ts.
 * - m5-max: prod target. Qwen 3 ladder sized for 128GB unified memory.
 *
 * Per-tier env vars (INTERN_TIER_INSTANT, etc.) still override a profile's
 * model picks, so one-off experiments don't require a new profile.
 *
 * The retired `dev-rtx5080-llama` profile (Llama 3.1 on Deep) was dropped
 * at v2.0.0 — Llama 3.1 8B is obsolete, and the parity-rail experiment ran
 * its course.
 *
 * The retired qwen2.5 defaults (`qwen2.5:*-instruct-q4_K_M`) were dropped
 * at v2.0.0 — qwen2.5 is retired on modern Ollama installs and the
 * `INTERN_TIER_*` env knobs are sufficient for anyone pinning an older model.
 */

import type { Tier, TierConfig } from "./tiers.js";
import { InternError } from "./errors.js";

export type ProfileName = "dev-rtx5080" | "dev-rtx5080-qwen3" | "m5-max";

export interface Profile {
  name: ProfileName;
  description: string;
  tiers: TierConfig;
  /**
   * Per-tier timeouts in ms. Lives on the profile (not as a global constant)
   * because cold-load behavior is hardware-bound — Instant needs 15s of
   * margin on a 16GB-VRAM dev box but only 5s on M5 Max unified memory.
   * Found via the first live dogfood pass: all Instant calls on RTX 5080
   * timed out at 5s before first token.
   */
  timeouts: Record<Tier, number>;
  /**
   * Tiers to prewarm on server startup. Targeted adoption aid for tiers
   * most likely to become habit (Instant), where cold-load drag would
   * poison early product feel. NOT a blanket "make everything hot" knob —
   * Workhorse and Deep are deliberately excluded so VRAM pressure and
   * unintended residency churn don't start mattering.
   */
  prewarm: Tier[];
}

/** Timeouts sized for a 16GB-VRAM discrete-GPU box where cold load costs 3-5s. */
const DEV_RTX5080_TIMEOUTS: Record<Tier, number> = {
  instant: 15_000,
  workhorse: 20_000,
  deep: 90_000,
  embed: 10_000,
};

/** Timeouts sized for M5 Max 128GB unified memory where cold load is ~instant. */
const M5_MAX_TIMEOUTS: Record<Tier, number> = {
  instant: 5_000,
  workhorse: 20_000,
  deep: 90_000,
  embed: 10_000,
};

export const PROFILES: Record<ProfileName, Profile> = {
  "dev-rtx5080": {
    name: "dev-rtx5080",
    description:
      "RTX 5080 16GB VRAM — hermes3:8b ladder. Default dev profile. Validated Hermes Agent integration path (Nous Research hermes3:8b emits clean tool_calls over Ollama /v1).",
    tiers: {
      instant: "hermes3:8b",
      workhorse: "hermes3:8b",
      deep: "hermes3:8b",
      embed: "nomic-embed-text",
      // Per-tier num_ctx (v2.4.0): keep hermes3:8b resident in the 16GB
      // VRAM budget for fast tools. 32K default would spill to CPU and
      // turn workhorse extraction into a 5–10× latency event. deep stays
      // unset so long-context briefs / research keep current behavior;
      // we'd rather see the spill on the explicit long-context path than
      // proactively reduce the budget without dogfood evidence.
      num_ctx: {
        instant: 4096,
        workhorse: 8192,
        // deep: UNSET — preserves model-loaded default for long context.
        // embed: UNSET — embed model is small, no context-window pressure.
      },
    },
    timeouts: DEV_RTX5080_TIMEOUTS,
    prewarm: ["instant"],
  },
  "dev-rtx5080-qwen3": {
    name: "dev-rtx5080-qwen3",
    description:
      "RTX 5080 16GB VRAM — Qwen 3 alternate rail. Same-family top-to-bottom Qwen 3 ladder for callers who prefer it; uses THINK_BY_SHAPE plumbing.",
    tiers: {
      instant: "qwen3:8b",
      workhorse: "qwen3:8b",
      deep: "qwen3:14b",
      embed: "nomic-embed-text",
      // Same VRAM constraint as dev-rtx5080 — Qwen3 8B has the same
      // 16GB-VRAM ceiling at 32K context. Deep stays unset (qwen3:14b
      // is the long-context tier here; reducing it is a separate call).
      num_ctx: {
        instant: 4096,
        workhorse: 8192,
      },
    },
    timeouts: DEV_RTX5080_TIMEOUTS,
    prewarm: ["instant"],
  },
  "m5-max": {
    name: "m5-max",
    description: "M5 Max 128GB unified — Qwen 3 ladder sized for unified memory. Prod target.",
    tiers: {
      instant: "qwen3:14b",
      workhorse: "qwen3:14b",
      deep: "qwen3:32b",
      embed: "nomic-embed-text",
      // num_ctx UNSET on every tier: 128GB unified memory has no spill
      // problem at any reasonable context size. Operators tune per-tier
      // by editing this map if they ever need to.
    },
    timeouts: M5_MAX_TIMEOUTS,
    prewarm: [],
  },
};

export const DEFAULT_PROFILE: ProfileName = "dev-rtx5080";

function isProfileName(x: string | undefined): x is ProfileName {
  return x === "dev-rtx5080" || x === "dev-rtx5080-qwen3" || x === "m5-max";
}

/**
 * Resolve the active profile from env. Selection order:
 *   1. INTERN_PROFILE env var, if a known name
 *   2. DEFAULT_PROFILE (dev-rtx5080) when INTERN_PROFILE is unset/empty
 *
 * If INTERN_PROFILE is set to a value that isn't a known profile, throws
 * CONFIG_INVALID with the available names. Silent fallback (prior behavior
 * through Stage A) would mask a typo'd profile against the wrong hardware
 * ladder and bury the signal in late tier-timeout errors.
 *
 * Per-tier env vars (INTERN_TIER_INSTANT, etc.) override the profile's picks.
 * Profile.timeouts are not env-overridable — they are a hardware property,
 * not a one-off tuning knob.
 */
export function loadProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const raw = env.INTERN_PROFILE;
  let name: ProfileName;
  if (raw === undefined || raw === "") {
    name = DEFAULT_PROFILE;
  } else if (isProfileName(raw)) {
    name = raw;
  } else {
    const available = (Object.keys(PROFILES) as ProfileName[]).join(", ");
    throw new InternError(
      "CONFIG_INVALID",
      `Unknown profile '${raw}'`,
      `INTERN_PROFILE must be one of: ${available}. See README profile section, or unset INTERN_PROFILE to use the default (${DEFAULT_PROFILE}).`,
      false,
    );
  }
  const base = PROFILES[name];
  // FT-002 — fail-fast model-name validation on env overrides. Previously
  // a typo like `INTERN_TIER_DEEP=hermes3-8b` (dash where colon belongs)
  // silently survived load and surfaced HOURS later as OLLAMA_MODEL_MISSING
  // when the first deep-tier call hit /api/generate. The operator-blast-
  // radius of a stale env var is large enough to justify a synchronous
  // CONFIG_INVALID at startup; that's the price for not pretending
  // hermes3-8b is a valid Ollama model identifier.
  //
  // Validation rule mirrors Ollama's accepted model-name characters:
  // lowercase letters, digits, dots, underscores, hyphens, optionally
  // suffixed with `:` + a tag of the same alphabet. Empty values are
  // OK (they fall through to the profile default), so the validator
  // only fires on non-empty user-supplied values.
  validateEnvModel("INTERN_TIER_INSTANT", env.INTERN_TIER_INSTANT);
  validateEnvModel("INTERN_TIER_WORKHORSE", env.INTERN_TIER_WORKHORSE);
  validateEnvModel("INTERN_TIER_DEEP", env.INTERN_TIER_DEEP);
  validateEnvModel("INTERN_EMBED_MODEL", env.INTERN_EMBED_MODEL);
  const tiers: TierConfig = {
    instant: env.INTERN_TIER_INSTANT || base.tiers.instant,
    workhorse: env.INTERN_TIER_WORKHORSE || base.tiers.workhorse,
    deep: env.INTERN_TIER_DEEP || base.tiers.deep,
    embed: env.INTERN_EMBED_MODEL || base.tiers.embed,
    // num_ctx (v2.4.0) is profile-level only; no env override yet. Carry
    // the base profile's map through unchanged so per-tier num_ctx values
    // propagate to ctx.tiers.num_ctx for runner.ts / batch.ts to resolve.
    ...(base.tiers.num_ctx !== undefined ? { num_ctx: base.tiers.num_ctx } : {}),
  };
  return { name, description: base.description, tiers, timeouts: base.timeouts, prewarm: base.prewarm };
}

/**
 * Validation regex for Ollama model identifiers (FT-002).
 *
 * Ollama tag identifiers follow `name[:tag]`:
 *   - `name` is lowercase letters / digits / dots / underscores / hyphens.
 *     `ollama pull` and the registry reject uppercase in this segment, so
 *     we enforce the strict form to catch typos early.
 *   - `tag` (after the colon) allows mixed case because real-world
 *     quantization labels routinely capitalize (e.g. `custom:model-q4_K_M`
 *     for K-quants, `phi3:mini-4k-instruct-q5_K_M`). Lowercasing the tag
 *     in the validator would false-positive on legitimate overrides.
 *
 * Spaces, slashes, and other punctuation are still rejected on both
 * sides — Ollama would refuse them at pull time anyway, and the typo
 * blast-radius (hours-later OLLAMA_MODEL_MISSING) is exactly what
 * FT-002 exists to prevent.
 *
 * Exported so tests + the doctor CLI subcommand can reference the same
 * pattern (single source of truth for what counts as a model identifier).
 */
export const OLLAMA_MODEL_NAME_RE =
  /^(?![a-z0-9._-]+-\d{1,4}[a-z]?$)[a-z0-9._-]+(:[A-Za-z0-9._-]+)?$/;

/**
 * Validation bounds for Ollama `num_ctx` (FT-002).
 *
 * Lower bound 256 — Ollama refuses anything smaller as unworkable
 * (insufficient room for any meaningful prompt). Upper bound 1,048,576
 * (1M tokens) covers the largest currently-shipped open weights
 * (Llama 4 1M context, future Qwen 4) with headroom; anything beyond
 * is almost certainly a typo or stale config copied from a marketing
 * deck rather than an Ollama-supported value.
 */
export const NUM_CTX_MIN = 256;
export const NUM_CTX_MAX = 1_048_576;

/**
 * Heuristic: detect the `<name>-<tag>` dash-typo where a `:` was meant.
 * Real Ollama tags overwhelmingly look like `<digits><opt-letter>` (e.g.
 * `8b`, `14b`, `32b`), so a value with no colon but a trailing
 * `-<digits>[letter]` segment is almost certainly the typo
 * (`hermes3-8b` instead of `hermes3:8b`). Returns the suggested colon
 * form when detected; returns `null` when the value looks like a
 * legitimate hyphenated identifier such as `nomic-embed-text`.
 *
 * Used to ENRICH error hints — not to drive rejection. The validator's
 * regex is intentionally permissive on hyphens (matches the FT-002 spec
 * literal regex `^[a-z0-9._-]+(:[a-z0-9._-]+)?$`); detection of the
 * typo shape powers the suggestion but doesn't itself throw, so a
 * legitimate-but-unusual hyphenated name doesn't false-positive.
 */
function suggestColonForm(value: string): string | null {
  if (value.includes(":")) return null;
  const m = value.match(/^(.+)-(\d{1,4}[a-z]?)$/);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

/**
 * Validate an environment-supplied Ollama model name (FT-002). No-op
 * when the value is unset (the env-override merge falls back to the
 * profile default). Throws `InternError('CONFIG_INVALID', ...)`
 * synchronously on a regex-failing value — the operator sees the
 * failure at startup with a hint that names the variable, shows the
 * bad value, the valid pattern, and (where reasonable) a most-likely-
 * typo suggestion via `suggestColonForm`.
 *
 * Per the v2.5 contract, the regex `OLLAMA_MODEL_NAME_RE` is the sole
 * gate — the dash-form `hermes3-8b` syntactically matches the regex
 * (hyphens are valid in the name segment) so it currently passes
 * validation and the failure surfaces later as OLLAMA_MODEL_MISSING
 * from /api/generate. The full typo-rejection version is tracked as
 * an open question on the test surface; tightening the regex without
 * also widening the doctrine would break `nomic-embed-text` style
 * legitimate names.
 */
function validateEnvModel(varName: string, value: string | undefined): void {
  if (value === undefined || value === "") return;
  if (OLLAMA_MODEL_NAME_RE.test(value)) return;
  const suggested = suggestColonForm(value);
  const suggestion = suggested ? ` Did you mean '${suggested}'?` : "";
  throw new InternError(
    "CONFIG_INVALID",
    `Invalid model name in ${varName}: '${value}' does not match ${OLLAMA_MODEL_NAME_RE.source}`,
    `Fix the ${varName} env var.${suggestion} Valid pattern: ${OLLAMA_MODEL_NAME_RE.source} (lowercase letters/digits/dots/underscores/hyphens, optional ':tag').`,
    false,
  );
}

/**
 * Validate an integer `num_ctx` value sourced from env or config.
 * No-op when unset/undefined. Throws `InternError('CONFIG_INVALID')`
 * when out of bounds or non-integer. Exported for use by future
 * env-override paths and by the doctor CLI subcommand.
 */
export function validateNumCtx(varName: string, value: unknown): void {
  if (value === undefined || value === null) return;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < NUM_CTX_MIN || n > NUM_CTX_MAX) {
    throw new InternError(
      "CONFIG_INVALID",
      `Invalid num_ctx in ${varName}: '${String(value)}' is not an integer in [${NUM_CTX_MIN}, ${NUM_CTX_MAX}]`,
      `Fix the ${varName} value. Ollama accepts integer num_ctx values between ${NUM_CTX_MIN} and ${NUM_CTX_MAX}.`,
      false,
    );
  }
}

export interface EnvOverride {
  key: string;
  tier: Tier;
  from: string;
  to: string;
}

/**
 * Report tier-model env overrides relative to the active profile's baseline.
 *
 * Called ONCE at startup from main() so the operator sees, e.g.,
 *   "INTERN_TIER_DEEP overrides deep: hermes3:8b → custom:model-q4_K_M"
 * on stderr — instead of silently pinning the wrong model and wondering
 * later why benchmarks look off. Pure function, no side effects; caller
 * decides how to surface it.
 */
export function detectEnvOverrides(env: NodeJS.ProcessEnv = process.env): EnvOverride[] {
  const name: ProfileName = isProfileName(env.INTERN_PROFILE) ? env.INTERN_PROFILE : DEFAULT_PROFILE;
  const base = PROFILES[name];
  const out: EnvOverride[] = [];
  const pairs: Array<[string, Tier, string | undefined]> = [
    ["INTERN_TIER_INSTANT", "instant", env.INTERN_TIER_INSTANT],
    ["INTERN_TIER_WORKHORSE", "workhorse", env.INTERN_TIER_WORKHORSE],
    ["INTERN_TIER_DEEP", "deep", env.INTERN_TIER_DEEP],
    ["INTERN_EMBED_MODEL", "embed", env.INTERN_EMBED_MODEL],
  ];
  for (const [key, tier, value] of pairs) {
    if (value && value !== base.tiers[tier]) {
      out.push({ key, tier, from: base.tiers[tier], to: value });
    }
  }
  return out;
}

// ── Ollama Cloud (optional, opt-in) ──────────────────────────────────────────
//
// Cloud is OFF by default. The package stays local-first with zero egress
// unless BOTH OLLAMA_CLOUD_PRIMARY and OLLAMA_API_KEY are set. When enabled,
// cloud serves the generative tiers (instant/workhorse/deep) and the local
// profile becomes the fallback; embeddings stay local always (Ollama Cloud
// serves no embedding models).

/** Resolved cloud configuration. Null when cloud is not opted into. */
export interface CloudConfig {
  /** Cloud base host, e.g. https://ollama.com. */
  host: string;
  /** Bearer API key (OLLAMA_API_KEY). */
  apiKey: string;
  /**
   * Cloud model per tier. instant/workhorse use INTERN_CLOUD_MODEL; deep uses
   * INTERN_CLOUD_DEEP_MODEL when set (else the same model). `embed` is carried
   * for shape only — embeddings never route to cloud.
   */
  tiers: TierConfig;
  /** Per-tier cloud-attempt timeout (ms). Cloud is far slower than local 8B. */
  timeouts: Record<Tier, number>;
  /** Context-window cap (tokens) applied to every cloud request (GPU-time control). */
  numCtx: number;
}

const CLOUD_DEFAULT_HOST = "https://ollama.com";
/**
 * Default cloud model. minimax-m3:cloud is the current flagship successor to
 * the 2026-06-16-retiring minimax-m2 — fast for a big model, 512K–1M context
 * (fits the file-reading flagship tools), thinking-capable. NEVER default to a
 * deprecation-listed id (minimax-m2, glm-4.6, kimi-k2:1t, cogito-2.1:671b,
 * qwen3-vl:235b).
 */
const CLOUD_DEFAULT_MODEL = "minimax-m3:cloud";
const CLOUD_DEFAULT_TIMEOUTS: Record<Tier, number> = {
  instant: 30_000,
  workhorse: 120_000,
  deep: 300_000,
  embed: 10_000,
};
const CLOUD_DEFAULT_NUM_CTX = 32_768;

/** Truthy values that enable cloud-primary mode. */
function isCloudEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.OLLAMA_CLOUD_PRIMARY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Strip trailing slashes; default to ollama.com; ensure an https scheme. */
function normalizeCloudHost(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return CLOUD_DEFAULT_HOST;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

/** Parse a positive-integer env value; fall back when unset/empty/invalid. */
function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the cloud configuration from env, or null when cloud is not opted
 * into. Throws CONFIG_INVALID (fail-fast at startup) when OLLAMA_CLOUD_PRIMARY
 * is enabled but OLLAMA_API_KEY is missing, or a cloud model name is malformed.
 *
 * Env surface:
 *   OLLAMA_CLOUD_PRIMARY        opt-in switch (1/true/yes/on)
 *   OLLAMA_API_KEY              bearer key (required when enabled)
 *   OLLAMA_CLOUD_HOST           default https://ollama.com
 *   INTERN_CLOUD_MODEL          default minimax-m3:cloud (instant+workhorse+deep)
 *   INTERN_CLOUD_DEEP_MODEL     optional deep-only override (e.g. deepseek-v3.1:671b)
 *   INTERN_CLOUD_TIMEOUT_*_MS   per-tier cloud timeouts (instant/workhorse/deep)
 *   INTERN_CLOUD_NUM_CTX        cloud context-window cap (default 32768)
 */
export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig | null {
  if (!isCloudEnabled(env)) return null;
  const apiKey = (env.OLLAMA_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new InternError(
      "CONFIG_INVALID",
      "OLLAMA_CLOUD_PRIMARY is enabled but OLLAMA_API_KEY is not set.",
      "Set OLLAMA_API_KEY (create a key at https://ollama.com/settings/keys), or unset OLLAMA_CLOUD_PRIMARY to run local-only. Note: a GitHub Actions secret is NOT visible to the running server — the key must be a local env var passed via your MCP client's env block.",
      false,
    );
  }
  const model = (env.INTERN_CLOUD_MODEL || CLOUD_DEFAULT_MODEL).trim();
  const deepModel = (env.INTERN_CLOUD_DEEP_MODEL || model).trim();
  // Reuse the same fail-fast model-name validation as the local tiers.
  validateEnvModel("INTERN_CLOUD_MODEL", model);
  validateEnvModel("INTERN_CLOUD_DEEP_MODEL", deepModel);

  const numCtx = positiveIntEnv(env.INTERN_CLOUD_NUM_CTX, CLOUD_DEFAULT_NUM_CTX);
  validateNumCtx("INTERN_CLOUD_NUM_CTX", numCtx);

  const tiers: TierConfig = {
    instant: model,
    workhorse: model,
    deep: deepModel,
    // Embeddings never route to cloud; carry the local embed model for shape.
    embed: env.INTERN_EMBED_MODEL || "nomic-embed-text",
  };
  const timeouts: Record<Tier, number> = {
    instant: positiveIntEnv(env.INTERN_CLOUD_TIMEOUT_INSTANT_MS, CLOUD_DEFAULT_TIMEOUTS.instant),
    workhorse: positiveIntEnv(env.INTERN_CLOUD_TIMEOUT_WORKHORSE_MS, CLOUD_DEFAULT_TIMEOUTS.workhorse),
    deep: positiveIntEnv(env.INTERN_CLOUD_TIMEOUT_DEEP_MS, CLOUD_DEFAULT_TIMEOUTS.deep),
    embed: CLOUD_DEFAULT_TIMEOUTS.embed,
  };

  return {
    host: normalizeCloudHost(env.OLLAMA_CLOUD_HOST),
    apiKey,
    tiers,
    timeouts,
    numCtx,
  };
}
