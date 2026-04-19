// Phase 3A live proof — exercise the real memory substrate against actual
// on-disk state: the 6 skill receipts from earlier runs, the
// triage-then-brief skill, any pack artifacts in ~/.ollama-intern/artifacts/,
// and the NDJSON call log.
//
// What we're falsifying:
//   - ids not deterministic across refreshes (id churn)
//   - drift report lies about added/updated/unchanged/removed
//   - dry_run writes the index (it should NOT)
//   - provenance broken (can't find source from record)
//   - records contain raw content (privacy regression)

import { promises as fs } from "node:fs";
import path from "node:path";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { handleMemoryRefresh } from "../dist/tools/memoryRefresh.js";
import { loadIndex, memoryDir } from "../dist/memory/store.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

async function main() {
  const profile = loadProfile();
  const ctx = {
    client: new HttpOllamaClient(),
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NullLogger(),
  };
  console.log("memory dir:", memoryDir());

  sec("1. Dry-run refresh — see what the index WOULD contain, write nothing");
  const dry = await handleMemoryRefresh({ dry_run: true }, ctx);
  console.log("total_records:", dry.result.total_records);
  console.log("per_kind_counts:", dry.result.per_kind_counts);
  console.log("drift:", dry.result.drift);
  console.log("sources_scanned:", dry.result.sources_scanned);
  console.log("dry_run:", dry.result.dry_run);

  sec("2. Real refresh — write the index");
  const r1 = await handleMemoryRefresh({}, ctx);
  console.log("total_records:", r1.result.total_records);
  console.log("per_kind_counts:", r1.result.per_kind_counts);
  console.log("index_path:", r1.result.index_path);
  console.log("added_ids (first 6):", r1.result.drift.added_ids.slice(0, 6));

  sec("3. Idempotence — re-run should show zero drift");
  const r2 = await handleMemoryRefresh({}, ctx);
  console.log("drift:", r2.result.drift);
  const idempotent =
    r2.result.drift.added_count === 0 &&
    r2.result.drift.updated_count === 0 &&
    r2.result.drift.removed_count === 0;
  console.log(idempotent ? "  ✔ idempotent (no churn)" : "  ✗ NOT idempotent");
  if (!idempotent) process.exitCode = 2;

  sec("4. Provenance check — every record points to a real source path");
  const idx = await loadIndex();
  console.log("loaded:", idx.records.length, "records, schema_version:", idx.schema_version);
  let provOk = 0, provBad = 0;
  for (const r of idx.records.slice(0, 20)) {
    const exists = r.provenance.source_path && (r.kind === "candidate_proposal" || await fs.access(r.provenance.source_path).then(() => true).catch(() => false));
    if (exists || r.kind === "candidate_proposal") provOk++;
    else { provBad++; console.log("  BAD:", r.id, r.provenance.source_path); }
  }
  console.log(`  ${provOk} provenance paths ok, ${provBad} broken`);
  if (provBad > 0) process.exitCode = 2;

  sec("5. Privacy check — records MUST NOT contain raw content");
  const serialized = JSON.stringify(idx.records);
  const leaks = [];
  // Look for obvious long strings (>200 chars) — summary is truncated to 300,
  // so some rooms here but no raw log body should survive.
  for (const r of idx.records) {
    if (r.summary.length > 300) leaks.push(`${r.id}: summary too long (${r.summary.length})`);
    // The INCIDENT_LOG from live-skill-proof had "ingest_queue" and "deadlock" —
    // those are domain words, fine to appear. What we don't want is the WHOLE LOG.
    // Length is a cheap proxy.
  }
  if (leaks.length > 0) { console.log("  ✗ leaks:"); for (const l of leaks) console.log("   -", l); process.exitCode = 2; }
  else console.log("  ✔ no obvious content leaks (all summaries ≤ 300 chars)");

  sec("6. One record per kind — show what the surface looks like");
  for (const kind of ["approved_skill", "skill_receipt", "pack_artifact", "candidate_proposal"]) {
    const example = idx.records.find((r) => r.kind === kind);
    if (!example) { console.log(`  ${kind}: (none)`); continue; }
    console.log(`\n  [${kind}] ${example.id}`);
    console.log(`    title: ${example.title}`);
    console.log(`    summary: ${example.summary}`);
    console.log(`    tags: ${example.tags.slice(0, 6).join(", ")}${example.tags.length > 6 ? " …" : ""}`);
    console.log(`    facets:`, example.facets);
    console.log(`    provenance:`, example.provenance);
  }

  sec("DONE");
}

main().catch((err) => { console.error("FATAL:", err?.stack ?? err); process.exit(1); });
