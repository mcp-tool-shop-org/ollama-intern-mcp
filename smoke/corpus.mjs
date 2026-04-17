/**
 * Corpus-spine live proof.
 *
 * 1. Index a chunk of the user's memory/ directory as a "memory" corpus
 * 2. Re-index immediately — prove idempotency (0 new embeds)
 * 3. List corpora, verify "memory" is present with stats
 * 4. Search the corpus with 3 real queries that should map to known files
 */

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NdjsonLogger } from "../dist/observability.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { handleCorpusIndex } from "../dist/tools/corpusIndex.js";
import { handleCorpusSearch } from "../dist/tools/corpusSearch.js";
import { handleCorpusList } from "../dist/tools/corpusList.js";

const profile = loadProfile(process.env);
const ctx = {
  client: new HttpOllamaClient(),
  tiers: profile.tiers,
  timeouts: profile.timeouts,
  hardwareProfile: profile.name,
  logger: new NdjsonLogger(),
};

const MEM = "C:/Users/mikey/.claude/projects/F--AI/memory";

// Pick ~15 .md files from memory/ spanning different topics — not ALL of them
// (that'd take too long for a smoke). Enough to prove the plumbing and that
// real ranking works.
const SEED_FILES = [
  "user_profile.md",
  "hardware-m5-max.md",
  "the-fractured-road.md",
  "the-fractured-road-enemy-doctrine.md",
  "saints-mile-build-constitution.md",
  "motif-grounded-roadmap.md",
  "commandui.md",
  "roll-handoff.md",
  "shipcheck.md",
  "ollama-intern-mcp-handoff.md",
  "github-actions-incident.md",
  "translation-workflow.md",
  "full-treatment.md",
  "ai-loadout.md",
  "preferences.md",
];

async function run(name, promise) {
  console.log(`\n──── ${name} ────`);
  const t0 = Date.now();
  try {
    const env = await promise;
    console.log("META",
      "tier=" + env.tier_used,
      "model=" + env.model,
      "ms=" + env.elapsed_ms,
      "bytes=" + JSON.stringify(env.result).length);
    return env;
  } catch (err) {
    console.log(`ERROR (${Date.now() - t0}ms):`, err.code ?? "?", "-", err.message);
    throw err;
  }
}

// Resolve existing file paths (skip any seed that doesn't exist).
const entries = await readdir(MEM);
const memorySet = new Set(entries);
const paths = SEED_FILES.filter((f) => memorySet.has(f)).map((f) => join(MEM, f));
console.log(`Seed paths resolved: ${paths.length} of ${SEED_FILES.length}`);

// 1. Initial index
const r1 = await run("index: first build", handleCorpusIndex({ name: "memory", paths }, ctx));
console.log("FIRST INDEX:", JSON.stringify(r1.result, null, 2));

// 2. Immediate re-index — should be idempotent
const r2 = await run("index: idempotent re-run", handleCorpusIndex({ name: "memory", paths }, ctx));
console.log("SECOND INDEX reused_chunks:", r2.result.reused_chunks, "newly_embedded:", r2.result.newly_embedded_chunks);

// 3. List
const listed = await run("list", handleCorpusList({}, ctx));
console.log("CORPORA:", JSON.stringify(listed.result, null, 2));

// 4. Three real queries
const queries = [
  "how do we avoid burning GitHub Actions minutes?",
  "what is the combat doctrine thesis for Fractured Road enemies?",
  "what distribution channels does CommandUI ship on?",
];

for (const q of queries) {
  const s = await run(`search: "${q}"`, handleCorpusSearch({
    corpus: "memory", query: q, top_k: 3, preview_chars: 120,
  }, ctx));
  for (const hit of s.result.hits) {
    const file = hit.path.split(/[\\\/]/).pop();
    console.log(`  ${hit.score.toFixed(3)}  ${file}  [chunk ${hit.chunk_index}]`);
    if (hit.preview) console.log(`    preview: ${hit.preview.replace(/\s+/g, " ").slice(0, 120)}…`);
  }
}

console.log("\n── corpus smoke complete ──");
