# Marketing Research — `ollama-intern-mcp`

_Competitive positioning brief. Date: 2026-04-17._

The category is already crowded with "route Claude's bulk work to Ollama" MCP servers. Every competitor leads with **token savings**. None of them have a durable artifact story, evidence-backed briefs, or tier-shaped tools. That is the open lane.

---

## 1. Adjacent / comparable projects

| Project | Surface | Positioning | What they miss |
|---|---|---|---|
| **rawveg/ollama-mcp** | 14 tools — mostly Ollama SDK passthrough (list/show/pull/push/chat/embed + web search) | "Supercharge your AI assistant with local LLM access." | Pure SDK wrapper. No job-shaped tools, no tier routing, no artifacts. It's an API bridge, not a worker. |
| **houtini-ai/houtini-lm** | 5 generic tools (`chat`, `custom_prompt`, `code_task`, `embed`, `discover`) | "Save Tokens by Offloading Tasks from Claude Code to Your Local LLM Server — 93% token savings benchmarked." | Token-savings framing only. Claude still shapes every prompt. No evidence laws, no durable artifacts, no fixed pipelines. |
| **aplaceforallmystuff/mcp-local-llm** | 6 verbs (`local_summarize`, `local_draft`, `local_classify`, `local_extract`, `local_transform`, `local_complete`) + `local_status` | "A cost-optimization layer… Claude stays in control, decides what to delegate, and reviews the output." | Closest philosophically — job-verb-shaped. But flat (no tiers), no briefs, no packs, no persistent corpora, no artifact continuity. Stateless one-shots. |
| **Jadael/OllamaClaude** | 11 tools split string-based vs file-aware (review/explain/refactor/bugfix/test) | "98.75% reduction in Claude API token usage." | Code-only scope. No corpus retrieval, no evidence discipline, no operator artifacts. |
| **disler/just-prompt** | 6 tools, router across OpenAI/Anthropic/Gemini/Groq/DeepSeek/Ollama + a "CEO and Board" consensus tool | Multi-provider prompt router. | Not a local-first delegation layer. Cloud-route-y. Competes on fan-out, not on worker discipline. |
| **craigmcmeechan/ollama-docker-mcp** | Dockerized Ollama + MCP bridge | "Enables Claude to delegate tasks to local LLMs running via Ollama." | Packaging play, not a product. |
| **MorphLLM / Composio** write-ups | Glue/config content — how to wire Ollama to any MCP client | Content marketing around the category | Not shipping tools — they set the expectation vocabulary. |

**Recurring dev-blog theme** (Bifrost, OnlyCLI, Stacklok, Speakeasy): "MCP tax" — 15k–55k tokens of tool schemas loaded before any work happens. Competitors talk savings in _bytes_; none talk quality of the work the local model does, and none ship artifacts you can hand an operator.

**Category gap:** everyone treats the local LLM as a cheaper completion API. No one treats it as **an intern with rules, tiers, a desk, and a filing cabinet**.

---

## 2. Differentiators we can own

These are the specific moves in `ollama-intern-mcp` that no other project in the category ships:

1. **Job-shaped tools, not verbs.** Competitors expose `chat`, `code_task`, `local_complete`. We expose `triage_logs`, `incident_brief`, `repo_pack`, `corpus_answer`. Claude picks the _tool_; the tool picks the _tier_. Language: **"job-shaped, not model-shaped."**
2. **Tiered routing with hardware profiles.** Instant / Workhorse / Deep / Embed, auto-selected per hardware profile (RTX 5080, M5 Max 128GB). No competitor has tiers. Language: **"the intern decides which model fits the job."**
3. **Evidence-backed briefs with server-side citation validation.** Every claim in a brief must cite an evidence id. Unknown ids are stripped server-side before the result returns; weak briefs get `weak: true` rather than smooth confabulation. Language: **"evidence-first. No fiction."**
4. **Fixed-pipeline packs → durable artifacts.** `incident_pack`, `repo_pack`, `change_pack` run a deterministic sequence and write markdown + JSON to `~/.ollama-intern/artifacts/`. Not a transcript — a filing cabinet. Language: **"packs write to disk. You can read them tomorrow."**
5. **Artifact continuity.** `artifact_list`, `artifact_read`, `artifact_diff`, `artifact_export_to_path`, plus three deterministic snippet tools (incident note / onboarding section / release note). Renderers are code, not prompts — the wording of operator artifacts is not left to a language model. Language: **"deterministic renderers for operator-facing artifacts."**
6. **Living corpora.** Persistent, manifest-backed, incremental refresh via heading-aware chunker + BM25 + RRF fusion. Survives sessions. No competitor persists anything. Language: **"a desk the intern keeps between sessions."**
7. **Honest degradation laws.** Weak banners, coverage notes, no remediation drift (prompts forbid "apply this fix" — investigative only). Language: **"investigative, not prescriptive."**
8. **Uniform envelope.** Every tool returns `result, tier_used, model, hardware_profile, tokens_in/out, elapsed_ms, residency`. You can audit every call. Language: **"every call shows its work."**
9. **Server-enforced guardrails.** Citation stripping, protected-path write control, compile check, confidence threshold, timeouts with logged fallback. The rules aren't in the prompt — they're in the server. Language: **"guardrails in the server, not the prompt."**

**Strongest single claim we own outright:** **"The only local-LLM MCP server that writes durable, cited artifacts you can open in a week."**

---

## 3. Audience shape

Three concentric rings; speak to all three but lead with ring 1.

- **Ring 1 — Claude Code power users building MCP tools.** They already feel the MCP tax and the "Claude does everything" token bill. They search: _ollama mcp_, _claude code local llm_, _mcp token savings_, _offload claude_, _delegate claude code_, _claude code cost_. They read houtini-lm READMEs. They respond to concrete benchmarks.
- **Ring 2 — Ollama users who want more than chat.** They've exhausted `ollama run`. They search: _ollama for work_, _ollama agents_, _ollama pipelines_, _ollama retrieval_. They want jobs, not a REPL.
- **Ring 3 — Solo indie devs doing bulk repo work.** Incident triage, onboarding notes, release notes, log sifting. They search: _local ai code review_, _private log analysis_, _local rag_. They respond to "it writes a file you can paste into a PR."

**Active vocabulary in the wild:** _delegation_, _offload_, _orchestrator_, _grunt work_, _bounded tasks_, _token tax_, _context avoidance_, _hybrid_, _local-first_.

**Words they already trust:** _intern_, _brief_, _pack_, _artifact_, _corpus_, _triage_.

---

## 4. Taglines / one-liners (candidates)

Keep honest. Avoid "agent," "autopilot," "copilot," "thinking," "autonomous."

1. **"The local intern for Claude Code."** — short, sticky, domesticates the category.
2. **"Hand the bulk work to a local intern. Get back a cited brief."** — leads with the artifact, not the savings.
3. **"Local cognitive labor, on tap. 28 job-shaped tools, durable artifacts, evidence-first."** — product-truth dense; landing-page hero.
4. **"Delegate the grunt work. Keep the receipts."** — "receipts" = artifacts; works because our artifacts are real files.
5. **"Claude picks the tool. The tool picks the tier. The tier writes a file you can read next week."** — differentiator-as-tagline; long but explains the whole shape in one line.

**Recommended primary:** _"The local intern for Claude Code — 28 job-shaped tools, evidence-first briefs, durable artifacts."_

---

## 5. README structure for MCP servers (what works)

Blended pattern drawn from houtini-lm (motivation → delegation philosophy) and shipcheck (standards table → trust model):

1. **Hero** — one-liner + one-screenshot-equivalent code block showing a single tool call and its envelope.
2. **Why** — the specific pain: MCP tax, "Claude did it all and I can't audit it," no artifacts.
3. **Example call** — one `ollama_incident_pack` call → show the artifact path + a snippet. This is our cathedral. Lead with it.
4. **What's in here** — table of the four tiers (Atoms / Briefs / Packs / Artifact) with count + one-line purpose each. Mirrors shipcheck's "standards table."
5. **Install** — Claude Code + Claude Desktop MCP config blocks. Keep to two blocks.
6. **Tool table** — grouped by tier, one line each, with "what it returns."
7. **Envelope & tiers** — one block showing the uniform envelope; one table showing tier → model → profile.
8. **Evidence laws** — short list: citations required, unknowns stripped, `weak: true` over fiction, no remediation drift.
9. **Artifacts** — where they live, how to list/read/diff/export, the three snippet helpers.
10. **Threat model** — local file ops, no network egress besides Ollama, protected-path write controls, no telemetry. (Shipcheck-style trust section.)
11. **Scorecard** — shipcheck audit result, current gate status.
12. **Handbook** — link to the Starlight site.

**Cathedral placement:** the `incident_pack → artifact on disk` example sits at the top. Every competitor leads with "save tokens." We lead with "here is the file it wrote."

---

## 6. Terms to avoid

Either owned by other products or they drift our framing.

- **"AI agent" / "agent"** — overloaded and carries "autonomous decision-making" baggage. We are investigative and tool-shaped, not autonomous.
- **"Autopilot" / "Copilot"** — GitHub Copilot owns "copilot"; autopilot implies we drive.
- **"Autonomous" / "self-directed"** — false. Claude drives every call.
- **"Thinking" / "reasoning engine"** — heavy model marketing. We explicitly route _away_ from reasoning.
- **"Supercharge"** (rawveg), **"93% token savings"** (houtini-lm), **"98.75% reduction"** (OllamaClaude), **"cost-optimization layer"** (mcp-local-llm) — already owned, and pinning us to a savings number narrows the story. Savings are a side effect.
- **"Orchestrator"** — houtini-lm and mcp-local-llm both use it for Claude; it's category-default, not differentiating. Use only in passing.
- **"Grunt work" / "boilerplate"** — true but undersells. Our briefs and packs are not grunt work; they're investigative.
- **"Drop-in replacement"** — we replace nothing.
- **"Apply this fix" / "remediation"** — violates the no-remediation-drift law. Never in docs.
- **"Magic" / "just works"** — the whole point is that every call shows its work.

Prefer: **intern**, **delegation layer**, **local cognitive labor**, **job-shaped**, **evidence-first**, **durable artifacts**, **living corpus**, **honest degradation**.

---

## 7. Landing-page scaffolding

Single-page scroll. Heavy weight on the hero example and the artifact shot; light weight on the tool table (link to handbook).

1. **Hero (heaviest visual weight).** Tagline + a split showing: left — the `incident_pack` call; right — the resulting `incident-2026-04-17.md` artifact. One CTA: "Read the handbook." Secondary CTA: "Install."
2. **The shape** (medium weight). Four tiles, one per tier: Atoms (18) · Briefs (3) · Packs (3) · Artifacts (7). One sentence each. No icons-for-icons'-sake.
3. **The laws** (medium weight). Four cards:
   - Evidence-first. Unknown citations stripped server-side.
   - Investigative, not prescriptive. No remediation drift.
   - Weak is weak. `weak: true` beats fake narrative.
   - Every call shows its work. Uniform envelope.
4. **Artifact continuity** (heavy weight). Screenshot-equivalent of the artifacts directory tree + a `artifact_diff` example. This is the single strongest differentiator; show it, don't tell.
5. **Compare** (medium weight). Honest matrix: feature rows × (us, houtini-lm, rawveg/ollama-mcp, mcp-local-llm). Rows: tiered routing, evidence laws, durable artifacts, living corpora, uniform envelope. Checkmark/no, no scores.
6. **Install** (light weight). Two config blocks, Claude Code + Claude Desktop. Done.
7. **Threat model** (light weight). Six bullets mirroring the README's trust section. No marketing gloss.
8. **Scorecard + Handbook links** (footer).

**Do not include:**
- Hero stats like "93% savings." They pin us to a savings benchmark we don't want to defend.
- "What is an MCP server?" explainer. Our audience knows.
- Generic "powered by open source" badges row.
- A "roadmap" section. Ship only what's real.
- Testimonials we don't have.
- A chatbot demo widget.

---

## Concrete next moves

1. **Lock primary tagline:** _"The local intern for Claude Code — 28 job-shaped tools, evidence-first briefs, durable artifacts."_
2. **README hero:** rewrite around a single `incident_pack` call + artifact screenshot. Drop any token-savings lead.
3. **Comparison matrix** in the handbook (not README) against houtini-lm, rawveg/ollama-mcp, mcp-local-llm, OllamaClaude. Five rows: tiers, evidence laws, artifacts, corpora, envelope.
4. **Reserve the "intern" framing across the site** — it's underused in the category and maps cleanly to tiers, briefs, packs, filing cabinet.
5. **Never quote a token-savings percentage.** Category is saturated on that axis. Our lane is _what the intern produces_, not _what it costs._
