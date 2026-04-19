/**
 * Skill runner — executes a Skill pipeline against the existing handler registry.
 *
 * Responsibilities:
 *   1. Resolve `${input.x}` and `${step_id.result.x}` templates in each step's inputs.
 *   2. Validate resolved inputs against the tool's zod schema.
 *   3. Call the handler, capture the envelope.
 *   4. On error: abort unless step.optional, then record the failure.
 *   5. Write a durable receipt artifact.
 *
 * The runner deliberately does NOT touch the frozen tool surface — it only
 * composes existing handlers. A skill is a policy over atoms/packs, not a
 * new primitive.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { InternError, toErrorShape } from "../errors.js";
import type { RunContext } from "../runContext.js";
import { SKILL_HANDLERS } from "./registry.js";
import type { LoadedSkill, SkillReceipt, SkillStep, StepRecord } from "./types.js";

export interface SkillRunOptions {
  /** Caller-supplied inputs, referenced in templates as ${input.name}. */
  inputs: Record<string, unknown>;
  /** Override the artifact directory. Defaults to <cwd>/artifacts/skill-receipts. */
  receiptsDir?: string;
}

const TEMPLATE_RE = /\$\{([^}]+)\}/g;

/**
 * Walk a dotted path (e.g. "result.digest.files.0") into a nested object.
 * Returns undefined for missing paths. Does not throw — the caller can choose
 * whether a missing template resolution is fatal.
 */
function walkPath(root: unknown, dotted: string): unknown {
  const parts = dotted.split(".").filter((p) => p.length > 0);
  let cur: unknown = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

function resolveTemplatesInString(
  tpl: string,
  inputs: Record<string, unknown>,
  stepOutputs: Record<string, unknown>,
): unknown {
  // If the entire string is a single template, return the resolved value (preserving type).
  const single = tpl.match(/^\$\{([^}]+)\}$/);
  if (single) {
    return resolveOneRef(single[1], inputs, stepOutputs);
  }
  // Otherwise stringify each resolution and return a string.
  return tpl.replace(TEMPLATE_RE, (_, ref: string) => {
    const resolved = resolveOneRef(ref, inputs, stepOutputs);
    if (resolved === undefined || resolved === null) return "";
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

function resolveOneRef(
  ref: string,
  inputs: Record<string, unknown>,
  stepOutputs: Record<string, unknown>,
): unknown {
  const trimmed = ref.trim();
  const [head, ...rest] = trimmed.split(".");
  const tail = rest.join(".");
  if (head === "input") {
    return tail ? walkPath(inputs, tail) : inputs;
  }
  if (head in stepOutputs) {
    return tail ? walkPath(stepOutputs[head], tail) : stepOutputs[head];
  }
  return undefined;
}

function resolveValue(
  value: unknown,
  inputs: Record<string, unknown>,
  stepOutputs: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    return resolveTemplatesInString(value, inputs, stepOutputs);
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, inputs, stepOutputs));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, inputs, stepOutputs);
    }
    return out;
  }
  return value;
}

/**
 * Compute the path we'll write to, stamp the receipt with that absolute path
 * before writing, then persist. Earlier this function took a stub with an
 * empty receipt_path and only populated the caller's copy — the file on
 * disk had empty receipt_path, which broke memory-layer provenance. Now the
 * disk receipt always carries its own absolute path.
 */
async function writeReceipt(receipt: SkillReceipt, receiptsDir: string): Promise<SkillReceipt> {
  await fs.mkdir(receiptsDir, { recursive: true });
  const stamp = receipt.started_at.replace(/[:.]/g, "-");
  const file = path.join(receiptsDir, `${receipt.skill_id}_${stamp}.json`);
  const finalReceipt: SkillReceipt = { ...receipt, receipt_path: file };
  await fs.writeFile(file, JSON.stringify(finalReceipt, null, 2), "utf8");
  return finalReceipt;
}

export interface SkillRunOutput {
  result: unknown;
  receipt: SkillReceipt;
}

export async function runSkill(
  loaded: LoadedSkill,
  ctx: RunContext,
  opts: SkillRunOptions,
): Promise<SkillRunOutput> {
  const { skill, source_path } = loaded;
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const stepOutputs: Record<string, unknown> = {};
  const steps: StepRecord[] = [];
  let ok = true;
  let aborted = false;

  for (const step of skill.pipeline) {
    if (aborted) {
      steps.push({ step_id: step.id, tool: step.tool, ok: false, elapsed_ms: 0, skipped: true });
      continue;
    }
    const record = await runStep(step, ctx, opts.inputs, stepOutputs);
    steps.push(record);
    if (record.ok) {
      stepOutputs[step.id] = record.envelope;
    } else if (!step.optional) {
      ok = false;
      aborted = true;
    } else {
      stepOutputs[step.id] = null;
    }
  }

  const resultStep = steps.find((s) => s.step_id === skill.result_from);
  const envelope = resultStep?.envelope as { result?: unknown } | undefined;
  const result = ok && envelope ? envelope.result : null;

  const receiptsDir =
    opts.receiptsDir ?? path.join(process.cwd(), "artifacts", "skill-receipts");
  const receiptStub: SkillReceipt = {
    skill_id: skill.id,
    skill_version: skill.version,
    skill_source_path: source_path,
    started_at: startedAtIso,
    elapsed_ms: Date.now() - startedAtMs,
    hardware_profile: ctx.hardwareProfile,
    inputs: opts.inputs,
    steps,
    result,
    ok,
    receipt_path: "",
  };
  const receipt = await writeReceipt(receiptStub, receiptsDir);

  return { result, receipt };
}

async function runStep(
  step: SkillStep,
  ctx: RunContext,
  inputs: Record<string, unknown>,
  stepOutputs: Record<string, unknown>,
): Promise<StepRecord> {
  const entry = SKILL_HANDLERS[step.tool];
  const stepStart = Date.now();
  if (!entry) {
    return {
      step_id: step.id,
      tool: step.tool,
      ok: false,
      elapsed_ms: 0,
      error: {
        code: "SCHEMA_INVALID",
        message: `Unknown tool "${step.tool}" referenced by step "${step.id}".`,
        hint: "Skills can only call registered tools — see listSkillCallableTools().",
      },
    };
  }

  let resolvedInputs: unknown;
  try {
    resolvedInputs = resolveValue(step.inputs, inputs, stepOutputs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      step_id: step.id,
      tool: step.tool,
      ok: false,
      elapsed_ms: Date.now() - stepStart,
      error: {
        code: "SCHEMA_INVALID",
        message: `Template resolution failed: ${msg}`,
        hint: "Check ${step_id.result.path} references against prior step outputs.",
      },
    };
  }

  const parsed = entry.schema.safeParse(resolvedInputs);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i: { path: Array<string | number>; message: string }) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      step_id: step.id,
      tool: step.tool,
      ok: false,
      elapsed_ms: Date.now() - stepStart,
      error: {
        code: "SCHEMA_INVALID",
        message: `Resolved inputs failed schema validation: ${detail}`,
        hint: "Fix the step.inputs or the upstream step's output shape.",
      },
    };
  }

  try {
    const envelope = await entry.handler(parsed.data, ctx);
    return {
      step_id: step.id,
      tool: step.tool,
      ok: true,
      elapsed_ms: Date.now() - stepStart,
      resolved_inputs: parsed.data,
      envelope,
    };
  } catch (err) {
    const shape = toErrorShape(err);
    return {
      step_id: step.id,
      tool: step.tool,
      ok: false,
      elapsed_ms: Date.now() - stepStart,
      resolved_inputs: parsed.data,
      error: { code: shape.code, message: shape.message, hint: shape.hint },
    };
  }
}

/** Exposed for tests + potential future tools. */
export const __internal = { resolveValue, resolveOneRef, walkPath };

// Re-export for convenience so callers don't need to reach into ./types.
export type { SkillReceipt, StepRecord };
// Ensure InternError stays in the module graph if future callers need it.
void InternError;
