/**
 * Seam-fix verification smoke.
 *
 * 5 summarize_deep calls using source_paths (no text preloaded into Claude).
 * 5 embed_search calls (ranked concept search, raw vectors stripped).
 *
 * Success condition: all 10 calls succeed AND their total response size stays
 * tiny (sub-KB each). That proves both flagships finally match the product's
 * context-saving thesis.
 */

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NdjsonLogger } from "../dist/observability.js";

import { handleSummarizeDeep } from "../dist/tools/summarizeDeep.js";
import { handleEmbedSearch } from "../dist/tools/embedSearch.js";

const profile = loadProfile(process.env);
const ctx = {
  client: new HttpOllamaClient(),
  tiers: profile.tiers,
  timeouts: profile.timeouts,
  hardwareProfile: profile.name,
  logger: new NdjsonLogger(),
};

function banner(name) { console.log(`\n──── ${name} ────`); }
function slim(env) {
  return {
    tier: env.tier_used,
    model: env.model,
    ms: env.elapsed_ms,
    tokens_in: env.tokens_in,
    tokens_out: env.tokens_out,
    bytes_result: JSON.stringify(env.result).length,
  };
}

async function run(name, p) {
  banner(name);
  const t0 = Date.now();
  try {
    const env = await p;
    console.log("META", JSON.stringify(slim(env)));
    const preview = JSON.stringify(env.result).slice(0, 500);
    console.log("RESULT (first 500 chars):", preview);
  } catch (e) {
    console.log(`ERROR (${Date.now() - t0}ms):`, e.code ?? "?", "-", e.message);
  }
}

// ── SUMMARIZE_DEEP via source_paths (5 calls) ──────────────
const memDir = "C:/Users/mikey/.claude/projects/F--AI/memory";

await run(
  "sd1 — saints-mile-build-constitution.md, focus=opening arc milestones",
  handleSummarizeDeep(
    { source_paths: [`${memDir}/saints-mile-build-constitution.md`], focus: "opening arc milestones", max_words: 140 },
    ctx,
  ),
);

await run(
  "sd2 — commandui.md + hardware-m5-max.md, focus=ship readiness",
  handleSummarizeDeep(
    { source_paths: [`${memDir}/commandui.md`, `${memDir}/hardware-m5-max.md`], focus: "ship readiness and distribution", max_words: 140 },
    ctx,
  ),
);

await run(
  "sd3 — the-fractured-road-enemy-doctrine.md, focus=faction thesis",
  handleSummarizeDeep(
    { source_paths: [`${memDir}/the-fractured-road-enemy-doctrine.md`], focus: "faction combat thesis", max_words: 140 },
    ctx,
  ),
);

await run(
  "sd4 — github-actions-incident.md, focus=root causes and rules",
  handleSummarizeDeep(
    { source_paths: [`${memDir}/github-actions-incident.md`], focus: "root causes and the rules that stop them", max_words: 120 },
    ctx,
  ),
);

await run(
  "sd5 — motif-grounded-roadmap.md, focus=Phase 2 adaptive proof",
  handleSummarizeDeep(
    { source_paths: [`${memDir}/motif-grounded-roadmap.md`], focus: "Phase 2 adaptive proof", max_words: 120 },
    ctx,
  ),
);

// ── EMBED_SEARCH (5 calls) ─────────────────────────────────

const memorySnippets = [
  { id: "enemy-doctrine", text: "Faction combat doctrine — each enemy lane fights as a system with beliefs, not stat blocks with different art." },
  { id: "roll", text: "Universal RPG dice engine with full Roll20/VTT notation and exact probability." },
  { id: "m5-max", text: "M5 Max MacBook Pro with 128GB unified memory arriving 2026-04-24 unlocks large local LLMs." },
  { id: "gha-incident", text: "Org burned $130 gross in one cycle from soundboard repos — root causes: no paths filters, weekly dependabot, 3-OS matrices." },
  { id: "translation", text: "Polyglot-mcp translate-all.mjs is the correct README translation script." },
  { id: "commandui", text: "Tauri v2 + React 19 AI-native shell, shipped v1.0.0 across GitHub Releases, Scoop, winget, and Microsoft Store." },
  { id: "preferences", text: "Building deep 2D RPGs for adults raised on Final Fantasy, Chrono Trigger, Suikoden, Tactics Ogre." },
  { id: "trellis", text: "ComfyUI to TRELLIS to Blender sprite pipeline, validated end-to-end with mesh gate and 4-point lighting." },
  { id: "shipcheck", text: "Product-standards CLI that enforces 31-item hard gates (security, errors, docs, hygiene) before release." },
  { id: "ai-eyes", text: "SigLIP2 visual evaluator for sprite quality, replaced LLaVA after LLaVA hallucinated yes answers." },
];

await run(
  "es1 — 'how to avoid burning CI minutes'",
  handleEmbedSearch({ query: "how to avoid burning CI minutes", candidates: memorySnippets, top_k: 3, preview_chars: 120 }, ctx),
);

await run(
  "es2 — 'combat doctrine that treats factions as systems'",
  handleEmbedSearch({ query: "combat doctrine that treats factions as systems, not reskinned stat blocks", candidates: memorySnippets, top_k: 3, preview_chars: 120 }, ctx),
);

await run(
  "es3 — 'how do I translate READMEs?'",
  handleEmbedSearch({ query: "how do I translate a README file?", candidates: memorySnippets, top_k: 3, preview_chars: 120 }, ctx),
);

await run(
  "es4 — 'hardware that unlocks bigger local models'",
  handleEmbedSearch({ query: "hardware that unlocks running bigger local LLMs", candidates: memorySnippets, top_k: 3, preview_chars: 120 }, ctx),
);

await run(
  "es5 — 'sprite generation pipeline'",
  handleEmbedSearch({ query: "sprite generation pipeline from concept to in-engine asset", candidates: memorySnippets, top_k: 3, preview_chars: 120 }, ctx),
);

console.log("\n── seams smoke complete ──");
