/**
 * Live smoke — exercises all 8 handlers against the running Ollama at
 * localhost:11434 using the dev-rtx5080 profile. Prints envelopes + guardrail
 * proofs + the tail of the NDJSON log.
 *
 * Not a benchmark — a functional proof of the delegation spine.
 */

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NdjsonLogger } from "../dist/observability.js";

import { handleTriageLogs } from "../dist/tools/triageLogs.js";
import { handleSummarizeFast } from "../dist/tools/summarizeFast.js";
import { handleSummarizeDeep } from "../dist/tools/summarizeDeep.js";
import { handleResearch } from "../dist/tools/research.js";
import { handleDraft } from "../dist/tools/draft.js";
import { handleEmbed } from "../dist/tools/embed.js";
import { handleClassify } from "../dist/tools/classify.js";
import { handleExtract } from "../dist/tools/extract.js";
import { handleChat } from "../dist/tools/chat.js";

const profile = loadProfile(process.env);
const ctx = {
  client: new HttpOllamaClient(),
  tiers: profile.tiers,
  hardwareProfile: profile.name,
  logger: new NdjsonLogger(),
};

console.log(`\n== Profile: ${profile.name} ==`);
console.log(JSON.stringify(profile.tiers, null, 2));

function banner(name) {
  console.log(`\n\n────────────────────────────────────────`);
  console.log(`  ${name}`);
  console.log(`────────────────────────────────────────`);
}

function shortEnv(env) {
  const { result, ...rest } = env;
  const summary = {
    tier_used: rest.tier_used,
    model: rest.model,
    hardware_profile: rest.hardware_profile,
    tokens_in: rest.tokens_in,
    tokens_out: rest.tokens_out,
    elapsed_ms: rest.elapsed_ms,
    residency: rest.residency,
    fallback_from: rest.fallback_from,
    warnings: rest.warnings,
  };
  return { summary, result };
}

async function run(name, promise) {
  banner(name);
  const t0 = Date.now();
  try {
    const env = await promise;
    const { summary, result } = shortEnv(env);
    console.log("ENV ", JSON.stringify(summary, null, 2));
    console.log("RESULT", JSON.stringify(result, null, 2).slice(0, 1600));
    return env;
  } catch (err) {
    console.log(`ERROR (${Date.now() - t0}ms):`, err.code ?? "?", "-", err.message);
    console.log("hint:", err.hint ?? "(none)");
    return null;
  }
}

// ── 1. triage_logs ─────────────────────────────────────────
const logSample = `
2026-04-16T12:00:00Z INFO  server listening on :8080
2026-04-16T12:00:05Z WARN  deprecated option --legacy will be removed in v2
2026-04-16T12:00:07Z ERROR db connection refused (ECONNREFUSED 127.0.0.1:5432)
2026-04-16T12:00:07Z ERROR request failed: db unavailable
2026-04-16T12:00:08Z INFO  retrying in 5s
2026-04-16T12:00:13Z ERROR db connection refused (ECONNREFUSED 127.0.0.1:5432)
2026-04-16T12:00:13Z WARN  fallback cache miss
2026-04-16T12:00:14Z INFO  user session ended
`.trim();
await run("ollama_triage_logs", handleTriageLogs({ log_text: logSample }, ctx));

// ── 2. summarize_fast ──────────────────────────────────────
const shortDoc = `The Chrono Trigger soundtrack, composed primarily by Yasunori Mitsuda with contributions from Nobuo Uematsu, defined the emotional arc of the 1995 JRPG through motif-based scoring. Each character received a recurring theme that warped across timelines — Frog's heroic march played in minor keys during his backstory, and Magus's theme fragmented into dissonance at his defeat. The score's innovation was not orchestral ambition but motivic discipline: scenes inherited instrumentation from the period they depicted, so prehistoric cues leaned on percussive loops and future-dystopia cues leaned on synthesized pads.`;
await run("ollama_summarize_fast", handleSummarizeFast({ text: shortDoc, max_words: 50 }, ctx));

// ── 3. research (valid source paths) ───────────────────────
await run(
  "ollama_research",
  handleResearch(
    {
      question: "What temperature default does this server use for classification, and what for draft?",
      source_paths: ["F:/AI/ollama-intern-mcp/src/tiers.ts"],
      max_words: 120,
    },
    ctx,
  ),
);

// ── 4. draft (safe path, TypeScript + compile check) ───────
await run(
  "ollama_draft",
  handleDraft(
    {
      prompt:
        "Write a TypeScript function `clamp(n: number, min: number, max: number): number` that clamps n into [min, max]. If min > max, swap them first. Return only the function.",
      language: "typescript",
      style: "concise",
    },
    ctx,
  ),
);

// ── 5. embed ───────────────────────────────────────────────
await run(
  "ollama_embed",
  handleEmbed(
    {
      input: [
        "protected-path list prevents overwriting canon files",
        "benchmarks capture tok/s and residency snapshot per call",
        "classify returns label and confidence as JSON",
      ],
    },
    ctx,
  ),
);

// ── 6. classify (high confidence) ──────────────────────────
await run(
  "ollama_classify",
  handleClassify(
    {
      text: "fix off-by-one in pagination when page size equals total count",
      labels: ["feat", "fix", "chore", "docs", "refactor"],
    },
    ctx,
  ),
);

// ── 7. classify (forced none-of-the-above with allow_none) ─
await run(
  "ollama_classify (allow_none fallback case)",
  handleClassify(
    {
      text: "I love the color purple on Tuesdays",
      labels: ["bug-report", "feature-request", "security-issue"],
      allow_none: true,
      threshold: 0.7,
    },
    ctx,
  ),
);

// ── 8. extract ─────────────────────────────────────────────
await run(
  "ollama_extract",
  handleExtract(
    {
      text: "Contact: Jane Doe, Principal Engineer, jane.doe@example.com, 555-1234. Joined 2022-03-15.",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          joined: { type: "string", format: "date" },
        },
        required: ["name", "email"],
      },
    },
    ctx,
  ),
);

// ── 9. summarize_deep (with focus) ─────────────────────────
const longDoc = await (await import("node:fs/promises")).readFile(
  "F:/AI/ollama-intern-mcp/README.md",
  "utf8",
);
await run(
  "ollama_summarize_deep (focus: guardrails)",
  handleSummarizeDeep(
    { text: longDoc, focus: "guardrails and residency", max_words: 180 },
    ctx,
  ),
);

// ── 10. chat (last-resort — proves last_resort: true rides in result) ─
await run(
  "ollama_chat (last-resort)",
  handleChat(
    {
      messages: [{ role: "user", content: "Say 'hello from dev profile' in five words." }],
    },
    ctx,
  ),
);

// ──────────── GUARDRAIL PROOFS ────────────

// G1: research with a source_path that does not exist
await run(
  "GUARDRAIL: research with a bogus source path (should throw SOURCE_PATH_NOT_FOUND)",
  handleResearch(
    {
      question: "anything",
      source_paths: ["F:/AI/ollama-intern-mcp/does-not-exist-on-purpose.md"],
    },
    ctx,
  ),
);

// G2: draft aimed at a protected path without confirm_write (should throw PROTECTED_PATH_WRITE)
await run(
  "GUARDRAIL: draft into memory/ without confirm_write (should throw PROTECTED_PATH_WRITE)",
  handleDraft(
    {
      prompt: "one-line haiku about entropy",
      target_path: "memory/test-should-be-blocked.md",
    },
    ctx,
  ),
);

// G3: same as G2 but with confirm_write: true — should succeed
await run(
  "GUARDRAIL: draft into memory/ WITH confirm_write=true (should succeed, proving the switch works)",
  handleDraft(
    {
      prompt: "one-line haiku about entropy",
      target_path: "memory/test-confirmed.md",
      confirm_write: true,
    },
    ctx,
  ),
);

console.log("\n── smoke complete ──");
