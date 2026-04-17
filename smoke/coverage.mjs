/**
 * Coverage-contract live proof. The adoption-pass bug was:
 * summarize_deep on commandui.md + hardware-m5-max.md returned a summary
 * that only covered CommandUI, silently. The fix detects that now.
 */
import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NdjsonLogger } from "../dist/observability.js";
import { handleSummarizeDeep } from "../dist/tools/summarizeDeep.js";

const profile = loadProfile(process.env);
const ctx = {
  client: new HttpOllamaClient(),
  tiers: profile.tiers,
  timeouts: profile.timeouts,
  hardwareProfile: profile.name,
  logger: new NdjsonLogger(),
};

const memDir = "C:/Users/mikey/.claude/projects/F--AI/memory";
const env = await handleSummarizeDeep(
  {
    source_paths: [`${memDir}/commandui.md`, `${memDir}/hardware-m5-max.md`],
    focus: "ship readiness and distribution",
    max_words: 140,
  },
  ctx,
);
console.log("COVERED:", env.result.covered_sources);
console.log("OMITTED:", env.result.omitted_sources);
console.log("NOTES:", env.result.coverage_notes);
console.log("\nSUMMARY:\n", env.result.summary);
