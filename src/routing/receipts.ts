/**
 * Routing receipts — durable decision-vs-reality artifacts.
 *
 * One file per shadowed invocation at
 * `<cwd>/artifacts/routing-receipts/<tool>_<iso>.json`. The receipt is NOT
 * a transcript. It captures:
 *
 *   - pre-execution routing decision (ranked field, suggested route, context)
 *   - actual invoked route in canonical form
 *   - match classification (exact / kind-match / mismatch / abstain)
 *   - outcome summary linked to the actual artifact when the run produced one
 *   - runtime snapshot (profile / tier used / model / think flag) for
 *     future calibration in Phase 3D-D
 *
 * Law 1: the context powering `decision` is built PRE-execution. No post-run
 * facts ever feed back into the suggestion — that would poison the truth
 * surface Phase 3D-C audits and Phase 3D-D calibrates against.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Envelope } from "../envelope.js";
import type { RoutingDecision } from "./types.js";

export const ROUTING_RECEIPT_SCHEMA_VERSION = 1 as const;

export type MatchKind = "exact" | "kind_match" | "mismatch" | "abstain";

export interface RoutingReceiptActual {
  route_identity: string; // "atom:ollama_classify" | "pack:ollama_incident_pack"
  tool: string;
  job_hint: string | null;
}

export interface RoutingReceiptOutcome {
  ok: boolean;
  elapsed_ms: number;
  tier_used?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  /** Pack identity when the run produced a pack artifact. */
  artifact_ref?: { pack: string; slug: string; md_path?: string; json_path?: string };
  error_code?: string;
}

export interface RoutingReceiptRuntime {
  hardware_profile: string;
  /** Whether the call was made with think=true (best-effort, null when unknown). */
  think?: boolean | null;
  /**
   * Version stamp of the calibration overlay that produced `decision`.
   * "0" = no overlay (default scoring); other values are stable hashes
   * derived from the set of approved proposals.
   */
  calibration_version?: string;
}

export interface RoutingReceipt {
  schema_version: typeof ROUTING_RECEIPT_SCHEMA_VERSION;
  recorded_at: string;
  actual: RoutingReceiptActual;
  decision: RoutingDecision;
  match: { matched: boolean; kind: MatchKind };
  outcome: RoutingReceiptOutcome;
  runtime: RoutingReceiptRuntime;
  receipt_path: string;
}

/**
 * Classify suggestion vs actual into a match kind. Works for every
 * combination — when the router abstained but the operator invoked
 * something real, we flag "abstain" (a signal for Phase 3D-D calibration).
 */
export function classifyMatch(
  suggested: RoutingDecision["suggested"],
  actualIdentity: string,
): { matched: boolean; kind: MatchKind } {
  if (!suggested) return { matched: false, kind: "abstain" };
  // Suggested route identity in the same canonical form.
  const suggestedIdentity = suggested.kind === "skill"
    ? `skill:${suggested.ref}`
    : suggested.kind === "pack"
    ? `pack:ollama_${suggested.ref}`
    : suggested.kind === "atoms"
    ? `atoms:${suggested.ref}`
    : "no_suggestion:";

  if (suggestedIdentity === actualIdentity) return { matched: true, kind: "exact" };

  const [suggestedKind] = suggestedIdentity.split(":", 1);
  const [actualKind] = actualIdentity.split(":", 1);
  if (suggestedKind === actualKind) return { matched: false, kind: "kind_match" };
  return { matched: false, kind: "mismatch" };
}

export function receiptsDir(override?: string): string {
  return override ?? path.join(process.cwd(), "artifacts", "routing-receipts");
}

export async function writeRoutingReceipt(
  receipt: Omit<RoutingReceipt, "receipt_path">,
  opts: { dir?: string } = {},
): Promise<RoutingReceipt> {
  const dir = receiptsDir(opts.dir);
  await fs.mkdir(dir, { recursive: true });
  const stamp = receipt.recorded_at.replace(/[:.]/g, "-");
  const file = path.join(dir, `${receipt.actual.tool}_${stamp}.json`);
  const full: RoutingReceipt = { ...receipt, receipt_path: file };
  await fs.writeFile(file, JSON.stringify(full, null, 2), "utf8");
  return full;
}

// ── Outcome extraction helpers ──────────────────────────────

/**
 * Pull the (pack, slug) linkage out of a pack envelope's result. Pack
 * tools expose `result.artifact.{json_path, markdown_path}` — we peel
 * the slug from the json filename. Best-effort; returns undefined when
 * the shape doesn't match.
 */
export function extractArtifactRef(tool: string, envelope: Envelope<unknown>): RoutingReceiptOutcome["artifact_ref"] | undefined {
  const packByTool: Record<string, string> = {
    ollama_incident_pack: "incident_pack",
    ollama_repo_pack: "repo_pack",
    ollama_change_pack: "change_pack",
  };
  const pack = packByTool[tool];
  if (!pack) return undefined;
  const result = envelope.result as { artifact?: { json_path?: string; markdown_path?: string } } | undefined;
  const json = result?.artifact?.json_path;
  const md = result?.artifact?.markdown_path;
  if (!json) return undefined;
  const base = path.basename(json, ".json");
  return { pack, slug: base, md_path: md, json_path: json };
}

/** Pull short intent strings from the input. Fields we treat as intent:
 *   question / focus / query / task / topic / corpus_query
 * Content blobs (log_text, diff_text, text) are NEVER used — the router's
 * input_shape already captures their presence without leaking content.
 */
const INTENT_KEYS = ["question", "focus", "query", "task", "topic", "corpus_query"];

export function extractJobHint(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  for (const k of INTENT_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 400) return v;
  }
  return null;
}
