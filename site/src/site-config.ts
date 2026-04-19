import type { SiteConfig } from '@mcptoolshop/site-theme';

export const config: SiteConfig = {
  title: 'Ollama Intern MCP',
  description:
    'The local intern for Claude Code — 40 tools across a frozen primitive core (atoms/briefs/packs/artifacts) and four additive layers (skills, memory, shadow routing, operator-gated calibration).',
  logoBadge: 'OI',
  brandName: 'ollama-intern-mcp',
  repoUrl: 'https://github.com/mcp-tool-shop-org/ollama-intern-mcp',
  npmUrl: 'https://www.npmjs.com/package/ollama-intern-mcp',
  footerText:
    'MIT Licensed — built by <a href="https://mcp-tool-shop.github.io/" style="color:var(--color-muted);text-decoration:underline">MCP Tool Shop</a>',

  hero: {
    badge: 'Local · evidence-first · shadow-only · MIT',
    headline: 'The local intern',
    headlineAccent: 'for Claude Code.',
    description:
      '40 tools: a frozen primitive core (atoms, briefs, packs, artifacts) and four additive layers above it — skills, memory, shadow routing, operator-gated calibration. Claude picks the tool, the tool picks the tier, the tier writes a file you can open next week. Shadow routing records what should have happened without ever taking control. No cloud. No telemetry.',
    primaryCta: { href: '#example', label: 'See a pack run' },
    secondaryCta: { href: 'handbook/', label: 'Read the Handbook' },
    previews: [
      {
        label: 'Call',
        code: `// Claude → ollama-intern-mcp
{
  "tool": "ollama_incident_pack",
  "arguments": {
    "title": "sprite pipeline 5 AM paging regression",
    "logs": "[2026-04-16 05:07] worker-3 OOM killed\\n...",
    "source_paths": [
      "src/worker.ts",
      "memory/sprite-foundry-visual-mastery.md"
    ]
  }
}`,
      },
      {
        label: 'Artifact',
        code: `~/.ollama-intern/artifacts/incident/
  2026-04-16-sprite-pipeline-5-am-paging-regression.md
  2026-04-16-sprite-pipeline-5-am-paging-regression.json

# headings, evidence block with cited ids,
# investigative next_checks, weak: false.
# deterministic renderer — not a prompt.`,
      },
      {
        label: 'Envelope',
        code: `{
  "tier_used": "deep",
  "model": "qwen3:14b",
  "hardware_profile": "dev-rtx5080",
  "tokens_in": 4180, "tokens_out": 612,
  "elapsed_ms": 8410,
  "residency": { "in_vram": true, "evicted": false }
}`,
      },
    ],
  },

  sections: [
    {
      kind: 'features',
      id: 'shape',
      title: 'The core — four tiers, 28 frozen primitives',
      subtitle: 'Job-shaped, not model-shaped. Pick the job; the tier follows. The primitive surface does not grow.',
      features: [
        {
          title: 'Atoms · 15',
          desc: 'Primitives. classify, extract, triage_logs, summarize_fast/deep, draft, research, corpus_* (search/answer/index/refresh/list), embed(_search), chat. Batch-capable atoms accept items: [{id, text}].',
        },
        {
          title: 'Briefs · 3',
          desc: 'Evidence-first operator briefs. incident_brief, repo_brief, change_brief. Every claim cites an evidence id. Unknowns stripped server-side. Weak evidence flags weak: true rather than smoothing fake narrative.',
        },
        {
          title: 'Packs · 3',
          desc: 'Fixed-pipeline compound jobs. incident_pack, repo_pack, change_pack run a deterministic sequence and write durable markdown + JSON to ~/.ollama-intern/artifacts/. Not a transcript — a filing cabinet.',
        },
        {
          title: 'Artifacts · 7',
          desc: 'Continuity surface over pack outputs. list, read, diff, export_to_path, plus three deterministic snippet helpers for incident notes, onboarding sections, release notes. No model calls in this tier.',
        },
      ],
    },
    {
      kind: 'features',
      id: 'layers',
      title: 'The layers above — 12 tools for durable workflows, recall, and governed routing',
      subtitle: 'Additive. The primitives stay frozen. New functionality is always a new layer above.',
      features: [
        {
          title: 'Skills · 5',
          desc: 'Named pipelines over atoms with triggers, parameters, and a receipt written after every run. ollama_skill_list/match/run/propose/promote. Global skills in ~/.ollama-intern/skills/; project skills in <cwd>/skills/ override global by name.',
        },
        {
          title: 'Memory · 5',
          desc: 'Embedding-backed retrieval across receipts, artifacts, skills, and proposals. ollama_memory_refresh/search/read/explain/neighbors. Nomic prefixes, typed hits with score bands, deterministic explanations with opt-in Instant-tier narration.',
        },
        {
          title: 'Shadow routing · 0 surface',
          desc: 'Transparent instrumentation over 10 atoms + 5 flagships + 3 packs. Every call writes a RoutingReceipt: pre-execution decision, actual invocation, outcome linkage, calibration version. Behavior is unchanged — shadow is shadow-only.',
        },
        {
          title: 'Routing audit + calibration · 2',
          desc: 'ollama_routing_audit surfaces findings (promotion_gap, override_hotspot, abstain_cluster, missed_abstain, unused_candidate, overconfident_route). ollama_routing_calibrate runs a propose / replay / approve / reject / rollback lifecycle. Every approval requires a reason. Nothing auto-applies.',
        },
      ],
    },
    {
      kind: 'features',
      id: 'laws',
      title: 'Laws, enforced server-side',
      subtitle: 'Not prompt conventions. Code.',
      features: [
        {
          title: 'Evidence-first',
          desc: 'Every brief claim cites an evidence id. Unknown ids are stripped server-side before the result returns.',
        },
        {
          title: 'Investigative, not prescriptive',
          desc: 'next_checks, read_next, likely_breakpoints only. Prompts explicitly forbid "apply this fix." No remediation drift.',
        },
        {
          title: 'Weak is weak',
          desc: 'Thin evidence flags weak: true with coverage notes. Never smoothed into fake narrative.',
        },
        {
          title: 'Every call shows its work',
          desc: 'Uniform envelope: tier_used, model, hardware_profile, tokens_in/out, elapsed_ms, residency from /api/ps. NDJSON log at ~/.ollama-intern/log.ndjson.',
        },
      ],
    },
    {
      kind: 'code-cards',
      id: 'example',
      title: 'One call, one artifact',
      cards: [
        {
          title: 'The call',
          code: `// Claude → ollama-intern-mcp
{
  "tool": "ollama_incident_pack",
  "arguments": {
    "title": "5 AM paging regression",
    "logs": "[05:07] worker-3 OOM killed\\n[05:07] /api/ps evicted=true size=8.1GB\\n...",
    "source_paths": [
      "src/worker.ts",
      "memory/sprite-foundry-visual-mastery.md"
    ]
  }
}`,
        },
        {
          title: 'The artifact (deterministic)',
          code: `# Incident — 5 AM paging regression
slug: 2026-04-16-5-am-paging-regression
weak: false · evidence_count: 6

## Evidence
- e1: src/worker.ts:148–162 (OOM path)
- e2: log excerpt 05:07 (residency.evicted=true)
- ...

## Next checks
- residency.evicted across last 24h
- OLLAMA_MAX_LOADED_MODELS vs loaded size

## Read next
- src/worker.ts:worker_loop
- docs/ops/ollama-paging.md`,
        },
      ],
    },
    {
      kind: 'code-cards',
      id: 'install',
      title: 'Install',
      cards: [
        {
          title: 'npm',
          code: 'npm install -g ollama-intern-mcp',
        },
        {
          title: 'Claude Code',
          code: `{
  "mcpServers": {
    "ollama-intern": {
      "command": "npx",
      "args": ["-y", "ollama-intern-mcp"],
      "env": {
        "OLLAMA_HOST": "http://127.0.0.1:11434",
        "INTERN_PROFILE": "dev-rtx5080"
      }
    }
  }
}`,
        },
        {
          title: 'Model pulls (dev-rtx5080)',
          code: `ollama pull qwen3:8b
ollama pull qwen3:14b
ollama pull nomic-embed-text
export OLLAMA_MAX_LOADED_MODELS=4
export OLLAMA_KEEP_ALIVE=-1`,
        },
      ],
    },
  ],
};
