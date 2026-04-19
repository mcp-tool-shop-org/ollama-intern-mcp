// Phase 3D Commit B — live proof of the shadow runtime against real Ollama.
//
// Run real atom/pack handlers through shadowRun() and inspect:
//   - a routing receipt lands on disk per call
//   - the pre-execution context + decision is captured
//   - actual identity is canonical
//   - match classification is correct
//   - outcome carries tier/model/tokens + pack artifact linkage
//   - runtime block captures hardware_profile + think
//   - skip-list tools bypass (no receipt)

import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { shadowRun } from "../dist/routing/runtime.js";
import { handleClassify } from "../dist/tools/classify.js";
import { handleMemorySearch } from "../dist/tools/memorySearch.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

async function readLatestReceipt(dir) {
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort();
  const raw = await fs.readFile(path.join(dir, files[files.length - 1]), "utf8");
  return JSON.parse(raw);
}

async function main() {
  const receiptsDir = mkdtempSync(path.join(os.tmpdir(), "shadow-proof-"));
  try {
    const profile = loadProfile();
    const ctx = {
      client: new HttpOllamaClient(),
      tiers: profile.tiers,
      timeouts: profile.timeouts,
      hardwareProfile: profile.name,
      logger: new NullLogger(),
    };
    console.log("receipts dir:", receiptsDir);

    // ── 1. Shadowed atom call with real Ollama ───────────────
    sec("1. Shadowed classify against qwen3:8b — real Ollama");
    const t1 = Date.now();
    const env = await shadowRun(
      "ollama_classify",
      { text: "ERROR: deadlock detected in ingest_queue; batch b-4412 failed after retry", labels: ["incident", "noise", "feature-request"] },
      ctx,
      () => handleClassify({ text: "ERROR: deadlock detected in ingest_queue; batch b-4412 failed after retry", labels: ["incident", "noise", "feature-request"] }, ctx),
      { receiptsDir },
    );
    console.log("elapsed:", Date.now() - t1, "ms");
    console.log("envelope result:", env.result);

    const r = await readLatestReceipt(receiptsDir);
    if (!r) { console.log("  ✗ no receipt written"); process.exitCode = 2; return; }
    console.log("\nreceipt:");
    console.log("  recorded_at:", r.recorded_at);
    console.log("  actual:", r.actual);
    console.log("  match:", r.match);
    console.log("  decision.suggested:", r.decision.suggested);
    console.log("  decision.abstain_reason:", r.decision.abstain_reason);
    console.log("  top 3 candidates:");
    for (const c of r.decision.candidates.slice(0, 3)) {
      console.log(`    ${c.score.toFixed(2)} [${c.band}] ${c.target.kind}:${c.target.ref}`);
    }
    console.log("  outcome:", {
      ok: r.outcome.ok,
      elapsed_ms: r.outcome.elapsed_ms,
      tier_used: r.outcome.tier_used,
      model: r.outcome.model,
      tokens_in: r.outcome.tokens_in,
      tokens_out: r.outcome.tokens_out,
    });
    console.log("  runtime:", r.runtime);

    // ── 2. Skip-list tool bypasses ──────────────────────────
    sec("2. Skip-list: shadowed memory_search should NOT write a receipt");
    const before = (await fs.readdir(receiptsDir)).length;
    await shadowRun(
      "ollama_memory_search",
      { query: "triage logs" },
      ctx,
      () => handleMemorySearch({ query: "triage logs", limit: 1 }, ctx),
      { receiptsDir },
    );
    const after = (await fs.readdir(receiptsDir)).length;
    console.log(`receipts before/after: ${before}/${after}`);
    if (after !== before) { console.log("  ✗ skip-list tool wrote a receipt"); process.exitCode = 2; }
    else console.log("  ✔ skip-list tool bypassed shadow layer");

    sec("ASSERTIONS");
    const checks = [
      { label: "receipt recorded", pass: r !== null },
      { label: "actual.route_identity is canonical atom:X", pass: r.actual.route_identity === "atom:ollama_classify" },
      { label: "pre-execution decision present", pass: !!r.decision && Array.isArray(r.decision.candidates) },
      { label: "runtime.hardware_profile captured", pass: r.runtime.hardware_profile === "dev-rtx5080" },
      { label: "runtime.think captured (false for classify)", pass: r.runtime.think === false },
      { label: "outcome.ok true on successful run", pass: r.outcome.ok === true },
      { label: "outcome.model matches envelope", pass: r.outcome.model === env.model },
      { label: "outcome.tokens_in/out captured", pass: typeof r.outcome.tokens_in === "number" && typeof r.outcome.tokens_out === "number" },
      { label: "match classification present", pass: typeof r.match === "object" && typeof r.match.kind === "string" },
      { label: "skip-list tool did not write a receipt", pass: before === after },
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
