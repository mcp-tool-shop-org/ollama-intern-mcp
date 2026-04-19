// Phase 2.5 live proof — end-to-end chain reconstruction + new-skill proposal
// against a seeded NDJSON log, wired through the real ollama_skill_propose
// handler (same code path Claude would hit via MCP).
//
// Two scenarios:
//   1. Seed 3 chains that match an existing skill (triage-then-brief) →
//      proposer MUST NOT propose it as "new" (the exclusion path).
//   2. Seed 4 chains of a NEW ad-hoc signature (research → extract → draft)
//      with consistent input shapes → proposer MUST propose it.
//
// Then also run with no seed (real log only) to see what actually emerges.

import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { handleSkillPropose } from "../dist/tools/skillPropose.js";
import { summarizeInputShape } from "../dist/observability.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

function call(tool, ts, ok, input) {
  return {
    kind: "call",
    ts,
    tool,
    envelope: { tier_used: "instant", model: "m", tokens_in: 100, tokens_out: 50, elapsed_ms: 1000, result: ok ? { digest: "..." } : { error: true } },
    input_shape: summarizeInputShape(input),
  };
}

function seedChain(signature, whenBase, inputsPerStep, ok = true) {
  const tools = signature.split("→");
  const events = [];
  for (let i = 0; i < tools.length; i++) {
    const ts = new Date(whenBase + i * 10_000).toISOString();
    events.push(call(tools[i], ts, ok, inputsPerStep[i] ?? {}));
  }
  return events;
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "phase25-"));
  const logPath = path.join(tmp, "log.ndjson");
  process.env.INTERN_LOG_PATH = logPath;

  const profile = loadProfile();
  const ctx = {
    client: new HttpOllamaClient(),
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NullLogger(),
  };

  try {
    sec("Seed 1: 3 chains matching EXISTING skill triage-then-brief (should be excluded)");
    const base = Date.parse("2026-04-18T18:00:00Z");
    const existingSigEvents = [];
    for (let i = 0; i < 3; i++) {
      existingSigEvents.push(...seedChain(
        "ollama_triage_logs→ollama_incident_brief",
        base + i * 20 * 60 * 1000, // 20-min gaps between chains → definitely separate
        [{ log_text: "x".repeat(3000) }, { log_text: "x".repeat(3000) }],
      ));
    }

    sec("Seed 2: 4 chains of NEW ad-hoc workflow: research → extract → draft");
    const newSigEvents = [];
    const baseNew = Date.parse("2026-04-18T19:00:00Z");
    for (let i = 0; i < 4; i++) {
      newSigEvents.push(...seedChain(
        "ollama_research→ollama_extract→ollama_draft",
        baseNew + i * 20 * 60 * 1000,
        [
          { question: "...", source_paths: ["a", "b"] },
          { text: "x".repeat(4000), schema: { type: "object" } },
          { target_path: "out.md", style: "doc" },
        ],
      ));
    }

    // One isolated call — should not form a chain proposal
    const noise = [call("ollama_classify", "2026-04-18T20:30:00Z", true, { text: "noise", labels: ["a", "b"] })];

    const all = [...existingSigEvents, ...newSigEvents, ...noise];
    await fs.writeFile(logPath, all.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    console.log(`wrote ${all.length} events to seeded NDJSON (${logPath})`);

    sec("Run: ollama_skill_propose against seeded log");
    const env = await handleSkillPropose({ since: "2026-04-18T17:00:00Z" }, ctx);
    const r = env.result;
    console.log("chains_considered:", r.chains_considered);
    console.log("new_skill_thresholds:", r.new_skill_thresholds);
    console.log("\nlifecycle proposals:", r.proposals.length);
    console.log("new_skill_proposals:", r.new_skill_proposals.length);
    for (const p of r.new_skill_proposals) {
      console.log(`\n  [NEW] ${p.suggested_name} (${p.suggested_id})`);
      console.log(`    pipeline: ${p.pipeline_tools.join(" → ")}`);
      console.log(`    evidence: support=${p.evidence.support}  success=${(p.evidence.success_rate*100).toFixed(0)}%  avg_dur=${p.evidence.avg_duration_ms}ms  shape_agreement=${(p.evidence.shape_agreement*100).toFixed(0)}%`);
      console.log(`    first_step_shape:`, JSON.stringify(p.evidence.examples[0] ? p.first_step_shape : p.first_step_shape, null, 0));
    }

    sec("Assertions");
    const hasExcluded = r.new_skill_proposals.some((p) =>
      p.pipeline_tools.join("→") === "ollama_triage_logs→ollama_incident_brief"
    );
    const hasNew = r.new_skill_proposals.some((p) =>
      p.pipeline_tools.join("→") === "ollama_research→ollama_extract→ollama_draft"
    );

    if (hasExcluded) { console.log("  ✗ triage-then-brief was proposed as NEW despite existing skill"); process.exitCode = 2; }
    else            { console.log("  ✔ existing-skill signature correctly excluded from new-skill proposals"); }

    if (!hasNew)    { console.log("  ✗ new research→extract→draft workflow was NOT proposed"); process.exitCode = 2; }
    else            { console.log("  ✔ new research→extract→draft workflow correctly proposed"); }

    sec("DONE");
  } finally {
    delete process.env.INTERN_LOG_PATH;
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error("FATAL:", err?.stack ?? err); process.exit(1); });
