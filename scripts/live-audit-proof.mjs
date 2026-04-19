// Phase 3D-C live proof — generate a realistic mini shadow corpus via real
// Ollama calls, then run the audit and show what it finds on actual data.
//
// Uses a temporary receipts dir so this doesn't pollute the operator's
// real artifacts/routing-receipts.

import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { shadowRun } from "../dist/routing/runtime.js";
import { runAudit } from "../dist/routing/audit/index.js";
import { handleClassify } from "../dist/tools/classify.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

async function main() {
  const receiptsDir = mkdtempSync(path.join(os.tmpdir(), "audit-proof-"));
  // Point the shadow layer at the temp dir by cwd-overriding its default
  // receipts path. The shadowRun opts.receiptsDir takes precedence.
  try {
    const profile = loadProfile();
    const ctx = {
      client: new HttpOllamaClient(),
      tiers: profile.tiers,
      timeouts: profile.timeouts,
      hardwareProfile: profile.name,
      logger: new NullLogger(),
    };

    sec("1. Generate a mini shadow corpus (4 classify calls, same log shape)");
    const logText = "ERROR: deadlock detected in ingest_queue; batch b-4412 failed after retry";
    const labels = ["incident", "noise", "feature-request"];
    for (let i = 0; i < 4; i++) {
      const start = Date.now();
      const env = await shadowRun(
        "ollama_classify",
        { text: logText, labels },
        ctx,
        () => handleClassify({ text: logText, labels }, ctx),
        { receiptsDir },
      );
      console.log(`  ${i + 1}. label=${env.result.label} confidence=${env.result.confidence} (${Date.now() - start}ms)`);
    }

    sec("2. One classify call on a DIFFERENT shape (small text, no log context)");
    const env = await shadowRun(
      "ollama_classify",
      { text: "check the box", labels: ["todo", "done"] },
      ctx,
      () => handleClassify({ text: "check the box", labels: ["todo", "done"] }, ctx),
      { receiptsDir },
    );
    console.log(`  label=${env.result.label} confidence=${env.result.confidence}`);

    sec("3. Dump receipts on disk");
    const files = (await fs.readdir(receiptsDir)).filter((f) => f.endsWith(".json")).sort();
    console.log(`  ${files.length} receipts in ${receiptsDir}`);

    sec("4. Run audit (with test receipts dir override)");
    // runAudit expects receipts at <cwd>/artifacts/routing-receipts/ by default.
    // We point it at our temp dir via the loader option.
    const report = await runAudit({ dir: receiptsDir });
    console.log("\n--- SUMMARY ---");
    console.log("receipts_considered:", report.summary.receipts_considered);
    console.log("match_breakdown:", report.summary.match_breakdown);
    console.log("route_family_distribution:", report.summary.route_family_distribution);
    console.log("top_abstain_shapes:");
    for (const s of report.summary.top_abstain_shapes) {
      console.log(`  ${s.count}×  ${s.shape_sig}`);
      console.log(`    actual_routes: ${s.actual_routes.join(", ")}`);
    }
    console.log("runtime_breakdown:", report.summary.runtime_breakdown);

    console.log("\n--- FINDINGS ---");
    if (report.findings.length === 0) {
      console.log("  (no findings — router is behaving reasonably)");
    } else {
      for (const f of report.findings) {
        console.log(`\n  [${f.severity.toUpperCase()}]  ${f.kind}`);
        console.log(`    ${f.title}`);
        console.log(`    ${f.detail}`);
        if (f.evidence.shape_sig) console.log(`    shape_sig: ${f.evidence.shape_sig}`);
        if (f.evidence.receipt_paths.length > 0) console.log(`    receipts: ${f.evidence.receipt_paths.length} linked`);
        if (f.evidence.success_rate !== undefined) console.log(`    success_rate: ${(f.evidence.success_rate * 100).toFixed(0)}%`);
        console.log(`    next_action: ${f.recommended_next_action}`);
      }
    }

    sec("ASSERTIONS");
    const checks = [
      { label: "audit reads all 5 receipts", pass: report.summary.receipts_considered === 5 },
      { label: "match_breakdown sums to receipts_considered", pass:
        report.summary.match_breakdown.exact +
        report.summary.match_breakdown.kind_match +
        report.summary.match_breakdown.mismatch +
        report.summary.match_breakdown.legit_abstain +
        report.summary.match_breakdown.missed_abstain === 5 },
      { label: "4 abstains on the recurring classify shape → at least one missed_abstain finding", pass:
        report.findings.some((f) => f.kind === "missed_abstain") },
      { label: "summary captures runtime think state (all think=false)", pass:
        report.summary.runtime_breakdown.think_off >= 4 },
      { label: "top_abstain_shapes lists the recurring shape first", pass:
        report.summary.top_abstain_shapes.length >= 1 &&
        report.summary.top_abstain_shapes[0].count >= 4 },
      { label: "every finding carries receipt_paths provenance", pass:
        report.findings.every((f) => Array.isArray(f.evidence.receipt_paths)) },
    ];
    let pass = 0, fail = 0;
    for (const c of checks) {
      console.log(`  ${c.pass ? "✔" : "✗"}  ${c.label}`);
      if (c.pass) pass++; else fail++;
    }
    console.log(`\n  ${pass} pass / ${fail} fail`);
    if (fail > 0) process.exitCode = 2;

    sec("DONE");
  } finally {
    rmSync(receiptsDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error("FATAL:", err?.stack ?? err); process.exit(1); });
