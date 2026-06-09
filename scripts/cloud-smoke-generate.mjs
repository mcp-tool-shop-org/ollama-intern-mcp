#!/usr/bin/env node
/**
 * cloud-smoke-generate.mjs — one REAL cloud generate to prove the v2.7.0
 * cloud-primary routing path actually serves from Ollama Cloud.
 *
 * Why this exists separately from `doctor`: the doctor cloud probe only hits
 * /api/tags, which lists PUBLIC models and does NOT gate on the API key (it
 * returns 200 even for a bad key — doctor reports auth "unverified" on purpose).
 * So `doctor` confirms reachability but can NEVER confirm a good key. The only
 * way to validate the key end-to-end is a real generate call — that is what
 * this script does, then asserts the routing provenance is backend: "cloud"
 * (not a silent local fallback).
 *
 * Built to be QUOTA-CHEAP: one call, ~8 output tokens, thinking off,
 * temperature 0. This is the single tiny call the manual CI smoke job makes
 * against the real cloud GPU.
 *
 * Run (cloud must be opted in via env):
 *   OLLAMA_CLOUD_PRIMARY=1 OLLAMA_API_KEY=sk-... node scripts/cloud-smoke-generate.mjs
 *
 * Exit codes:
 *   0  served from cloud (backend === "cloud") — the path works.
 *   1  served from local fallback, or no routing provenance — the path is broken.
 *   2  cloud not opted in (OLLAMA_CLOUD_PRIMARY/OLLAMA_API_KEY unset) — nothing to test.
 *
 * Imports the COMPILED output (dist/) so the script exercises the exact code
 * the published package ships — run `npm run build` first.
 */

import { HttpOllamaClient } from "../dist/ollama.js";
import { RoutingOllamaClient, getRoutingInfo } from "../dist/routing.js";
import { loadProfile, loadCloudConfig } from "../dist/profiles.js";

const cloud = loadCloudConfig();
if (!cloud) {
  console.error(
    "cloud-smoke-generate: cloud not opted in (set OLLAMA_CLOUD_PRIMARY=1 and OLLAMA_API_KEY) — nothing to test.",
  );
  process.exit(2);
}

const profile = loadProfile();
const local = new HttpOllamaClient();
const cloudClient = new HttpOllamaClient({
  baseUrl: cloud.host,
  apiKey: cloud.apiKey,
  kind: "cloud",
});

// Mirror index.ts wiring exactly: every tool talks to this RoutingOllamaClient.
const client = new RoutingOllamaClient({
  cloud: cloudClient,
  local,
  cloudTiers: cloud.tiers,
  localTiers: profile.tiers,
  cloudTimeouts: cloud.timeouts,
  cloudNumCtx: cloud.numCtx,
});

console.log(
  `cloud-smoke-generate: host=${cloud.host} cloud-model=${cloud.tiers.instant} (local fallback=${profile.tiers.instant})`,
);

// The runner resolves the LOCAL model and tier; RoutingOllamaClient overrides
// to the cloud model on the cloud attempt. Pass the local instant model + the
// "instant" tier exactly as runTool would.
let resp;
try {
  resp = await client.generate(
    {
      model: profile.tiers.instant,
      prompt: "Reply with exactly the single word: ok",
      stream: false,
      think: false,
      options: { num_predict: 8, temperature: 0 },
    },
    undefined,
    "instant",
  );
} catch (err) {
  // On a CI runner there is no local Ollama, so a cloud failure that triggers
  // the cloud→local fallback throws here (local unreachable). Either way, the
  // cloud path did not serve — report it cleanly instead of dumping a stack.
  const msg = err instanceof Error ? err.message : String(err);
  console.error(
    `::error::cloud generate failed (${msg}) — the cloud attempt errored and there is no local fallback in CI. Check the OLLAMA_CLOUD key and that the cloud model is available.`,
  );
  process.exit(1);
}

const info = getRoutingInfo(resp);
console.log("routing:", JSON.stringify(info ?? null));
console.log("response:", JSON.stringify((resp.response ?? "").slice(0, 80)));

if (!info) {
  console.error("::error::no routing provenance on the response — RoutingOllamaClient did not tag it.");
  process.exit(1);
}
if (info.backend !== "cloud") {
  console.error(
    `::error::expected backend "cloud" but served "${info.backend}" (degrade_reason=${info.degrade_reason ?? "n/a"}, circuit=${info.circuit_state}) — cloud generate fell back to local.`,
  );
  process.exit(1);
}

console.log(`cloud-smoke-generate: OK — served from cloud, model=${info.model}.`);
