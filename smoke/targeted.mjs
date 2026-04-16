/**
 * Targeted smoke — the 5 calls that failed or showed bugs in the first pass.
 * Not re-running the whole world.
 *
 * 1. triage_logs    (Instant: was timing out at 5s on RTX 5080)
 * 2. summarize_fast (Instant: same)
 * 3. classify       (Instant: same)
 * 4. draft + pass   (Workhorse: should compile with the fixed npx invocation)
 * 5. draft + fail   (Workhorse: intentional bug — stderr_tail must report cleanly)
 */

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NdjsonLogger } from "../dist/observability.js";

import { handleTriageLogs } from "../dist/tools/triageLogs.js";
import { handleSummarizeFast } from "../dist/tools/summarizeFast.js";
import { handleClassify } from "../dist/tools/classify.js";
import { handleDraft } from "../dist/tools/draft.js";

const profile = loadProfile(process.env);
const ctx = {
  client: new HttpOllamaClient(),
  tiers: profile.tiers,
  timeouts: profile.timeouts,
  hardwareProfile: profile.name,
  logger: new NdjsonLogger(),
};

console.log(`== Profile: ${profile.name}  timeouts=${JSON.stringify(profile.timeouts)} ==`);

function banner(name) {
  console.log(`\n──── ${name} ────`);
}

function shortEnv(env) {
  const { result, ...rest } = env;
  return {
    summary: {
      tier_used: rest.tier_used,
      model: rest.model,
      hardware_profile: rest.hardware_profile,
      tokens_in: rest.tokens_in,
      tokens_out: rest.tokens_out,
      elapsed_ms: rest.elapsed_ms,
      fallback_from: rest.fallback_from,
      residency_evicted: rest.residency ? rest.residency.evicted : null,
    },
    result,
  };
}

async function run(name, promise) {
  banner(name);
  const t0 = Date.now();
  try {
    const env = await promise;
    const { summary, result } = shortEnv(env);
    console.log("ENV", JSON.stringify(summary));
    console.log("RESULT", JSON.stringify(result).slice(0, 800));
  } catch (err) {
    console.log(`ERROR (${Date.now() - t0}ms):`, err.code ?? "?", "-", err.message);
  }
}

const logSample = `
2026-04-16T12:00:00Z INFO  server listening on :8080
2026-04-16T12:00:05Z WARN  deprecated option --legacy will be removed in v2
2026-04-16T12:00:07Z ERROR db connection refused (ECONNREFUSED 127.0.0.1:5432)
2026-04-16T12:00:07Z ERROR request failed: db unavailable
2026-04-16T12:00:08Z INFO  retrying in 5s
2026-04-16T12:00:13Z ERROR db connection refused (ECONNREFUSED 127.0.0.1:5432)
`.trim();

const shortDoc = `The Chrono Trigger soundtrack, composed by Yasunori Mitsuda with contributions from Nobuo Uematsu, defined the 1995 JRPG's emotional arc through motif-based scoring. Each character received a recurring theme that warped across timelines.`;

await run("1. ollama_triage_logs", handleTriageLogs({ log_text: logSample }, ctx));
await run("2. ollama_summarize_fast", handleSummarizeFast({ text: shortDoc, max_words: 40 }, ctx));
await run(
  "3. ollama_classify",
  handleClassify(
    { text: "fix off-by-one in pagination when page size equals total count", labels: ["feat", "fix", "chore", "docs", "refactor"] },
    ctx,
  ),
);
await run(
  "4. ollama_draft (compile-pass case — TS clamp)",
  handleDraft(
    {
      prompt: "Write a TypeScript function clamp(n: number, min: number, max: number): number that clamps n into [min, max]. If min > max, swap them first. Return only the function body in plain text, no markdown fences.",
      language: "typescript",
      style: "concise",
    },
    ctx,
  ),
);
await run(
  "5. ollama_draft (compile-fail case — intentional type error)",
  handleDraft(
    {
      prompt:
        "Return this exact TypeScript verbatim, no modifications: `const n: number = \"not a number\";`. No markdown fences, no commentary.",
      language: "typescript",
      style: "concise",
    },
    ctx,
  ),
);

console.log("\n── targeted smoke complete ──");
