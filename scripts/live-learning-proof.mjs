// End-to-end proof of the Phase 2 learning loop against REAL receipts on disk.
// Uses the receipts left in artifacts/skill-receipts/ from live-skill-proof.mjs.
// No new Ollama calls — just exercises the read path + promote.
//
// Run: node scripts/live-learning-proof.mjs

import { promises as fs } from "node:fs";
import path from "node:path";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { handleSkillPropose } from "../dist/tools/skillPropose.js";
import { handleSkillPromote } from "../dist/tools/skillPromote.js";

function section(t) {
  console.log("\n" + "=".repeat(78));
  console.log("  " + t);
  console.log("=".repeat(78));
}

async function main() {
  const profile = loadProfile();
  const ctx = {
    client: new HttpOllamaClient(),
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NullLogger(),
  };

  section("1. Aggregate stats + proposals over REAL receipts");
  const proposeEnv = await handleSkillPropose({}, ctx);
  console.log("receipts_considered:", proposeEnv.result.receipts_considered);
  console.log("thresholds:", proposeEnv.result.thresholds);
  console.log("\nStats per skill:");
  for (const s of proposeEnv.result.stats) {
    console.log(`  ${s.skill_id}  runs=${s.run_count}  ok=${s.success_count}  fail=${s.failure_count}  rate=${(s.success_rate*100).toFixed(0)}%  median=${s.median_elapsed_ms}ms  tok_in=${s.total_tokens_in}  tok_out=${s.total_tokens_out}  hw=${s.hardware_profiles.join(",")}`);
    for (const fp of s.failure_profile) {
      console.log(`    failure: step="${fp.step_id}" tool=${fp.tool} count=${fp.failure_count} codes=${JSON.stringify(fp.error_codes)}`);
    }
  }
  console.log("\nProposals (" + proposeEnv.result.proposals.length + "):");
  for (const p of proposeEnv.result.proposals) {
    console.log(`  [${p.kind}] ${p.skill_id} (${p.current_status}${p.suggested_status ? ' → ' + p.suggested_status : ''})`);
    console.log("    reason:", p.reason);
    if (p.evidence.dominant_failure) {
      console.log("    dominant_failure:", p.evidence.dominant_failure);
    }
  }

  section("2. Promote triage-then-brief with a reason (lifecycle write)");
  // Skill is already "approved" so to demo the promoter, demote to candidate first, then repromote.
  const skillPath = path.resolve("skills/triage-then-brief.json");
  const beforeRaw = JSON.parse(await fs.readFile(skillPath, "utf8"));
  console.log("before: status=", beforeRaw.status, " promotion_history_length=", beforeRaw.provenance?.promotion_history?.length ?? 0);

  // Flip approved -> candidate
  const p1 = await handleSkillPromote(
    { skill_id: "triage-then-brief", target: "candidate", reason: "Phase 2 lifecycle proof — testing demotion." },
    ctx,
  );
  console.log("step 1:", p1.result);

  // Flip candidate -> approved
  const p2 = await handleSkillPromote(
    { skill_id: "triage-then-brief", target: "approved", reason: "Phase 2 lifecycle proof — 2/4 runs green after bugfix (cold-load timeout + fragile source_paths) were correctly attributed, not skill bugs." },
    ctx,
  );
  console.log("step 2:", p2.result);

  const afterRaw = JSON.parse(await fs.readFile(skillPath, "utf8"));
  console.log("\nafter: status=", afterRaw.status);
  console.log("promotion_history:");
  for (const h of afterRaw.provenance.promotion_history) {
    console.log(`  ${h.from} → ${h.to}  at=${h.at}`);
    console.log(`    reason: ${h.reason}`);
  }

  section("3. Verify invalid transition is refused");
  try {
    await handleSkillPromote(
      { skill_id: "triage-then-brief", target: "approved", reason: "noop" },
      ctx,
    );
    console.log("  ⚠ expected refusal, got success");
    process.exitCode = 2;
  } catch (err) {
    console.log("  ✔ refused as expected:", err?.message?.split("\n")[0]);
  }

  section("DONE");
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
