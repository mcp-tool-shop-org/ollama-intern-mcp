#!/usr/bin/env node
/**
 * sync-doc-versions.mjs — propagate package.json version + tool/test counts
 * into the docs that quote them.
 *
 * The failure mode this fixes: the v2.3.0 src/version.ts bug (runtime VERSION
 * said "2.0.0" through v2.1.0 and v2.2.0; took two minor releases to surface)
 * has 14+ doc analogs. Every doc that says "v2.4.0" or "41 tools" or "792
 * tests" is a hand-synced number waiting to drift the next time we ship.
 *
 * What it does:
 *   1. Reads the source of truth — package.json (version), src/index.ts (tool
 *      count from the registry), and `npm test --silent` (test pass count).
 *   2. Rewrites tagged HTML-comment spans in markdown:
 *           <!-- VERSION:start -->2.4.0<!-- VERSION:end -->
 *           <!-- TOOL_COUNT:start -->41<!-- TOOL_COUNT:end -->
 *           <!-- TEST_COUNT:start -->792<!-- TEST_COUNT:end -->
 *      and the .ts-file equivalents using line-anchored regex (HTML comments
 *      inside TS string literals would render literally on the rendered
 *      Astro page, so site/src/site-config.ts uses regex anchors instead of
 *      markers).
 *   3. Is idempotent — second run is a no-op when nothing drifted.
 *   4. Prints a clean diff summary at the end.
 *
 * Run:    node scripts/sync-doc-versions.mjs        # writes changes
 *         node scripts/sync-doc-versions.mjs --check # exits 1 if drift; no write
 *         npm run sync-docs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check") || args.has("--dry-run");

// ----------------------------------------------------------------------------
// Source-of-truth resolvers
// ----------------------------------------------------------------------------

function readVersion() {
  const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8"));
  if (!pkg.version) throw new Error("package.json has no version field");
  return pkg.version;
}

function readToolCount() {
  // src/index.ts registers tools with lines starting with `    "ollama_…",`.
  // We count those — this is the same heuristic the README sanity-check uses.
  const src = readFileSync(resolve(REPO, "src/index.ts"), "utf8");
  const matches = src.match(/^\s+"ollama_[a-z_]+",\s*$/gm) || [];
  if (matches.length < 20) {
    throw new Error(
      `tool count looks wrong: only matched ${matches.length} entries in src/index.ts ` +
        `(expected ~40). Has the registry shape changed? Update the regex in sync-doc-versions.mjs.`
    );
  }
  return matches.length;
}

function readTestCount() {
  // Try CHANGELOG first (cheap), fall back to running the suite (slow but
  // truthful). CHANGELOG won't always have a test number embedded, so this
  // is best-effort. The actual count is what `npm test` says.
  try {
    const out = execSync("npm test --silent", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // vitest can take 30-60s; cap at 5 min.
      timeout: 5 * 60 * 1000,
    });
    return parseVitestPassCount(out);
  } catch (e) {
    // vitest exits non-zero on any failure but still writes the summary line
    // to its captured stdout — use the failed-process stdout if present.
    const out = (e.stdout ?? "").toString() + (e.stderr ?? "").toString();
    if (out.length === 0) {
      throw new Error(
        `npm test produced no output. Original error: ${e.message}`
      );
    }
    const n = parseVitestPassCount(out);
    if (n == null) throw e;
    console.warn(
      `[warn] tests are failing; using parsed pass-count ${n} from partial run`
    );
    return n;
  }
}

function parseVitestPassCount(text) {
  // vitest 4.x summary: "Tests  N passed (M)" or
  //                     "Tests  X failed | N passed (M)"
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*Tests\s+.*?(\d+)\s+passed/);
    if (m) return Number(m[1]);
  }
  return null;
}

// ----------------------------------------------------------------------------
// Marker-based rewrite (markdown files)
// ----------------------------------------------------------------------------

function rewriteMarkers(text, key, value) {
  // Replace each <!-- KEY:start -->...<!-- KEY:end --> with the new value.
  // Anchor on the literal comment shape so we never grab stray HTML.
  const open = `<!-- ${key}:start -->`;
  const close = `<!-- ${key}:end -->`;
  const re = new RegExp(
    open.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") +
      "[\\s\\S]*?" +
      close.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
    "g"
  );
  return text.replace(re, `${open}${value}${close}`);
}

// ----------------------------------------------------------------------------
// Regex-based rewrite (TS / non-marker files)
// ----------------------------------------------------------------------------

function rewriteRegex(text, pattern, replacement) {
  return text.replace(pattern, replacement);
}

// ----------------------------------------------------------------------------
// Per-file rewrite plan
// ----------------------------------------------------------------------------

function planRewrites(version, toolCount, testCount) {
  const plan = [];

  // README.md — uses markers around the tagline tool-count.
  plan.push({
    path: "README.md",
    rewrites: [
      (t) => rewriteMarkers(t, "VERSION", version),
      (t) => rewriteMarkers(t, "TOOL_COUNT", String(toolCount)),
      (t) => rewriteMarkers(t, "TEST_COUNT", String(testCount)),
    ],
  });

  // HANDOFF.md — header status line + verify section.
  plan.push({
    path: "HANDOFF.md",
    rewrites: [
      (t) => rewriteMarkers(t, "VERSION", version),
      (t) => rewriteMarkers(t, "TOOL_COUNT", String(toolCount)),
      (t) => rewriteMarkers(t, "TEST_COUNT", String(testCount)),
    ],
  });

  // CONTRIBUTING.md — no version reference today, but seed for the future.
  plan.push({
    path: "CONTRIBUTING.md",
    rewrites: [
      (t) => rewriteMarkers(t, "VERSION", version),
      (t) => rewriteMarkers(t, "TOOL_COUNT", String(toolCount)),
      (t) => rewriteMarkers(t, "TEST_COUNT", String(testCount)),
    ],
  });

  // SHIP_GATE.md — release line.
  plan.push({
    path: "SHIP_GATE.md",
    rewrites: [
      (t) => rewriteMarkers(t, "VERSION", version),
      (t) => rewriteMarkers(t, "TOOL_COUNT", String(toolCount)),
      (t) => rewriteMarkers(t, "TEST_COUNT", String(testCount)),
    ],
  });

  // site/src/site-config.ts — TS file, can't use HTML comments inside string
  // literals (they'd render literally on the page). Use regex anchors that
  // match the project's wording. Each pattern is conservative — it expects
  // a specific neighbouring phrase so it can't accidentally rewrite other
  // numbers that happen to match.
  plan.push({
    path: "site/src/site-config.ts",
    rewrites: [
      (t) =>
        rewriteRegex(
          t,
          /(local intern for Claude Code— |local intern for Claude Code — )\d+( job-shaped tools)/g,
          `$1${toolCount}$2`
        ),
      (t) =>
        rewriteRegex(
          t,
          /(')\d+( job-shaped tools across four tiers)/g,
          `$1${toolCount}$2`
        ),
      (t) =>
        rewriteRegex(
          t,
          /(four tiers, )\d+( tools)/g,
          `$1${toolCount}$2`
        ),
    ],
  });

  // Handbook overview — uses prose tool counts.
  plan.push({
    path: "site/src/content/docs/handbook/index.md",
    rewrites: [
      (t) =>
        rewriteRegex(
          t,
          /(\bevidence-first briefs, durable artifacts\.)/g,
          `$1`
        ),
      (t) =>
        rewriteRegex(
          t,
          /(description: The local intern for Claude Code\. )\d+( job-shaped tools)/g,
          `$1${toolCount}$2`
        ),
      (t) =>
        rewriteRegex(
          t,
          /(Four tiers, )\d+( tools total\.)/g,
          `$1${toolCount}$2`
        ),
      (t) =>
        rewriteRegex(
          t,
          /(\*\*The local intern for Claude Code\.\*\* )\d+( job-shaped tools)/g,
          `$1${toolCount}$2`
        ),
    ],
  });

  // Handbook tools page — tool reference header + at-a-glance.
  plan.push({
    path: "site/src/content/docs/handbook/tools.md",
    rewrites: [
      (t) =>
        rewriteRegex(
          t,
          /(description: All )\d+( tools grouped by tier\.)/g,
          `$1${toolCount}$2`
        ),
    ],
  });

  return plan;
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------

function run() {
  const version = readVersion();
  const toolCount = readToolCount();
  const testCount = readTestCount();

  console.log("");
  console.log("sync-doc-versions");
  console.log("  version    :", version);
  console.log("  tool count :", toolCount);
  console.log("  test count :", testCount);
  console.log("  mode       :", CHECK_ONLY ? "check (no writes)" : "write");
  console.log("");

  const plan = planRewrites(version, toolCount, testCount);
  const changes = [];

  for (const { path, rewrites } of plan) {
    const abs = resolve(REPO, path);
    // Read directly and treat a missing file as "skip". Checking existence
    // first (existsSync) then reading/writing is a TOCTOU — the file can be
    // swapped in the gap (CodeQL js/file-system-race). A single read with
    // ENOENT handling closes the window.
    let before;
    try {
      before = readFileSync(abs, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        console.warn(`[skip] ${path} (not present)`);
        continue;
      }
      throw err;
    }
    let after = before;
    for (const fn of rewrites) {
      after = fn(after);
    }
    if (before === after) continue;
    changes.push({ path, bytesBefore: before.length, bytesAfter: after.length });
    if (!CHECK_ONLY) {
      writeFileSync(abs, after, "utf8");
    }
  }

  if (changes.length === 0) {
    console.log("ok — all docs already in sync");
    return 0;
  }

  console.log(`${CHECK_ONLY ? "drift detected in" : "wrote"} ${changes.length} file(s):`);
  for (const c of changes) {
    const delta = c.bytesAfter - c.bytesBefore;
    const sign = delta >= 0 ? "+" : "";
    console.log(`  ${c.path}  (${sign}${delta} bytes)`);
  }

  // --check exits non-zero when drift exists so CI / pre-commit can gate.
  return CHECK_ONLY ? 1 : 0;
}

const exitCode = run();
process.exit(exitCode);
