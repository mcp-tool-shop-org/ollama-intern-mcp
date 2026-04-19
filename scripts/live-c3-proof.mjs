// Phase 3C live proof — memory_read, memory_explain, memory_neighbors
// against the real on-disk memory index. No Ollama calls (deterministic!).
//
// What we're falsifying:
//   - memory_read reads source blobs (it shouldn't)
//   - memory_explain calls Ollama (it shouldn't)
//   - memory_neighbors calls Ollama (it shouldn't)
//   - results aren't typed per kind

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { handleMemoryRead } from "../dist/tools/memoryRead.js";
import { handleMemoryExplain } from "../dist/tools/memoryExplain.js";
import { handleMemoryNeighbors } from "../dist/tools/memoryNeighbors.js";
import { loadIndex } from "../dist/memory/store.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

// Instrumented client — counts any Ollama call so we can prove determinism.
class CountingClient {
  constructor() { this.http = new HttpOllamaClient(); this.embedCalls = 0; this.generateCalls = 0; this.chatCalls = 0; }
  async embed(req, signal) { this.embedCalls++; return this.http.embed(req, signal); }
  async generate(req, signal) { this.generateCalls++; return this.http.generate(req, signal); }
  async chat(req, signal) { this.chatCalls++; return this.http.chat(req, signal); }
  async residency(m) { return this.http.residency(m); }
}

async function main() {
  const profile = loadProfile();
  const client = new CountingClient();
  const ctx = {
    client,
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NullLogger(),
  };

  // Pick real record ids from the live index.
  const idx = await loadIndex();
  if (idx.records.length === 0) { console.log("Memory index empty — run memory_refresh first."); process.exit(1); }
  const approvedSkill = idx.records.find((r) => r.kind === "approved_skill");
  const skillReceipt = idx.records.find((r) => r.kind === "skill_receipt");
  console.log(`index has ${idx.records.length} records. Anchor ids:`);
  console.log(`  approved_skill = ${approvedSkill?.id}`);
  console.log(`  skill_receipt  = ${skillReceipt?.id}`);

  sec("1. memory_read — approved_skill typed resolution");
  const read1 = await handleMemoryRead({ memory_id: approvedSkill.id }, ctx);
  console.log("record.kind:", read1.result.record.kind);
  console.log("provenance_resolved:", read1.result.provenance_resolved);
  console.log("age:", read1.result.age);
  console.log("duplicates:", read1.result.duplicates.length);
  console.log("notes:", read1.result.notes);
  console.log("embed calls after step 1:", client.embedCalls, "generate:", client.generateCalls);

  sec("2. memory_read — skill_receipt typed resolution (shape differs from skill)");
  const read2 = await handleMemoryRead({ memory_id: skillReceipt.id }, ctx);
  console.log("provenance_resolved:", read2.result.provenance_resolved);
  console.log("notes:", read2.result.notes);

  sec("3. memory_explain — deterministic field match for a realistic query");
  const explainR = await handleMemoryExplain({
    memory_id: approvedSkill.id,
    query: "triage logs and build an incident brief",
    filters: { kinds: ["approved_skill"] },
  }, ctx);
  console.log("query_tokens:", explainR.result.query_tokens);
  console.log("field_matches:", explainR.result.field_matches);
  console.log("total_matched_tokens:", explainR.result.total_matched_tokens);
  console.log("passed_prefilter:", explainR.result.filter_effects.passed_prefilter);
  console.log("predicates:");
  for (const p of explainR.result.filter_effects.predicate_results) {
    console.log(`  - ${p.predicate}  ${p.passed ? "PASS" : "FAIL"}  ${p.detail ?? ""}`);
  }
  console.log("notes:", explainR.result.notes);
  console.log("embed calls after step 3:", client.embedCalls, "generate:", client.generateCalls);

  sec("4. memory_explain — failing-filter case (kind mismatch) is reported honestly");
  const explainFail = await handleMemoryExplain({
    memory_id: approvedSkill.id,
    query: "unrelated",
    filters: { kinds: ["skill_receipt"] },
  }, ctx);
  console.log("passed_prefilter:", explainFail.result.filter_effects.passed_prefilter);
  console.log("predicate FAIL detail:", explainFail.result.filter_effects.predicate_results[0]);
  console.log("notes:", explainFail.result.notes);

  sec("5. memory_neighbors — nearest for the approved_skill anchor");
  const neigh1 = await handleMemoryNeighbors({ memory_id: approvedSkill.id, top_k: 5 }, ctx);
  console.log("considered:", neigh1.result.considered);
  for (const n of neigh1.result.neighbors) {
    console.log(`  ${n.score.toFixed(3)} [${n.band}] [${n.kind}] ${n.title}`);
  }
  console.log("grouped counts:", Object.fromEntries(Object.entries(neigh1.result.neighbors_by_kind).map(([k, v]) => [k, v.length])));

  sec("6. memory_neighbors — kind-filtered (skill_receipt only)");
  const neigh2 = await handleMemoryNeighbors({ memory_id: approvedSkill.id, kinds: ["skill_receipt"], top_k: 3 }, ctx);
  console.log("considered:", neigh2.result.considered);
  for (const n of neigh2.result.neighbors) console.log(`  ${n.score.toFixed(3)} [${n.kind}] ${n.title}`);
  const typedOk = neigh2.result.neighbors.every((n) => n.kind === "skill_receipt");
  console.log(typedOk ? "  ✔ kind filter held" : "  ✗ kind filter leaked");
  if (!typedOk) process.exitCode = 2;

  sec("DETERMINISM AUDIT — DEFAULTS must be zero model calls");
  const preOptIn = { embed: client.embedCalls, generate: client.generateCalls, chat: client.chatCalls };
  console.log(`defaults: embed=${preOptIn.embed}  generate=${preOptIn.generate}  chat=${preOptIn.chat}`);
  const deterministic = preOptIn.embed === 0 && preOptIn.generate === 0 && preOptIn.chat === 0;
  console.log(deterministic ? "  ✔ defaults are fully deterministic" : "  ✗ model call detected in default path");
  if (!deterministic) process.exitCode = 2;

  sec("7. memory_read — OPT-IN include_excerpt=true (file read, NO model)");
  const readExcerpt = await handleMemoryRead({ memory_id: approvedSkill.id, include_excerpt: true }, ctx);
  console.log("source_excerpt.kind:", readExcerpt.result.source_excerpt?.kind);
  if (readExcerpt.result.source_excerpt?.kind === "approved_skill") {
    console.log("  pipeline:", readExcerpt.result.source_excerpt.pipeline);
    console.log("  trigger_keywords:", readExcerpt.result.source_excerpt.trigger_keywords);
    console.log("  runs:", readExcerpt.result.source_excerpt.runs);
    console.log("  promotion_history entries:", readExcerpt.result.source_excerpt.promotion_history.length);
  }
  const readReceiptExcerpt = await handleMemoryRead({ memory_id: skillReceipt.id, include_excerpt: true }, ctx);
  if (readReceiptExcerpt.result.source_excerpt?.kind === "skill_receipt") {
    console.log("\n  receipt step_count:", readReceiptExcerpt.result.source_excerpt.step_count);
    console.log("  steps:");
    for (const s of readReceiptExcerpt.result.source_excerpt.steps) {
      console.log(`    ${s.step_id} ${s.tool}  ok=${s.ok}  ${s.elapsed_ms}ms${s.tier_used ? "  " + s.tier_used : ""}${s.error_code ? "  " + s.error_code : ""}`);
    }
  }
  console.log("\n  model calls from excerpt path:", { embed: client.embedCalls - preOptIn.embed, generate: client.generateCalls - preOptIn.generate });

  sec("8. memory_explain — OPT-IN narrate=true (Instant-tier one-liner)");
  const preNarrate = client.generateCalls;
  const narrated = await handleMemoryExplain({
    memory_id: approvedSkill.id,
    query: "triage logs and build an incident brief",
    filters: { kinds: ["approved_skill"] },
    narrate: true,
  }, ctx);
  console.log("narration:", narrated.result.narration);
  console.log("generate call count increase:", client.generateCalls - preNarrate, "(expected 1)");

  sec("FINAL AUDIT");
  console.log(`total embed=${client.embedCalls}  generate=${client.generateCalls}  chat=${client.chatCalls}`);
  console.log(`  default paths: 0 / 0 / 0`);
  console.log(`  opt-in paths:  ${client.embedCalls} / ${client.generateCalls} / ${client.chatCalls}`);

  sec("DONE");
}

main().catch((err) => { console.error("FATAL:", err?.stack ?? err); process.exit(1); });
