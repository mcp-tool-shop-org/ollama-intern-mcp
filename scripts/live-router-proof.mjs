// Phase 3D Commit A — live proof of the router core against real on-disk
// memory + skill state. No MCP surface, no interception — just build a
// RoutingContext and call route() for several realistic job shapes to
// verify the ranked field looks sensible + the trace is auditable.

import { buildRoutingContext, route } from "../dist/routing/index.js";
import { summarizeInputShape } from "../dist/observability.js";

function sec(t) { console.log("\n" + "=".repeat(78) + "\n  " + t + "\n" + "=".repeat(78)); }

async function runCase(label, input, jobHint) {
  sec(label);
  console.log("job_hint:", jobHint);
  const context = await buildRoutingContext({
    input_shape: summarizeInputShape(input),
    job_hint: jobHint,
  });
  console.log("available_skills:", context.available_skills.map((s) => `${s.id} (${s.status})`));
  console.log("candidate_proposals:", context.candidate_proposals.length);
  console.log("memory_hits:", context.memory_hits.length);
  console.log("input_flags:", context.input_flags);

  const decision = route(context);
  console.log("\nsuggested:", decision.suggested);
  console.log("abstain_reason:", decision.abstain_reason);
  console.log("\ntop 5 candidates:");
  for (const c of decision.candidates.slice(0, 5)) {
    console.log(`  ${c.score.toFixed(2)}  [${c.band}]  ${c.target.kind}:${c.target.ref}`);
    for (const s of c.signals.slice(0, 3)) console.log(`    +${s.weight.toFixed(2)}  ${s.name}: ${s.reason}`);
    if (c.missing_signals.length > 0) console.log(`    missing: ${c.missing_signals.join(", ")}`);
    if (c.provenance.length > 0) console.log(`    provenance: ${c.provenance.map((p) => p.kind + ":" + p.ref).join(", ")}`);
  }
  return decision;
}

async function main() {
  // Case 1: an incident-shaped job — should prefer a triage skill if present, else incident_pack
  const d1 = await runCase(
    "1. Incident-shaped job — log_text present, source_paths empty",
    { log_text: "x".repeat(3000) },
    "triage these logs for errors and build an incident brief",
  );

  // Case 2: a change-review job — diff_text + source_paths
  const d2 = await runCase(
    "2. Change-review shape — diff_text + source_paths present",
    { diff_text: "x".repeat(2000), source_paths: ["src/a.ts", "src/b.ts"] },
    "review this change and flag likely breakpoints",
  );

  // Case 3: empty-ish job — router should abstain
  const d3 = await runCase(
    "3. Empty job — nothing to route on",
    {},
    "help",
  );

  // Case 4: repo orientation — source_paths + corpus
  const d4 = await runCase(
    "4. Repo orientation — source_paths + corpus present",
    { source_paths: ["README.md", "package.json"], corpus: "memory" },
    "get me oriented in this repo",
  );

  sec("ASSERTIONS");

  const checks = [
    {
      label: "case 1 suggests a skill or pack (not abstain) with log_text present",
      pass: d1.suggested !== null,
    },
    {
      label: "case 1 top candidate prefers the triage-then-brief skill if available",
      pass: (() => {
        if (!d1.suggested) return false;
        if (d1.suggested.kind === "skill" && d1.suggested.ref === "triage-then-brief") return true;
        if (d1.suggested.kind === "pack" && d1.suggested.ref === "incident_pack") return true;
        return false;
      })(),
    },
    {
      label: "case 2 top candidate is change_pack (skill doesn't exist for this shape)",
      pass: d2.suggested?.kind === "pack" && d2.suggested?.ref === "change_pack",
    },
    {
      label: "case 3 abstains honestly",
      pass: d3.suggested === null && d3.abstain_reason !== null,
    },
    {
      label: "case 4 top candidate is repo_pack",
      pass: d4.suggested?.kind === "pack" && d4.suggested?.ref === "repo_pack",
    },
    {
      label: "every decision carries a ranked field + no_suggestion slot",
      pass: [d1, d2, d3, d4].every(
        (d) => d.candidates.some((c) => c.target.kind === "no_suggestion"),
      ),
    },
    {
      label: "determinism: rerunning case 1 produces the same top candidate",
      pass: (async () => {
        const ctx2 = await buildRoutingContext({
          input_shape: summarizeInputShape({ log_text: "x".repeat(3000) }),
          job_hint: "triage these logs for errors and build an incident brief",
        });
        const d = route(ctx2);
        return d.suggested?.ref === d1.suggested?.ref;
      }),
    },
  ];

  let pass = 0;
  let fail = 0;
  for (const c of checks) {
    const ok = typeof c.pass === "function" ? await c.pass() : c.pass;
    console.log(`  ${ok ? "✔" : "✗"}  ${c.label}`);
    if (ok) pass++; else fail++;
  }
  console.log(`\n  ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exitCode = 2;
}

main().catch((err) => { console.error("FATAL:", err?.stack ?? err); process.exit(1); });
