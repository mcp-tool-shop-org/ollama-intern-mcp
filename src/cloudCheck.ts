/**
 * `doctor --cloud-check` — the in-product proof that a cloud key works, and
 * the catalog check that says whether the configured cloud model ids still
 * exist (F-34227a72, F-2d685731).
 *
 * WHY THIS MODULE EXISTS
 *
 * The doctor cloud probe is `HttpOllamaClient.probe()`, which for kind:'cloud'
 * GETs `/api/tags` — and `/api/tags` returns 200 for an INVALID key (it lists
 * public models). `doctor.ts` documents that honestly, so `auth` could only
 * ever report `failed` (a definitive 401/403) or `unverified`, and the CLI
 * rendered `auth: unverified (checked on first call)`. In STANDBY the "first
 * call" never happens unless the operator already knows to invoke a tool with
 * `backend:'cloud'` — so the path from "I pasted a key" to "I know cloud
 * works" had no step the product provided. This is that step.
 *
 * The same probe threw away the `/api/tags` BODY, which is the live list of
 * cloud model ids. Cloud ids rotate server-side (see CLOUD_DEFAULT_MODEL's
 * docblock in profiles.ts and the 2026-06-09 minimax-m3 incident), and
 * `validateEnvModel` only checks the SHAPE of an id, never its existence.
 * So a retired or typo'd id was discovered only by paying for a call that
 * degraded to the small local model — for a whole 60s cooldown window, every
 * call, under cloud-primary. Reading the body costs nothing extra.
 *
 * EGRESS POSTURE (non-negotiable, read before adding a caller)
 *
 * Everything here is egress. It runs ONLY when the operator types
 * `--cloud-check`; nothing in this module may be called from startup, from a
 * standby routing decision, or from the default `doctor` path. Before the
 * first byte leaves, `runCloudCheck` prints the same point-of-egress
 * disclosure the standby routing path prints, and it writes a `cloud_egress`
 * NDJSON receipt. The generate is deliberately tiny (num_predict 8) and the
 * prompt is a fixed, non-sensitive literal — never operator content, never
 * anything read off the box.
 *
 * REPORT, NEVER ENFORCE (the catalog half)
 *
 * A catalog fetch that fails is reported as `unavailable` and changes
 * nothing — it must not block startup, flip `healthy`, or refuse a call the
 * backend would have served. A configured id missing from the catalog is
 * reported loudly but does NOT gate `--fail-unhealthy`: the list could be
 * incomplete or paginated, and a false negative that failed CI on a model
 * the backend would happily serve is a worse failure than the one being
 * fixed. The MEASURED verdict gates instead (see `shouldGate`).
 */

import { HttpOllamaClient, type OllamaClient } from "./ollama.js";
import type { CloudConfig } from "./profiles.js";
import { InternError } from "./errors.js";
import type { Logger } from "./observability.js";
import { timestamp } from "./observability.js";

/**
 * The fixed probe prompt. Deliberately a literal in source and not derived
 * from anything on the box: this string is the entire payload that leaves
 * the machine when an operator runs `--cloud-check`, so it must be legible
 * here rather than assembled at runtime. It also asks for a one-word answer
 * so a chatty model still fits inside num_predict.
 */
const CLOUD_CHECK_PROMPT = "Reply with the single word: ok";
/**
 * Output cap for the probe. Eight tokens is enough for a one-word reply plus
 * slack, and small enough that the check costs a rounding error. A THINKING
 * model will burn this on CoT and return an empty `response` — that is fine
 * and expected: this check proves AUTH and REACHABILITY, and an empty
 * response from an authenticated 200 still proves both (see `answered`).
 */
const CLOUD_CHECK_NUM_PREDICT = 8;

/** How an operator-configured cloud model id fared against the live catalog. */
export interface CatalogEntry {
  /** The env var that named it, e.g. `INTERN_CLOUD_DEEP_MODEL`. */
  source: string;
  /** The configured id, verbatim. */
  id: string;
  /**
   * `present`  — the id is in the catalog.
   * `missing`  — the catalog was read and the id is not in it.
   * `unknown`  — the catalog could not be read; nothing is claimed.
   */
  status: "present" | "missing" | "unknown";
  /** Nearest catalog id, when the configured one is missing and a close match exists. */
  suggestion?: string;
}

export interface CatalogReport {
  status: "ok" | "unavailable";
  /** Number of ids the backend listed. Absent when unavailable. */
  size?: number;
  /** Why the catalog could not be read. Present only when unavailable. */
  error?: string;
  entries: CatalogEntry[];
}

/**
 * The verdict on the key.
 *
 * `ok`          — a generate round-tripped. The ONLY state that proves the key.
 * `failed`      — a definitive 401/403. The key is bad.
 * `unverified`  — the host answered and rejected the request for a reason that
 *                 is NOT about the key (today: a 404 on the model id). The key
 *                 may well be fine; we refuse to claim it. This state exists
 *                 because collapsing it into `failed` would send an operator
 *                 hunting a key when the fix is INTERN_CLOUD_MODEL, and
 *                 collapsing it into `ok` would overclaim.
 * `unreachable` — timeout / network / 5xx. An outage, not operator config.
 */
export type CloudAuthVerdict = "ok" | "failed" | "unverified" | "unreachable";

export interface CloudCheckResult {
  host: string;
  mode: "standby" | "primary";
  auth: CloudAuthVerdict;
  /** The cloud model id we asked for (the instant-tier id). */
  model_requested: string;
  /** The model the backend echoed back. Absent unless the call succeeded. */
  served_model?: string;
  /**
   * True when the echoed model is neither the requested id nor its
   * tag-stripped form — i.e. the backend SUBSTITUTED a different model.
   * Live cloud strips the tag suffix (`deepseek-v4-pro:cloud` → served
   * `deepseek-v4-pro`), which is not a substitution; anything beyond that is
   * exactly what a caller-side served-model check exists to catch.
   */
  model_substituted?: boolean;
  /** Wall-clock ms for the generate attempt (not the catalog fetch). */
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  /**
   * True when the model returned non-empty text. False on an authenticated
   * 200 whose `response` was empty (a thinking model spending num_predict on
   * CoT). Reported, never treated as failure — see CLOUD_CHECK_NUM_PREDICT.
   */
  answered?: boolean;
  /** Error message when auth is not `ok`. */
  error?: string;
  /** Remediation sentence matching the verdict. Always present when not `ok`. */
  hint?: string;
  catalog: CatalogReport;
}

/**
 * Bounded Levenshtein distance. Returns `limit + 1` as soon as the true
 * distance is known to exceed `limit`, so a scan over a few hundred catalog
 * ids stays cheap. Only used to enrich a hint — never to make a decision.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length];
}

/** The part of an id before the tag: `deepseek-v4-pro:cloud` → `deepseek-v4-pro`. */
function baseName(id: string): string {
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(0, i);
}

/**
 * Nearest catalog id to a configured id that isn't in the catalog.
 *
 * Two passes, cheapest-and-most-likely first — the same "lead with the
 * probable typo" posture `suggestColonForm` takes when enriching a rejected
 * local model name:
 *   1. BASE-NAME match. The dominant real-world miss is a dropped or wrong
 *      tag (`deepseek-v4-pro` for `deepseek-v4-pro:cloud`), which an edit
 *      distance would rank behind unrelated same-length ids.
 *   2. Bounded edit distance over the whole catalog, accepting only a close
 *      match (<= 1/3 of the id's length, capped at 4). A loose threshold
 *      produces confident nonsense — a suggestion is worth printing only
 *      when it is probably right.
 * Returns undefined when nothing is close enough; no suggestion beats a
 * misleading one.
 */
export function nearestModelId(configured: string, catalog: readonly string[]): string | undefined {
  const base = baseName(configured);
  const byBase = catalog.find((c) => baseName(c) === base);
  if (byBase !== undefined) return byBase;
  const limit = Math.min(4, Math.max(1, Math.floor(configured.length / 3)));
  let best: string | undefined;
  let bestD = limit + 1;
  for (const c of catalog) {
    const d = editDistance(configured, c, limit);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= limit ? best : undefined;
}

/**
 * Compare configured model ids against a live catalog.
 *
 * `catalog === null` means the catalog could not be read: every entry comes
 * back `unknown` rather than `missing`. That distinction is the whole point —
 * "we could not check" must never render as "your model is gone."
 */
export function compareCatalog(
  configured: ReadonlyArray<{ source: string; id: string }>,
  catalog: readonly string[] | null,
): CatalogEntry[] {
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const { source, id } of configured) {
    // De-dupe by id: INTERN_CLOUD_MODEL serves instant+workhorse+deep by
    // default, and printing the same id three times buries the one that
    // differs. The FIRST source wins, so the most specific knob (deep) is
    // named only when it actually diverges.
    if (seen.has(id)) continue;
    seen.add(id);
    if (catalog === null) {
      out.push({ source, id, status: "unknown" });
      continue;
    }
    if (catalog.includes(id)) {
      out.push({ source, id, status: "present" });
      continue;
    }
    const suggestion = nearestModelId(id, catalog);
    out.push({ source, id, status: "missing", ...(suggestion ? { suggestion } : {}) });
  }
  return out;
}

export interface CloudCheckOptions {
  cloud: CloudConfig;
  /**
   * Where the `cloud_egress` receipt is written. Pass a REAL logger: the
   * receipt is an audit record of data leaving the machine and must outlive
   * the process, even though the CLI's doctor call itself uses a NullLogger
   * to keep a CLI invocation out of the tool-call histograms.
   */
  logger: Logger;
  /** Injectable client for tests. Defaults to a fresh cloud HttpOllamaClient. */
  client?: OllamaClient;
  /** Injectable clock for deterministic latency assertions. Default Date.now. */
  now?: () => number;
  /**
   * Sink for the point-of-egress disclosure. Defaults to stderr. Injectable
   * so a test can assert the disclosure PRECEDES the request rather than
   * scraping the console.
   */
  disclose?: (line: string) => void;
}

/**
 * Run the explicit cloud check. Never throws: every failure mode is a
 * reported verdict, because this is the tool an operator reaches for when
 * something is already wrong.
 *
 * Order is deliberate. The disclosure prints first (before any byte leaves).
 * The CATALOG fetch runs before the generate, so an operator whose model id
 * is retired is told so by the free `/api/tags` read rather than learning it
 * from a paid round-trip — and the generate still runs afterwards regardless,
 * because the catalog is advisory and must never refuse a call the backend
 * would have served.
 */
export async function runCloudCheck(opts: CloudCheckOptions): Promise<CloudCheckResult> {
  const { cloud, logger } = opts;
  const now = opts.now ?? Date.now;
  const disclose =
    opts.disclose ??
    ((line: string): void => {
      // eslint-disable-next-line no-console
      console.error(line);
    });
  const client =
    opts.client ??
    new HttpOllamaClient({ baseUrl: cloud.host, apiKey: cloud.apiKey, kind: "cloud" });
  const model = cloud.tiers.instant;
  const mode: "standby" | "primary" = cloud.standby ? "standby" : "primary";

  // Point-of-egress disclosure — the same posture as the standby routing
  // path (Homebrew #142 / GDPR Art. 25 privacy-by-default). Printed BEFORE
  // the first request, naming host, model, and the exact payload, so an
  // operator who typed the flag without reading the docs still sees what
  // they authorized at the moment it happens.
  disclose(
    `ollama-intern: CLOUD CHECK — contacting ${cloud.host} on your explicit --cloud-check request. This reads the model catalog and sends one ${CLOUD_CHECK_NUM_PREDICT}-token generate (model ${model}, fixed prompt "${CLOUD_CHECK_PROMPT}"). No file, log, or corpus content is sent.`,
  );

  // ── Catalog (free; a plain GET the cloud probe already performs) ──────────
  let catalogIds: string[] | null = null;
  let catalogError: string | undefined;
  try {
    catalogIds = (await client.listModels?.()) ?? null;
    if (catalogIds === null) catalogError = "client does not support listModels";
  } catch (err) {
    catalogIds = null;
    catalogError = err instanceof Error ? err.message : String(err);
  }
  const configured: Array<{ source: string; id: string }> = [
    { source: "INTERN_CLOUD_MODEL", id: cloud.tiers.instant },
    { source: "INTERN_CLOUD_DEEP_MODEL", id: cloud.tiers.deep },
  ];
  const catalog: CatalogReport = {
    status: catalogIds === null ? "unavailable" : "ok",
    ...(catalogIds !== null ? { size: catalogIds.length } : {}),
    ...(catalogError !== undefined ? { error: catalogError } : {}),
    entries: compareCatalog(configured, catalogIds),
  };

  // ── The one paid call ────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cloud.timeouts.instant);
  const started = now();
  try {
    const resp = await client.generate(
      {
        model,
        prompt: CLOUD_CHECK_PROMPT,
        options: { num_predict: CLOUD_CHECK_NUM_PREDICT, temperature: 0 },
        // Suppress CoT where the model honors it, so the eight tokens go to
        // the answer. Non-thinking models ignore the field.
        think: false,
      },
      controller.signal,
      "instant",
    );
    const latency_ms = now() - started;
    // Prefer the backend's own served-model echo over what we requested —
    // the same check routing.ts makes, for the same reason: live cloud strips
    // the tag suffix, and any divergence beyond that is a substitution the
    // operator needs to see.
    const served = typeof resp.model === "string" && resp.model !== "" ? resp.model : undefined;
    const substituted =
      served !== undefined && served !== model && served !== baseName(model) ? true : undefined;
    await writeEgressReceipt(logger, cloud.host, served ?? model, mode);
    return {
      host: cloud.host,
      mode,
      auth: "ok",
      model_requested: model,
      ...(served !== undefined ? { served_model: served } : {}),
      ...(substituted !== undefined ? { model_substituted: substituted } : {}),
      latency_ms,
      tokens_in: resp.prompt_eval_count ?? 0,
      tokens_out: resp.eval_count ?? 0,
      answered: typeof resp.response === "string" && resp.response.trim() !== "",
      catalog,
    };
  } catch (err) {
    const latency_ms = now() - started;
    // The request left the machine even when it failed — an auth rejection is
    // still egress, and an egress audit that only records successes is not an
    // audit. Record the receipt on every path.
    await writeEgressReceipt(logger, cloud.host, model, mode);
    const { auth, hint } = classifyCheckError(err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      host: cloud.host,
      mode,
      auth,
      model_requested: model,
      latency_ms,
      error: message,
      hint,
      catalog,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Map a failed check to an honest verdict plus the matching remediation. */
function classifyCheckError(err: unknown): { auth: CloudAuthVerdict; hint: string } {
  if (err instanceof InternError) {
    if (err.code === "OLLAMA_AUTH_FAILED") {
      return {
        auth: "failed",
        hint: "The key was rejected (401/403). Check OLLAMA_API_KEY against https://ollama.com/settings/keys. Note: the key is read ONCE at process start — after fixing it, restart the MCP server (the CLI re-reads it on every run).",
      };
    }
    if (err.code === "OLLAMA_MODEL_MISSING") {
      return {
        auth: "unverified",
        hint: "The host answered but the configured cloud model id was not found (404), so the key itself is neither proven nor disproven. Fix INTERN_CLOUD_MODEL / INTERN_CLOUD_DEEP_MODEL (see the Catalog block above for the nearest live id, or https://ollama.com/search?c=cloud) and re-run --cloud-check.",
      };
    }
  }
  if (err instanceof Error && err.name === "AbortError") {
    return {
      auth: "unreachable",
      hint: "The check timed out before the backend answered. This reads as an outage or a slow link, not a bad key — retry, or raise INTERN_CLOUD_TIMEOUT_INSTANT_MS if your link is slow.",
    };
  }
  return {
    auth: "unreachable",
    hint: "Could not reach the cloud host. Check OLLAMA_CLOUD_HOST, your network/proxy, and https://ollama.com status. Calls fall back to the local profile meanwhile.",
  };
}

/**
 * Write the `cloud_egress` NDJSON receipt for a check. Sizes and identities
 * only — never prompt or response CONTENT, so the receipt can never become a
 * second copy of what was sent. Failures are swallowed: a log write must not
 * turn a diagnostic command into an error.
 */
async function writeEgressReceipt(
  logger: Logger,
  host: string,
  model: string,
  mode: "standby" | "primary",
): Promise<void> {
  try {
    await logger.log({ kind: "cloud_egress", ts: timestamp(), host, model, mode, tier: "instant" });
  } catch {
    /* observability must never fail the command it is observing */
  }
}

/**
 * Should `--fail-unhealthy` exit non-zero because of this check?
 *
 * Gates on DEFINITIVE OPERATOR CONFIG only, which is the same line
 * `handleDoctor` already draws for `healthy` ("a bad cloud key counts as
 * unhealthy; a cloud outage does not"):
 *   - `failed`      → yes. The key is bad; a human must fix it.
 *   - `unverified`  → yes. A 404 on the pinned model id is config the
 *                     operator owns, measured against the live backend.
 *   - `unreachable` → NO. An outage is not a broken box, and a CI job that
 *                     goes red when ollama.com hiccups gets muted.
 *   - catalog misses → NO. A list lookup is advisory; a false negative that
 *                     failed CI on a model the backend would have served is
 *                     worse than the miss it reports.
 */
export function shouldGate(result: CloudCheckResult): boolean {
  return result.auth === "failed" || result.auth === "unverified";
}

/** Render the check as prose lines for the human `doctor` report. */
export function formatCloudCheck(r: CloudCheckResult): string[] {
  const out: string[] = [];
  out.push(`Cloud check (${r.mode}) — explicit egress, you asked for it:`);
  out.push(`  host:      ${r.host}`);
  const verdict =
    r.auth === "ok"
      ? "OK (a real generate round-tripped — the key works)"
      : r.auth === "failed"
        ? "FAILED (key rejected 401/403)"
        : r.auth === "unverified"
          ? "UNVERIFIED (host answered; model id wrong, so the key is unproven)"
          : "UNREACHABLE (timeout/network — an outage, not necessarily a bad key)";
  out.push(`  auth:      ${verdict}`);
  out.push(`  model:     requested=${r.model_requested}${r.served_model ? `  served=${r.served_model}` : ""}`);
  if (r.model_substituted) {
    out.push(`             SUBSTITUTED — the backend served a different model than requested.`);
  }
  out.push(`  latency:   ${r.latency_ms}ms`);
  if (r.tokens_in !== undefined || r.tokens_out !== undefined) {
    out.push(`  tokens:    in=${r.tokens_in ?? 0}  out=${r.tokens_out ?? 0}`);
  }
  if (r.answered === false) {
    out.push(
      `             (empty response — a thinking model spent the ${CLOUD_CHECK_NUM_PREDICT}-token budget on CoT. Auth and reachability are still proven.)`,
    );
  }
  if (r.error) out.push(`  error:     ${r.error}`);
  out.push(`  catalog:   ${r.catalog.status === "ok" ? `${r.catalog.size} model ids listed` : `unavailable (${r.catalog.error ?? "unknown"}) — nothing claimed about your ids`}`);
  for (const e of r.catalog.entries) {
    const status =
      e.status === "present"
        ? "present"
        : e.status === "missing"
          ? `NOT IN CATALOG${e.suggestion ? ` — nearest live id: ${e.suggestion}` : ""}`
          : "unknown (catalog unavailable)";
    out.push(`    ${e.id}  [${e.source}]  ${status}`);
  }
  if (r.hint) out.push(`  hint:      ${r.hint}`);
  return out;
}
