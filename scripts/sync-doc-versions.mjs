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
 *      count from the registry), and a test pass count (--test-count /
 *      SYNC_DOCS_TEST_COUNT, or `npm test --silent` in write mode only).
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
 * Run:    node scripts/sync-doc-versions.mjs        # writes changes (runs the suite once)
 *         node scripts/sync-doc-versions.mjs --check --test-count=N
 *         SYNC_DOCS_TEST_COUNT=N npm run sync-docs:check
 *
 * --check never spawns `npm test`. CI must pass the count from the verify
 * cell that already ran the suite (fail-closed: no partial count on
 * failure). Write mode (no --check) still runs the suite once to measure.
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

function parseCountValue(raw, label) {
  if (raw == null || !/^\d+$/.test(String(raw).trim())) {
    throw new Error(
      `${label} requires a non-negative integer, got ${JSON.stringify(raw)}`
    );
  }
  return Number(String(raw).trim());
}

function providedTestCount() {
  const env = process.env.SYNC_DOCS_TEST_COUNT;
  if (env != null && String(env).trim() !== "") {
    return parseCountValue(env, "SYNC_DOCS_TEST_COUNT");
  }
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--test-count") {
      return parseCountValue(argv[i + 1], "--test-count");
    }
    if (a.startsWith("--test-count=")) {
      return parseCountValue(a.slice("--test-count=".length), "--test-count");
    }
  }
  return null;
}

function readTestCount() {
  const provided = providedTestCount();
  if (provided != null) return provided;
  if (CHECK_ONLY) {
    throw new Error(
      "--check will not spawn `npm test` (that would duplicate ci.yml verify). " +
        "Pass --test-count=N or SYNC_DOCS_TEST_COUNT from the verify cell's fail-closed pass count. " +
        "For a local rewrite that measures the suite, run `npm run sync-docs` (write mode)."
    );
  }
  return readTestCountFromSuite();
}

function readTestCountFromSuite() {
  let out;
  try {
    out = execSync("npm test --silent", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // vitest can take 30-60s; cap at 5 min.
      timeout: 5 * 60 * 1000,
    });
  } catch (e) {
    throw new Error(
      `npm test failed; refusing to use a partial pass count (fail-closed). ${e.message}`
    );
  }
  const n = parseVitestPassCount(out);
  if (n == null) {
    throw new Error("Could not parse passing-test count from vitest output.");
  }
  return n;
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
//
// Both rewriters take a `record(marker, from, to)` callback and call it for
// every value they actually change. The report at the end is built from those
// records, not from a byte delta: real drifts here are digit-count preserving
// (2.9.1 -> 2.9.2, 44 -> 45, 1158 -> 1162), so a byte delta is almost always
// +0 and tells an operator nothing about WHICH marker went stale.

function rewriteMarkers(text, key, value, record) {
  // Replace each <!-- KEY:start -->...<!-- KEY:end --> with the new value.
  // Anchor on the literal comment shape so we never grab stray HTML.
  const open = `<!-- ${key}:start -->`;
  const close = `<!-- ${key}:end -->`;
  const re = new RegExp(
    open.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") +
      "([\\s\\S]*?)" +
      close.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"),
    "g"
  );
  const next = String(value);
  return text.replace(re, (_whole, current) => {
    if (current !== next) record(key, current, next);
    return `${open}${next}${close}`;
  });
}

// ----------------------------------------------------------------------------
// Regex-based rewrite (TS / non-marker files)
// ----------------------------------------------------------------------------

function rewriteCount(text, pattern, value, record, marker) {
  // `pattern` must bracket the number with exactly two capture groups:
  //     /(prefix )\d+( suffix)/g
  // so the current value can be read back out for the drift report. A rule
  // that captures no digits can never change a byte — it is a stub, not
  // coverage, and does not belong in the plan.
  const next = String(value);
  return text.replace(pattern, (whole, pre, post) => {
    const current = whole.slice(pre.length, whole.length - post.length);
    if (current !== next) record(marker, current, next);
    return `${pre}${next}${post}`;
  });
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
      (t, rec) => rewriteMarkers(t, "VERSION", version, rec),
      (t, rec) => rewriteMarkers(t, "TOOL_COUNT", toolCount, rec),
      (t, rec) => rewriteMarkers(t, "TEST_COUNT", testCount, rec),
    ],
  });

  // HANDOFF.md — header status line + verify section.
  plan.push({
    path: "HANDOFF.md",
    rewrites: [
      (t, rec) => rewriteMarkers(t, "VERSION", version, rec),
      (t, rec) => rewriteMarkers(t, "TOOL_COUNT", toolCount, rec),
      (t, rec) => rewriteMarkers(t, "TEST_COUNT", testCount, rec),
    ],
  });

  // CONTRIBUTING.md — no version reference today, but seed for the future.
  plan.push({
    path: "CONTRIBUTING.md",
    rewrites: [
      (t, rec) => rewriteMarkers(t, "VERSION", version, rec),
      (t, rec) => rewriteMarkers(t, "TOOL_COUNT", toolCount, rec),
      (t, rec) => rewriteMarkers(t, "TEST_COUNT", testCount, rec),
    ],
  });

  // SHIP_GATE.md — release line.
  plan.push({
    path: "SHIP_GATE.md",
    rewrites: [
      (t, rec) => rewriteMarkers(t, "VERSION", version, rec),
      (t, rec) => rewriteMarkers(t, "TOOL_COUNT", toolCount, rec),
      (t, rec) => rewriteMarkers(t, "TEST_COUNT", testCount, rec),
    ],
  });

  // .github/ISSUE_TEMPLATE/feature_request.md — the "what job can't be done
  // with the current N tools" prompt. The number sits INSIDE the template's
  // leading <!-- … --> instruction block, so marker comments cannot be used
  // here: a nested `-->` would close the outer comment early and dump the rest
  // of the instructions into the rendered issue body. Same situation as
  // site-config.ts below — use a conservative regex anchor instead. (Do not
  // "upgrade" this to TOOL_COUNT markers.)
  plan.push({
    path: ".github/ISSUE_TEMPLATE/feature_request.md",
    rewrites: [
      (t, rec) =>
        rewriteCount(
          t,
          /(done with the current )\d+( tools)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
        ),
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
      (t, rec) =>
        rewriteCount(
          t,
          /(local intern for Claude Code— |local intern for Claude Code — )\d+( job-shaped tools)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
        ),
      (t, rec) =>
        rewriteCount(
          t,
          /(')\d+( job-shaped tools across four tiers)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
        ),
      (t, rec) =>
        rewriteCount(
          t,
          /(four tiers, )\d+( tools)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
        ),
    ],
  });

  // Handbook overview — uses prose tool counts. The frontmatter `description:`
  // count (the one ending "…, evidence-first briefs, durable artifacts.") is
  // maintained by the first rule below; it does NOT need a separate rule of
  // its own. A no-op rule that matched only that trailing prose used to sit
  // here and could never change a byte — it read as coverage for an
  // unmaintained number while maintaining nothing.
  plan.push({
    path: "site/src/content/docs/handbook/index.md",
    rewrites: [
      (t, rec) =>
        rewriteCount(
          t,
          /(description: The local intern for Claude Code\. )\d+( job-shaped tools)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
        ),
      (t, rec) =>
        rewriteCount(
          t,
          /(Four tiers, )\d+( tools total\.)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
        ),
      (t, rec) =>
        rewriteCount(
          t,
          /(\*\*The local intern for Claude Code\.\*\* )\d+( job-shaped tools)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
        ),
    ],
  });

  // Handbook tools page — tool reference header + at-a-glance.
  plan.push({
    path: "site/src/content/docs/handbook/tools.md",
    rewrites: [
      (t, rec) =>
        rewriteCount(
          t,
          /(description: All )\d+( tools grouped by tier\.)/g,
          toolCount,
          rec,
          "TOOL_COUNT"
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
    // Collect (marker, oldValue, newValue) per file so the report can name
    // WHAT drifted, not just which file. Dedupe: the same marker legitimately
    // appears several times in one doc and drifts identically each time.
    const seen = new Set();
    const drifts = [];
    const record = (marker, from, to) => {
      const key = `${marker} ${from} ${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      drifts.push({ marker, from, to });
    };

    let after = before;
    for (const fn of rewrites) {
      after = fn(after, record);
    }
    if (before === after) continue;
    changes.push({ path, drifts });
    if (!CHECK_ONLY) {
      writeFileSync(abs, after, "utf8");
    }
  }

  if (changes.length === 0) {
    console.log("ok — all docs already in sync");
    return 0;
  }

  // Check mode is a CI gate, so it reports like one: to stderr, with a
  // ::error file=…:: annotation per drift (the shape doc-drift.yml Checks 1-3
  // already use) and a closing remediation command, mirroring
  // gen-tool-docs.mjs. Write mode just says what it rewrote.
  const say = CHECK_ONLY ? console.error : console.log;
  if (CHECK_ONLY) console.error("");
  say(`${CHECK_ONLY ? "drift detected in" : "wrote"} ${changes.length} file(s):`);
  for (const { path, drifts } of changes) {
    if (drifts.length === 0) {
      // Defensive: a rewrite changed bytes without recording a value. Still
      // name the file rather than printing a silent entry.
      say(`  ${path}  (content changed)`);
      continue;
    }
    for (const d of drifts) {
      say(`  ${path}  ${d.marker}: ${d.from} -> ${d.to}`);
    }
  }

  if (CHECK_ONLY) {
    for (const { path, drifts } of changes) {
      for (const d of drifts) {
        console.error(
          `::error file=${path}::${d.marker} says ${d.from}, source of truth says ${d.to}`
        );
      }
    }
    console.error("");
    console.error("run `npm run sync-docs` and commit the result.");
  }

  // --check exits non-zero when drift exists so CI / pre-commit can gate.
  return CHECK_ONLY ? 1 : 0;
}

// Print only the message on failure — a raw Node stack trace buries the hint
// these errors carry, and this script is wired into two CI gates (ci.yml
// verify ubuntu/20 and doc-drift.yml Check 4). Same framing as
// gen-tool-docs.mjs and cloud-smoke-generate.mjs; shipcheck Gate B forbids
// raw stacks.
try {
  process.exit(run());
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
