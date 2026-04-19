// One-shot live proof of the skill layer against real Ollama.
// Not a test file. Three paths: happy, weak, override.
//
// Run: cd F:/AI/ollama-intern-mcp && node scripts/live-skill-proof.mjs
// Requires: Ollama serving on 127.0.0.1:11434 with dev-rtx5080 models.
//
// What we're trying to falsify:
//  - matcher picks the wrong skill
//  - runner shape leaks or mutates inputs incorrectly
//  - receipts miss something Phase 2's learning loop will need
//  - output looks clean but is not actually a good learning trace

import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NdjsonLogger } from "../dist/observability.js";
import { runPrewarm } from "../dist/prewarm.js";
import { loadSkills, getSkill } from "../dist/skills/store.js";
import { matchSkills } from "../dist/skills/matcher.js";
import { runSkill } from "../dist/skills/runner.js";

function section(title) {
  console.log("\n" + "=".repeat(78));
  console.log("  " + title);
  console.log("=".repeat(78));
}

function summarizeReceipt(receipt) {
  return {
    ok: receipt.ok,
    skill_id: receipt.skill_id,
    skill_version: receipt.skill_version,
    elapsed_ms: receipt.elapsed_ms,
    hardware_profile: receipt.hardware_profile,
    receipt_path: receipt.receipt_path,
    steps: receipt.steps.map((s) => ({
      step_id: s.step_id,
      tool: s.tool,
      ok: s.ok,
      elapsed_ms: s.elapsed_ms,
      skipped: s.skipped ?? false,
      has_envelope: s.envelope !== undefined,
      tier_used: s.envelope?.tier_used,
      model: s.envelope?.model,
      tokens_in: s.envelope?.tokens_in,
      tokens_out: s.envelope?.tokens_out,
      warnings: s.envelope?.warnings ?? [],
      error: s.error ?? null,
    })),
  };
}

const INCIDENT_LOG = `
[2026-04-18T09:14:22Z] INFO  starting ingest pipeline (batch_id=b-4412)
[2026-04-18T09:14:23Z] INFO  opened connection pool (size=8) host=db-primary-01
[2026-04-18T09:14:41Z] WARN  slow query detected (2.4s) on ingest_queue table
[2026-04-18T09:14:55Z] WARN  slow query detected (3.1s) on ingest_queue table
[2026-04-18T09:15:12Z] ERROR pq: canceling statement due to statement timeout
        at processInsert (/app/src/ingest/writer.ts:214:19)
        at async runBatch (/app/src/ingest/writer.ts:88:7)
[2026-04-18T09:15:12Z] ERROR batch b-4412 failed after 50.1s — 0 of 412 rows committed
[2026-04-18T09:15:13Z] WARN  retrying batch b-4412 (attempt 2/3)
[2026-04-18T09:15:33Z] ERROR pq: deadlock detected
        DETAIL: Process 31872 waits for ShareLock on transaction 891233;
        blocked by process 31855 on db-primary-01
[2026-04-18T09:15:33Z] ERROR batch b-4412 failed after retry — giving up
[2026-04-18T09:15:34Z] WARN  ingest pipeline backpressure: 1812 rows queued
[2026-04-18T09:15:40Z] FATAL  ingest worker exit(1): unrecoverable deadlock on db-primary-01
`.trim();

async function writeSkill(dir, id, body) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, id + ".json"), JSON.stringify({ id, ...body }, null, 2), "utf8");
}

async function main() {
  const profile = loadProfile();
  const ctx = {
    client: new HttpOllamaClient(),
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NdjsonLogger(),
  };
  console.log(`profile: ${profile.name}  tiers: ${JSON.stringify(profile.tiers)}`);

  if (profile.prewarm.length > 0) {
    console.log(`prewarming tiers: ${profile.prewarm.join(", ")} (this is what main() does)`);
    const t0 = Date.now();
    await runPrewarm(ctx, profile.prewarm);
    console.log(`prewarm done in ${Date.now() - t0}ms`);
  }

  // ── PATH 1 — Happy path ────────────────────────────────────────────────
  section("PATH 1 — Happy: real noisy log, real source paths");
  const loaded = await getSkill("triage-then-brief");
  if (!loaded) throw new Error("skill triage-then-brief not found");
  console.log("skill source:", loaded.source_path, "  scope:", loaded.scope);

  // Matcher sanity: does it pick our skill for a matching task description?
  const { skills: allSkills } = await loadSkills();
  const matches = matchSkills(
    allSkills,
    "help me triage CI logs for errors and write an incident brief",
    5,
  );
  console.log("matcher top 3:", matches.slice(0, 3).map((m) => ({ id: m.id, score: +m.score.toFixed(3), scope: m.scope, status: m.status, reasons: m.reasons })));
  if (matches[0]?.id !== "triage-then-brief") {
    console.log("  ⚠ matcher did NOT rank triage-then-brief first");
  }

  const happyInputs = {
    log_text: INCIDENT_LOG,
  };
  console.log("running skill on real log...");
  const happy = await runSkill(loaded, ctx, { inputs: happyInputs });
  console.log("receipt summary:", JSON.stringify(summarizeReceipt(happy.receipt), null, 2));
  console.log("--- result (brief) trimmed ---");
  const brief = happy.result ?? {};
  console.log(JSON.stringify({
    root_cause_hypotheses: brief.root_cause_hypotheses,
    affected_surfaces: brief.affected_surfaces,
    next_checks: brief.next_checks,
    weak: brief.weak,
    coverage_notes: brief.coverage_notes,
  }, null, 2).slice(0, 3000));

  // ── PATH 2 — Weak path ─────────────────────────────────────────────────
  section("PATH 2 — Weak: thin evidence must degrade honestly, not fabricate");
  const weakInputs = {
    log_text: "WARN  something might be off somewhere",
  };
  const weak = await runSkill(loaded, ctx, { inputs: weakInputs });
  console.log("receipt summary:", JSON.stringify(summarizeReceipt(weak.receipt), null, 2));
  console.log("--- weak result ---");
  const weakBrief = weak.result ?? {};
  console.log(JSON.stringify({
    weak: weakBrief.weak,
    coverage_notes: weakBrief.coverage_notes,
    root_cause_hypotheses: weakBrief.root_cause_hypotheses,
    hypothesis_count: Array.isArray(weakBrief.root_cause_hypotheses) ? weakBrief.root_cause_hypotheses.length : "n/a",
  }, null, 2));

  // ── PATH 3 — Override path ─────────────────────────────────────────────
  section("PATH 3 — Override: project skill with the same id wins over global");
  const tmpGlobal = mkdtempSync(path.join(os.tmpdir(), "skills-global-"));
  const tmpProject = mkdtempSync(path.join(os.tmpdir(), "skills-project-"));
  try {
    const shared = {
      name: "OVERRIDE-UNDER-TEST",
      description: "collision test skill",
      version: 1,
      status: "approved",
      trigger: { keywords: ["override", "collision"], input_shape: {} },
      pipeline: [{ id: "c", tool: "ollama_classify", inputs: { text: "hello world", labels: ["greeting", "other"] } }],
      result_from: "c",
      provenance: { created_at: "2026-04-18T00:00:00Z", source: "hand_authored", runs: 0 },
    };
    await writeSkill(tmpGlobal, "collider", { ...shared, name: "GLOBAL version" });
    await writeSkill(tmpProject, "collider", { ...shared, name: "PROJECT version" });
    const merged = await loadSkills({ globalDir: tmpGlobal, projectDir: tmpProject });
    const picked = merged.skills.find((s) => s.skill.id === "collider");
    console.log("loadSkills picked:", { name: picked?.skill.name, scope: picked?.scope, source_path: picked?.source_path });
    if (picked?.skill.name !== "PROJECT version" || picked?.scope !== "project") {
      console.log("  ⚠ override did NOT pick project");
      process.exitCode = 2;
    } else {
      console.log("  ✔ override works as designed");
    }
    // Run it end-to-end with Ollama so the override is proven through the runner, not just the store.
    const runOut = await runSkill(picked, ctx, { inputs: {} });
    console.log("override-skill run:", {
      ok: runOut.receipt.ok,
      step0_tool: runOut.receipt.steps[0]?.tool,
      step0_ok: runOut.receipt.steps[0]?.ok,
      step0_result: runOut.receipt.steps[0]?.envelope?.result,
      receipt_path: runOut.receipt.receipt_path,
    });
  } finally {
    rmSync(tmpGlobal, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  }

  section("DONE");
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
