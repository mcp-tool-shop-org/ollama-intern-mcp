// Phase 3D-D live proof — drive the full calibration lifecycle end-to-end.
//
//   1. Generate shadow receipts (4× classify on same shape → missed_abstain)
//   2. audit → finding
//   3. propose → calibration proposal
//   4. replay → show before/after delta
//   5. approve → proposal lands into active overlay
//   6. new shadow run stamps calibration_version on its receipt
//   7. rollback → version goes back to "0"
//
// Uses isolated tmp dirs for receipts AND calibrations so this doesn't
// pollute the operator's real state.

import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { shadowRun } from "../dist/routing/runtime.js";
import { handleClassify } from "../dist/tools/classify.js";
import { runAudit } from "../dist/routing/audit/index.js";
import { proposeCalibrations } from "../dist/routing/calibration/proposals.js";
import { addProposals, transition, activeOverlay, loadStore } from "../dist/routing/calibration/store.js";
import { overlayFromProposals } from "../dist/routing/calibration/overlay.js";
import { replayOverlay } from "../dist/routing/calibration/replay.js";
import { loadRoutingReceipts } from "../dist/routing/audit/loader.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

async function main() {
  const receiptsDir = mkdtempSync(path.join(os.tmpdir(), "cal-receipts-"));
  const calDir = mkdtempSync(path.join(os.tmpdir(), "cal-store-"));
  const prev = process.env.INTERN_CALIBRATIONS_DIR;
  process.env.INTERN_CALIBRATIONS_DIR = calDir;

  try {
    const profile = loadProfile();
    const ctx = {
      client: new HttpOllamaClient(),
      tiers: profile.tiers,
      timeouts: profile.timeouts,
      hardwareProfile: profile.name,
      logger: new NullLogger(),
    };

    sec("1. Generate 4 shadow receipts on same shape (seed for missed_abstain)");
    const labels = ["incident", "noise", "feature-request"];
    for (let i = 0; i < 4; i++) {
      await shadowRun(
        "ollama_classify",
        { text: `ERROR: case ${i} deadlock in ingest_queue`, labels },
        ctx,
        () => handleClassify({ text: `ERROR: case ${i} deadlock in ingest_queue`, labels }, ctx),
        { receiptsDir },
      );
    }
    console.log(`wrote ${(await fs.readdir(receiptsDir)).length} receipts`);

    sec("2. Audit → expect one missed_abstain finding");
    const report = await runAudit({ dir: receiptsDir });
    const missed = report.findings.find((f) => f.kind === "missed_abstain");
    if (!missed) { console.log("  ✗ no missed_abstain finding — live proof cannot proceed"); process.exitCode = 2; return; }
    console.log("finding:", { kind: missed.kind, severity: missed.severity, shape: missed.evidence.shape_sig });

    sec("3. Propose → structured calibration proposal");
    const proposals = proposeCalibrations(report.findings);
    console.log("generated", proposals.length, "proposal(s)");
    const p = proposals[0];
    console.log("proposal:", {
      id: p.id,
      kind: p.kind,
      target: p.target,
      change: p.change,
      source_finding: p.source_finding,
      rationale: p.rationale,
    });

    // Persist the proposal in the isolated calibration store
    await addProposals(proposals, { dir: calDir });

    sec("4. Replay → show before/after delta over stored receipts");
    // Use the proposal AS IF approved to preview its effect
    const previewOverlay = overlayFromProposals(
      proposals.map((x) => ({ ...x, status: "approved" })),
      ["approved"],
    );
    console.log("overlay version:", previewOverlay.version);
    console.log("overlay shape_signals:", previewOverlay.shape_signals.length, "weight overrides:", Object.keys(previewOverlay.weights).length);
    const receipts = await loadRoutingReceipts({ dir: receiptsDir });
    const delta = replayOverlay(receipts, previewOverlay);
    console.log("replay delta:");
    console.log("  receipts_considered:", delta.receipts_considered);
    console.log("  unchanged:", delta.unchanged);
    console.log("  promoted_from_abstain:", delta.promoted_from_abstain);
    console.log("  flipped_to_match:", delta.flipped_to_match);
    console.log("  flipped_away_from_match:", delta.flipped_away_from_match);
    console.log("  band_change:", delta.band_change);
    console.log("  rank_shift:", delta.rank_shift);
    // Since the target is atom:ollama_classify (not a pack/skill candidate),
    // replay correctly reports 0 effect — this tells the operator the right
    // answer is "author a skill", not "tune weights."

    sec("5. Approve → proposal lands into active overlay");
    const before = await activeOverlay({ dir: calDir });
    console.log("active version BEFORE approve:", before.version);
    await transition(p.id, "approved", { dir: calDir, reason: "live-proof: landing for observability; will rollback immediately" });
    const afterApprove = await activeOverlay({ dir: calDir });
    console.log("active version AFTER approve:", afterApprove.version);
    const store = await loadStore({ dir: calDir });
    console.log("stored active_version:", store.active_version);
    console.log("proposal history entries:", store.proposals[0].history.length);

    sec("6. New shadow run → receipt carries calibration_version stamp");
    // shadowRun reads calibration from default INTERN_CALIBRATIONS_DIR env
    await shadowRun(
      "ollama_classify",
      { text: "ERROR: post-approval sample", labels },
      ctx,
      () => handleClassify({ text: "ERROR: post-approval sample", labels }, ctx),
      { receiptsDir },
    );
    const files = (await fs.readdir(receiptsDir)).filter((f) => f.endsWith(".json")).sort();
    const latest = JSON.parse(await fs.readFile(path.join(receiptsDir, files[files.length - 1]), "utf8"));
    console.log("new receipt calibration_version:", latest.runtime.calibration_version);
    const approvalStamped = latest.runtime.calibration_version === afterApprove.version
      && latest.runtime.calibration_version !== "0";
    console.log(approvalStamped ? "  ✔ receipt stamped with active calibration version" : "  ✗ receipt calibration stamp wrong");
    if (!approvalStamped) process.exitCode = 2;

    sec("7. Rollback → active version returns to 0");
    await transition(p.id, "superseded", { dir: calDir, reason: "live-proof rollback" });
    const afterRollback = await activeOverlay({ dir: calDir });
    console.log("active version AFTER rollback:", afterRollback.version);
    if (afterRollback.version !== "0") { console.log("  ✗ rollback failed to clear active overlay"); process.exitCode = 2; }
    else console.log("  ✔ rollback cleared active overlay");

    sec("ASSERTIONS");
    const checks = [
      { label: "audit produced the missed_abstain finding", pass: !!missed },
      { label: "propose generated a structured proposal", pass: proposals.length >= 1 && !!p.id && !!p.rationale },
      { label: "proposal has grounded rationale + evidence", pass: p.rationale.length > 50 && Array.isArray(p.source_receipt_paths) },
      { label: "approve lifted active overlay version above 0", pass: afterApprove.version !== "0" },
      { label: "new receipt carries matching calibration_version stamp", pass: approvalStamped },
      { label: "proposal history records both proposed + approved transitions", pass: store.proposals[0].history.length >= 2 },
      { label: "rollback cleared active overlay back to 0", pass: afterRollback.version === "0" },
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
    rmSync(calDir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.INTERN_CALIBRATIONS_DIR;
    else process.env.INTERN_CALIBRATIONS_DIR = prev;
  }
}

main().catch((err) => { console.error("FATAL:", err?.stack ?? err); process.exit(1); });
