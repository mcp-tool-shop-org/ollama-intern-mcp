# ollama-intern-mcp Local LLM Role Contract Report

**Date:** 2026-05-11
**Repo state:** post-v2.1.0 (commit a9d0b38)
**Scope:** role-contract dogfood (4 agents, read-only). NOT a v1-readiness or repo-health audit.
**Seed failure driving the test:** research-os' local-LLM layer produced plausible arXiv titles for real arXiv IDs; fetched papers were unrelated. The tool laundered model interpretation into authoritative source identity.

**The single question:**
Can ollama-intern-mcp act as a bounded local evidence worker without inventing source truth, overstating confidence, or laundering weak retrieval into authoritative output?

---

## Verdict — SAFE WITH CONSTRAINTS *for fabrication*; UNSAFE *for frame-bound evidence work*

The seed failure has two failure modes. ollama-intern-mcp's posture against each is asymmetric:

| Failure mode | Verdict | Why |
|---|---|---|
| **Fabrication** — model invents source identity (URLs, titles, papers, authors) | **SAFE** structurally | No URL/fetch/arXiv surface exists at all. Every source is a caller-declared path, a pre-indexed corpus chunk, or a pre-existing artifact. The schema has no `url`/`title`/`author`/`doi`/`paper_id` slot a model can fill. The seed failure shape literally has no input. |
| **Confidence laundering** — model self-report flows out as if grounded | **SAFE WITH CONSTRAINTS** | Real but small: `classify` and brief `confidence` fields aren't provenance-tagged. Retrieval `top_score` is real grounding. |
| **Relevance laundering** — true claims extracted from off-topic sources, presented as on-topic | **UNSAFE** structurally | Zero representation of topicality anywhere. `extract`/`classify`/`summarize_fast` have no frame input. `summarize_deep.focus` is emphasis, not filter. `research`/`corpus_answer`/`code_citation` have prompt-level abstention instructions but no structured `on_topic` field. The one place a relevance score *is* computed (corpus retrieval) is dropped at the corpus→evidence boundary before briefs see it. The arXiv-title seed failure reproduces here along this axis. |

**Headline:** ollama-intern-mcp cannot reproduce the *fabrication* shape of the seed failure (architectural absence of the relevant surfaces); it *can and will* reproduce the *relevance laundering* shape (architectural absence of the topicality concept). Operator docs over-promise content-grounding when the implementation delivers path/range-grounding — a third surface that compounds the relevance gap.

**For research-os specifically:** do not depend on ollama-intern-mcp's brief/extract/classify/summarize outputs as topic-bound evidence until the topicality gap (Required Fix #1) is closed. The current contract is "the cited chunk exists in this corpus"; research-os needs "the cited chunk addresses the section's frame." Those are different contracts.

---

## Boundary violations

**Source-truth boundary (Agent A) — minimal violations, all contained:**

1. **MEDIUM — `repo_pack` extracted facts not disk-validated.** `src/tools/packs/repoPack.ts:74-129` (schema), `:419-450` (extract call). `OnboardingFacts.entrypoints[].file` and `OnboardingFacts.config_files[]` are model-emitted unrestricted strings, written durably to artifacts and rendered as "facts." The prompt says "Do not invent values" (`:432`) — that's a rule, not a validator. This is the *only* place in the codebase where a model-fabricated path becomes a stored fact without operator-visible friction.
2. **LOW — `read_next[].file` in repo_brief unvalidated.** `src/tools/repoBrief.ts:67-70, 235-244`. Investigative by doc convention, but the field name implies a real file pointer.
3. **LOW — `affected_imports.from/.to` in multi_file_refactor.** `src/tools/multiFileRefactorPropose.ts:61-66`. `files[]` validated, imports aren't.
4. **LOW — Brief claim-to-evidence semantic grounding not server-checked.** `src/tools/incidentBrief.ts`, `repoBrief.ts`, `changeBrief.ts`. `evidence_refs` ids are validated; the claim text vs cited evidence content is honor-system.

**Relevance boundary (Agent B) — structural absence:**

5. **CRITICAL — `ollama_extract` has no frame input.** `src/tools/extract.ts:25-41, 49-61`. A cosmology paper handed to extract with a `claims[]` schema returns true cosmology claims regardless of the question those claims are meant to answer.
6. **HIGH — `ollama_classify` confidence is fit-of-label, not fit-of-topic.** `src/tools/classify.ts:47-71`. `allow_none + threshold` is label-fit, not on-topic-fit. A label set lacking an obvious match for off-topic source forces a low-confidence label or null; a label set that *accidentally* matches off-topic prose returns confident wrong answers.
7. **HIGH — `summarize_fast` no frame; `summarize_deep.focus` is emphasis not filter.** `src/tools/summarizeFast.ts:15-37`, `summarizeDeep.ts:40, 68-81`. Model is told to "emphasize" focus, not to abstain when source doesn't address it.
8. **HIGH — `ollama_research` no abstention enforcement.** `src/tools/research.ts:69-124`. Prompt asks for abstention; no structured `abstained: boolean` / `sources_address_question: boolean` field; empty `citations[]` + non-empty `answer` is silent.
9. **HIGH — `corpus_answer` 0-hit short-circuit works; sub-threshold-hit case doesn't.** `src/tools/corpusAnswer.ts:298-330` short-circuits at `hits.length === 0` (gold standard). But `weak: true` fires on `hits.length < 2` only — there is no topicality threshold above zero. Five off-topic chunks with `top_score=0.21` still drive full synthesis.
10. **MEDIUM — Retrieval relevance score dropped at corpus→evidence boundary.** `src/tools/briefs/evidence.ts:71-83` (`corpusHitsToEvidence`). The one place in the codebase where a real relevance signal exists (cosine/RRF score from `corpusSearch`) is *thrown away* before brief synthesis. Briefs see `{id, kind, ref, excerpt}` — no score. This is the highest-leverage architectural fix: it's a single function and it converts an existing signal into a usable one.

**Grounded-research boundary (Agent C) — one real gap, several minor:**

11. **MEDIUM — `ollama_research` has no abstention path / no ungrounded-answer flag.** (Same finding as #8, from a different angle.)
12. **MINOR — `line_range` not bounds-checked against the actual file in `research`.** `src/guardrails/citations.ts:36-42`. `code_citation` does check (`codeCitation.ts:186-189`); `research` doesn't.
13. **MINOR — Per-citation retrieval score dropped on `corpus_answer` output.** `src/tools/corpusAnswer.ts:79-91, 179-186`. Envelope-level `retrieval.top_score` is preserved; per-citation scores aren't.
14. **MINOR — Confidence not provenance-tagged.** `src/guardrails/confidence.ts:14-19`, `briefs/common.ts:145-148`. A `confidence` field reading as calibrated probability is in fact pure model self-report.

---

## Tools that must be renamed/reframed

Three tools' names or descriptions overstate their authority:

1. **`ollama_research` (Agent D D1.1, D2.1; A's #11; B's #8).** Name implies fetch+ground+cite. Implementation is grounded summarization over caller-supplied paths. The MCP description's "validated citations" (`src/index.ts:96`) reads as content-validated; it's path-validated only. Either:
   - Rename to `ollama_path_bound_synthesize` (honest), or
   - Add a server-pulled `excerpt: string` to each citation (matching `code_citation`) so "validated" earns its keep, or
   - At minimum, rewrite the description to disclose: "path-validated citations (server checks each cited file is in `source_paths`; it does NOT verify the answer is supported by the cited file's content)."

2. **`ollama_corpus_answer` description's claim "retrieved chunks ONLY" (Agent D D2.6).** `src/index.ts:112`. Prompted, not enforced. Mild overstatement; acceptable with a softer phrasing.

3. **`ollama_code_citation` (Agent D D1.2).** Excerpt is server-pulled (good), but the `claim_fragment ↔ excerpt` semantic link is honor-system. Name implies anchor-of-claim; reality is anchor-of-range-with-server-rendered-text. Description should disclose: "server validates the file is in source_paths and the line range is within file bounds; the claim being supported by the excerpt is the model's responsibility."

---

## Schema changes needed

Listed by leverage:

1. **`OnboardingFacts.entrypoints[].file` and `.config_files[]` (`repoPack.ts:74-129`):** validate against `input.source_paths` or on-disk scan; strip-and-warn out-of-scope entries. Mirror the `validateCitations` posture. (Highest-leverage source-truth fix.)

2. **Thread `frame: string` through `extract`/`classify`/`summarizeFast`/`summarizeDeep` (replacing `focus`-as-emphasis with `focus`-as-filter).** Add structured output fields:
   - `extract`: `_frame_alignment: { on_topic: boolean, reason: string, unaddressed_fields: string[] }`
   - `classify`: `off_topic: boolean, off_topic_reason: string | null`
   - `summarize_fast/deep`: `on_topic: boolean | null, unaddressed_sources: string[]`
   (Highest-leverage relevance fix. This is the structural change that closes the seed-failure replay for research-os.)

3. **Propagate `score` (and `why_matched`) through `corpusHitsToEvidence` in `briefs/evidence.ts:71-83`.** Add `score: number` to `EvidenceItem` when source is a corpus chunk. Add a threshold knob `corpus_min_evidence_score: number` to `assembleEvidence` so off-relevance corpus material doesn't silently become brief evidence. (Closes B's "the one signal we compute is the one we drop.")

4. **`ResearchResult`:** add `weak: boolean`, `abstained: boolean`, `sources_address_question: boolean | null` (parallel structure to `CodeCitationResult`'s `weak`). When `valid.length === 0` AND `answer` non-empty, set `weak: true` and add a coverage note. (Closes A's #11 and C's C1-F1.)

5. **`ResearchResult.citations` per-element `excerpt: string`** (server-pulled from the loaded file body at the cited line range, mirroring `code_citation`). Closes D's D3.1. Also do bounds-check on `line_range` while you're touching it (closes C's C2-F1).

6. **`CorpusAnswerCitation`:** add `score: number` (from `hits[idx].score`) and `embed_model: string` (from `corpus.model_version`). Per-citation provenance for retrieval. (Closes C's C2-F2 and C3-F1.)

7. **`classify` / brief `confidence` fields:** add a sibling `confidence_source: "model_self_report"` (no semantic change, just provenance). (Closes C's C4-F1.)

8. **Brief `Hypothesis`/`AffectedSurface`/etc.:** add `claim_supported_by_excerpt: string` (server-pulled snippet from each cited evidence id, concatenated short) — or rename `evidence_refs` → `evidence_refs_unverified` so the name reflects "ref-bound, not content-bound." (Closes D's D3.3.)

---

## Abstention/citation failures

**Where abstention works (do not regress):**
- `corpus_answer` 0-hit short-circuit, `corpusAnswer.ts:298-330` — does not invoke model when retrieval is empty.
- `corpus_answer` empty-query short-circuit, `corpusAnswer.ts:252-277` — refuses to even retrieve.
- `incident_brief` 0-evidence short-circuit, `incidentBrief.ts:204-233` — does not invoke model when no evidence was assembled.
- `corpus_answer` model emits integer citations only; out-of-range stripped server-side, citation identity built server-side. Cannot be fabricated.
- All three briefs validate evidence_refs as ids against a server-built map; unknown ids stripped.
- `code_citation` validates both path AND line range; emits server-rendered `excerpt`.

**Where abstention is missing:**
- `research` — no abstention path. Empty `citations[]` + prose answer is silent success.
- `corpus_answer` between 1 hit and threshold — no topicality threshold above zero. Sub-relevance synthesis proceeds.
- `extract` / `classify` / `summarize_fast` / `summarize_deep` — no frame, so no concept of "off-topic abstain."
- Briefs with mixed-relevance corpus chunks — no per-chunk relevance gate before evidence assembly.

**Where citation shape is contract-overstating:**
- `ResearchResult.citations: ValidatedCitation[]` (path + optional line_range, no excerpt, no bounds check).
- `CorpusAnswerCitation` (path + chunk_index, no excerpt, no score in envelope).
- Brief `evidence_refs: string[]` (ids validated, content binding not checked).

---

## Docs that overstate authority

Listed by operator-misleading impact:

1. **`README.md:103`** — *"Every claim in `answer` cites a chunk id validated server-side."* Triple overstatement: implies per-claim binding (only flat `citations[]` array exists), implies content-validation (only chunk-number-in-range is checked), and references a `chunk_id` field that doesn't exist in the actual return shape (real field is `chunk_index`). The README cathedral example at `README.md:101` shows `chunk_id` directly. **This is the single most operator-misleading sentence in the repo. Fix first.**

2. **`README.md:62-79`** — lead cathedral example shows `weak: false` and `evidence_count: 6` as a happy-path output with no caveat that `weak: false` means "more than 2 evidence items were fed," not "the hypotheses are vetted."

3. **`src/index.ts:96`** — `ollama_research` MCP description's "validated citations" + "stripped server-side" reads as content-validation. It is path-membership only.

4. **`README.md:271-281` (evidence laws section) and `docs/marketing-research.md:33` ("Evidence-first. No fiction.")** — describe a stronger contract than implementation enforces. Server validates id-string validity, not claim-content support. Acceptable as positioning if qualified; currently unqualified.

5. **`src/index.ts:120, 128, 136`** — brief descriptions claim `next_checks`/`read_next` are "INVESTIGATIVE, never prescriptive" / "Never remedial." These are prompted behaviors, not enforced. Lowercase the "Never."

6. **`README.md:81-83`** — *"It's deterministic: the renderer is code, not a prompt."* True of layout, false of content. Operators read it as a content-trust signal.

7. **Examples in `examples/simple-client-*.{js,py}` don't model "do not pass model output back into another model unverified."** Gap, not wrong example — but for a tool whose seed failure is "operator trusted output as fact," the absence of operator-discipline guidance is itself a contract gap.

---

## Required fixes before research-os depends on this behavior

Ordered by leverage and prerequisite chain:

**Tier 1 — blocks safe use as a research-os evidence worker:**

1. **Add `frame: string` to `extract` / `classify` / `summarize_fast` / `summarize_deep` and add structured `on_topic`/`off_topic_reason` (or `_frame_alignment`) fields to each tool's result.** Without this, every extract/classify/summarize call in a research-os pipeline launders relevance into authority. (B1.1, B1.2, B1.3, B2.1 — combined: schema change 2 above.)

2. **Propagate corpus retrieval score through `corpusHitsToEvidence` in `briefs/evidence.ts:71-83` and add a `corpus_min_evidence_score` knob to `assembleEvidence`.** The single function rewrite that converts an existing computed signal into a usable abstention input. (B2.6, B2.7, B2.8 — combined: schema change 3 above.)

3. **Add structured abstention to `ollama_research`**: `weak`, `abstained`, `sources_address_question` fields. When `citations.length === 0` AND `answer` non-empty, raise `weak: true` and a coverage note. (A's #11, B's #8, C's C1-F1, D's D2.1 — combined: schema change 4 above.)

**Tier 2 — closes the contract gaps the docs currently overstate:**

4. **Validate `OnboardingFacts.entrypoints[].file` and `.config_files[]` against `source_paths` in `repoPack.ts`.** (Schema change 1.)

5. **Add a topicality threshold above the 0-hit case in `corpus_answer`.** If `hits[0].score < threshold`, treat as the 0-hit case: short-circuit with abstention and a coverage note about top-score. (B2.3.)

6. **Add server-pulled `excerpt` to `ResearchResult.citations` + bounds-check `line_range`.** Makes "validated citations" content-bound, matches `code_citation`'s shape. (D3.1, C2-F1 — combined: schema change 5.)

**Tier 3 — doc + naming hygiene (no implementation change):**

7. **Fix the README cathedral example's `chunk_id` → `chunk_index` and rewrite the "validated server-side" sentence to disclose path/range-bound posture.** (D7, D4.2.)

8. **Rewrite `ollama_research` MCP description to disclose path-validation-not-content-validation.** Or rename. (D1.1, D2.1.)

9. **Add a `confidence_source: "model_self_report"` field next to `confidence` on `classify` and brief results.** (C4-F1.)

10. **Optionally:** unify the five per-tool citation-validation implementations into one `guardrails/citations.ts` module. (A's A4.1, C's C7-F1.) Ergonomic; closes the door on a future tool quietly forgetting to validate.

---

## Where research-os goes from here

ollama-intern-mcp is structurally incapable of reproducing the *fabrication* shape of the seed failure (no URL/title/paper surface to fabricate into). It IS currently capable of reproducing the *relevance* shape — the same outcome via a different mechanism. Either:

- **Patch ollama-intern-mcp** to surface relevance as a first-class concept (Tier 1 fixes above). Cost: medium — bounded code change, schema additions, no architectural rewrite. Benefit: the tool becomes safe to use as a topic-bound evidence worker, not just an atomic-task worker.

- **Or patch research-os** to gate every ollama-intern-mcp output through an upstream relevance check (its own retrieval-side topicality scorer, run BEFORE calling extract/classify/summarize/brief). Cost: equal or higher — research-os has to model what each tool's "frame" means and enforce it externally.

The first option keeps the contract local to the tool. The second pushes the contract back up into the orchestrator. The first is the higher-leverage choice if ollama-intern-mcp is going to be used by anything other than research-os in the future.

**Net assessment:** ollama-intern-mcp is well above the local-LLM-MCP category baseline on the fabrication axis and below it on the relevance axis. The fixes to close the relevance gap are bounded, listed, and don't require touching the existing fabrication guardrails. The seed failure is reachable today; it doesn't have to be.

---

## Swarm metadata

- **Agents:** 4 parallel general-purpose agents, read-only, scoped to role-contract only (no widening to bug/security/perf/test coverage).
- **Agent A — Source truth boundary:** verdict SAFE WITH CONSTRAINTS. Headline: no URL/fetch surface architecturally eliminates fabrication shape.
- **Agent B — Extraction relevance:** verdict UNSAFE. Headline: zero topicality representation in any schema; corpus relevance score dropped at corpus→evidence boundary.
- **Agent C — Grounded research:** verdict SAFE WITH CONSTRAINTS. Headline: `corpus_answer` gold-standard abstention; `ollama_research` lacks parallel structured abstention.
- **Agent D — Operator contract:** verdict SAFE WITH CONSTRAINTS. Headline: implementation honest, docs/names/schemas over-promise; `README.md:103` is the single most operator-misleading sentence.
- **Convergent finding:** `ollama_research` flagged by 3 of 4 agents from different angles. Highest-priority single tool to address.

---

## Slice outcome — 2026-05-11 (v2.2.0 unreleased)

A 3-agent implementation slice executed against this report's "Required fixes" list. Save-point tag `pre-role-contract-slice-2026-05-11` at commit `a9d0b38`. Result: 725/725 tests pass; typecheck + build clean; seed regression 9/9 against the literal fresh-pack cosmology fixture (`E:/AI/local-first-vs-cloud-research/evidence/excerpts/src_f080819ad5c1.jsonl`, arxiv 2112.10422 under the verbatim section-01 evidence-custody frame). Non-breaking additive minor.

### Implemented in the v2.2.0 slice (Tier 1 + most of Tier 2 + Tier 3 doc fixes)

- **Tier 1 #1 — Frame contract** on `extract` / `classify` / `summarize_fast` / `summarize_deep`: optional `frame: string` input + structured `frame_alignment` / `off_topic` / `on_topic` / `frame_addressed` outputs. Agent A.
- **Tier 1 #2 — Corpus score propagation** through `corpusHitsToEvidence` in `briefs/evidence.ts` + `corpus_min_evidence_score` knob on `assembleEvidence` and the three brief tools. Agent B.
- **Tier 1 #3 — Structured abstention** on `ollama_research`: `weak`, `abstained`, `sources_address_question`. Agent B.
- **Tier 2 #5 — Topicality threshold above 0-hit** on `ollama_corpus_answer` via optional `min_top_score`. Agent B.
- **Tier 2 #6 — `line_range` bounds-check** in `guardrails/citations.ts`. Agent B.
- **Tier 3 #7 — README:103 fix** (`chunk_id` → `chunk_index` + "validated server-side" rewrite) plus cathedral example caveats, Evidence Laws clarification, "Frame-bound extraction" + "Abstention contract" sections, CHANGELOG `## Unreleased — v2.2.0`, marketing-research slogan qualifier, handbook tool-row annotations. Agent C.
- **Tier 3 #9 — Per-citation `score`** on `CorpusAnswerCitation`. (Partial address of C2-F2 / C3-F1; `embed_model` traceability still deferred.)

### Deferred to v2.3.x

- **Tier 2 #4 — `OnboardingFacts.entrypoints[].file` / `.config_files[]` validation** in `repoPack.ts` (the source-truth MEDIUM finding A2.3). The only place in the codebase where a model-fabricated path becomes a stored fact without operator-visible friction.
- **Tier 2 #6 (partial) — Server-pulled `excerpt: string` on `ResearchResult.citations`** to mirror `code_citation`'s shape. Bounds-check landed; server-pulled excerpt did not.
- **Schema change #8 — Brief `claim_supported_by_excerpt: string` OR rename of `evidence_refs` to reflect "ref-bound, not content-bound."** Claim-to-evidence semantic grounding remains honor-system in briefs.
- **Tier 3 #9 (partial) — `confidence_source: "model_self_report"` provenance tag** on `classify` and brief `confidence` fields. Not addressed.
- **Tier 3 #10 — Citation validator unification** (the five per-tool implementations in `research.ts`, `corpusAnswer.ts`, `codeCitation.ts`, `briefs/common.ts`, `repoPack.ts`). Ergonomic; a future tool could quietly forget to validate.
- **Frame integration in brief tools for path / diff / log inputs.** The slice avoided over-coupling A and B in one PR — each brief's MCP description now tells operators to pre-filter via `extract --frame` before assembling source_paths. Deeper integration deferred.

### Cross-agent doctrine ratchet held

The locked coordination brief specified `unaddressed_aspects?: string[]` as the frame_alignment field name. Agent A implemented `unaddressed_aspects` consistently across code + tests + MCP description. Agent C's first-pass docs referenced `unaddressed_fields` (taken from this report's earlier "Schema changes needed" section, which used a different name). Coordinator caught the drift at the pre-commit review step and corrected docs to match the implementation. Recording the catch: cross-domain handoffs are tracked work items, not closeout footnotes.

### Path back to research-os

The slice closes step (1) of the held research-os v0.7.1 release path. Next session's work — local-build verification (`npm run build` against the post-slice tree; point research-os' MCP config at the local ollama-intern-mcp; re-run extraction on the fresh pack's sections 01 + 06 with the frame contract active; read the section-06 synthesis prose; judge useful) — is steps (2)–(6). Release authorization for v2.2.0 and research-os v0.7.1 follows successful verification, not the slice landing.
