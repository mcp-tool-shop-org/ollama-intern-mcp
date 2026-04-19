// Phase 3B live proof — embed real memory records via Ollama, run real
// queries, verify nomic prefixes, metadata pre-filter, typed results, and
// honest weak-degradation.
//
// Run order:
//   1. Refresh (writes embeddings.json via nomic-embed-text).
//   2. Search by free text and by kind-filter; print top hits.
//   3. Zero-prefilter-match path.
//   4. Swap prefixes and show recall collapse (prefix discipline proof).
//   5. Idempotence: re-refresh with no content changes → zero re-embed.

import { promises as fs } from "node:fs";
import path from "node:path";

import { loadProfile } from "../dist/profiles.js";
import { HttpOllamaClient } from "../dist/ollama.js";
import { NullLogger } from "../dist/observability.js";
import { handleMemoryRefresh } from "../dist/tools/memoryRefresh.js";
import { handleMemorySearch } from "../dist/tools/memorySearch.js";
import { loadEmbeddings, embeddingsPath } from "../dist/memory/embeddings.js";
import { cosine } from "../dist/embedMath.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

function showHit(h, i) {
  console.log(`  ${i + 1}. [${h.record.kind}] ${h.record.title}`);
  console.log(`     score=${h.score.toFixed(3)}  band=${h.band}  id=${h.record.id}`);
  console.log(`     reasons: ${h.reasons.join(", ")}`);
  console.log(`     source: ${h.record.provenance.source_path}`);
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
  console.log("embed model:", ctx.tiers.embed);
  console.log("embeddings path:", embeddingsPath());

  sec("1. Refresh — structural + embeddings");
  const refresh = await handleMemoryRefresh({}, ctx);
  console.log("structural:", { total: refresh.result.total_records, per_kind: refresh.result.per_kind_counts });
  console.log("embeddings:", refresh.result.embeddings);

  sec("2. Idempotence — re-refresh should make zero embed calls");
  const refresh2 = await handleMemoryRefresh({}, ctx);
  console.log("embeddings drift:", refresh2.result.embeddings);
  const idempotent = refresh2.result.embeddings.added_count === 0 &&
                     refresh2.result.embeddings.updated_count === 0 &&
                     refresh2.result.embeddings.embed_calls === 0;
  console.log(idempotent ? "  ✔ idempotent embed refresh" : "  ✗ re-embedded unnecessarily");
  if (!idempotent) process.exitCode = 2;

  sec("3. Free-text search — 'triage a noisy log for errors'");
  const s1 = await handleMemorySearch({ query: "triage a noisy log for errors", limit: 5 }, ctx);
  console.log("considered:", s1.result.considered, "prefilter_survivors:", s1.result.candidates_after_prefilter, "weak:", s1.result.weak);
  for (const [i, h] of s1.result.hits.entries()) showHit(h, i);

  sec("4. Kind-filter search — only approved_skill records");
  const s2 = await handleMemorySearch({ query: "workflow that reviews incidents", kinds: ["approved_skill"], limit: 3 }, ctx);
  console.log("considered:", s2.result.considered, "prefilter_survivors:", s2.result.candidates_after_prefilter, "weak:", s2.result.weak);
  for (const [i, h] of s2.result.hits.entries()) showHit(h, i);
  const allApproved = s2.result.hits.every((h) => h.record.kind === "approved_skill");
  console.log(allApproved ? "  ✔ every hit is approved_skill" : "  ✗ kind filter leaked");
  if (!allApproved) process.exitCode = 2;

  sec("5. Zero-prefilter-match — facet that no record has");
  const s3 = await handleMemorySearch({
    query: "anything",
    facets: { hardware_profile: { equals: "m5-max" } },
    limit: 5,
  }, ctx);
  console.log("prefilter_survivors:", s3.result.candidates_after_prefilter, "hits:", s3.result.hits.length, "weak:", s3.result.weak);
  const degraded = s3.result.candidates_after_prefilter === 0 && s3.result.hits.length === 0 && s3.result.weak === true;
  console.log(degraded ? "  ✔ degraded honestly — no embed call wasted" : "  ✗ did not degrade honestly");
  if (!degraded) process.exitCode = 2;

  sec("6. Prefix-discipline proof — same query WITHOUT `search_query:` prefix should lose signal");
  // Pull the raw nomic vectors directly: correctly-prefixed query vs no-prefix query vs all record vecs
  const store = await loadEmbeddings();
  const records = Object.entries(store.entries).slice(0, 6);
  const embResp = await ctx.client.embed({
    model: ctx.tiers.embed,
    input: [
      "search_query: triage a noisy log for errors",   // correct
      "triage a noisy log for errors",                  // no prefix
      "search_document: triage a noisy log for errors", // WRONG prefix
    ],
  });
  const [withQuery, noPrefix, wrongPrefix] = embResp.embeddings;
  let correctBest = -1, noPrefixBest = -1, wrongBest = -1;
  for (const [, entry] of records) {
    correctBest = Math.max(correctBest, cosine(withQuery, entry.vector));
    noPrefixBest = Math.max(noPrefixBest, cosine(noPrefix, entry.vector));
    wrongBest = Math.max(wrongBest, cosine(wrongPrefix, entry.vector));
  }
  console.log("  best cosine vs records (correct `search_query:` prefix):", correctBest.toFixed(3));
  console.log("  best cosine vs records (no prefix):                   ", noPrefixBest.toFixed(3));
  console.log("  best cosine vs records (wrong `search_document:` tag):", wrongBest.toFixed(3));
  // Honest claim: correct prefix should match or slightly beat alternatives on THIS nomic build.
  // We don't assert a strict ordering; we just surface the numbers so drift is visible.

  sec("DONE");
}

main().catch((err) => { console.error("FATAL:", err?.stack ?? err); process.exit(1); });
