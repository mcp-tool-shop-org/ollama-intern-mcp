/**
 * Handler registry — maps tool name -> (schema, handler).
 *
 * The skill runner dispatches by tool name. Keeping this separate from
 * src/index.ts means the registry can be built once and reused across
 * skill executions, and tests can substitute fake handlers for unit
 * coverage without spinning up an MCP server.
 *
 * Every tool in the registry must already exist in src/index.ts — the
 * registry does not create new surface area, it just lets skills
 * reference the existing one.
 */

import type { ZodTypeAny } from "zod";
import type { Envelope } from "../envelope.js";
import type { RunContext } from "../runContext.js";

import { classifySchema, handleClassify } from "../tools/classify.js";
import { triageLogsSchema, handleTriageLogs } from "../tools/triageLogs.js";
import { summarizeFastSchema, handleSummarizeFast } from "../tools/summarizeFast.js";
import { summarizeDeepSchema, handleSummarizeDeep } from "../tools/summarizeDeep.js";
import { draftSchema, handleDraft } from "../tools/draft.js";
import { extractSchema, handleExtract } from "../tools/extract.js";
import { researchSchema, handleResearch } from "../tools/research.js";
import { embedSchema, handleEmbed } from "../tools/embed.js";
import { embedSearchSchema, handleEmbedSearch } from "../tools/embedSearch.js";
import { corpusIndexSchema, handleCorpusIndex } from "../tools/corpusIndex.js";
import { corpusSearchSchema, handleCorpusSearch } from "../tools/corpusSearch.js";
import { corpusAnswerSchema, handleCorpusAnswer } from "../tools/corpusAnswer.js";
import { corpusRefreshSchema, handleCorpusRefresh } from "../tools/corpusRefresh.js";
import { corpusListSchema, handleCorpusList } from "../tools/corpusList.js";
import { incidentBriefSchema, handleIncidentBrief } from "../tools/incidentBrief.js";
import { repoBriefSchema, handleRepoBrief } from "../tools/repoBrief.js";
import { changeBriefSchema, handleChangeBrief } from "../tools/changeBrief.js";
import { incidentPackSchema, handleIncidentPack } from "../tools/packs/incidentPack.js";
import { repoPackSchema, handleRepoPack } from "../tools/packs/repoPack.js";
import { changePackSchema, handleChangePack } from "../tools/packs/changePack.js";
import { chatSchema, handleChat } from "../tools/chat.js";

export type AnyHandler = (input: unknown, ctx: RunContext) => Promise<Envelope<unknown>>;

export interface HandlerEntry {
  schema: ZodTypeAny;
  handler: AnyHandler;
}

function entry<I>(
  schema: ZodTypeAny,
  handler: (input: I, ctx: RunContext) => Promise<Envelope<unknown>>,
): HandlerEntry {
  return { schema, handler: handler as AnyHandler };
}

/**
 * Skill-callable tools. Excludes artifact tools (read-only filesystem ops that
 * don't belong inside a pipeline) and the future skill_* tools (prevents
 * accidental recursion in v0.1; Phase 2 can revisit).
 */
export const SKILL_HANDLERS: Record<string, HandlerEntry> = {
  ollama_classify: entry(classifySchema, handleClassify),
  ollama_triage_logs: entry(triageLogsSchema, handleTriageLogs),
  ollama_summarize_fast: entry(summarizeFastSchema, handleSummarizeFast),
  ollama_summarize_deep: entry(summarizeDeepSchema, handleSummarizeDeep),
  ollama_draft: entry(draftSchema, handleDraft),
  ollama_extract: entry(extractSchema, handleExtract),
  ollama_research: entry(researchSchema, handleResearch),
  ollama_embed: entry(embedSchema, handleEmbed),
  ollama_embed_search: entry(embedSearchSchema, handleEmbedSearch),
  ollama_corpus_index: entry(corpusIndexSchema, handleCorpusIndex),
  ollama_corpus_search: entry(corpusSearchSchema, handleCorpusSearch),
  ollama_corpus_answer: entry(corpusAnswerSchema, handleCorpusAnswer),
  ollama_corpus_refresh: entry(corpusRefreshSchema, handleCorpusRefresh),
  ollama_corpus_list: entry(corpusListSchema, handleCorpusList),
  ollama_incident_brief: entry(incidentBriefSchema, handleIncidentBrief),
  ollama_repo_brief: entry(repoBriefSchema, handleRepoBrief),
  ollama_change_brief: entry(changeBriefSchema, handleChangeBrief),
  ollama_incident_pack: entry(incidentPackSchema, handleIncidentPack),
  ollama_repo_pack: entry(repoPackSchema, handleRepoPack),
  ollama_change_pack: entry(changePackSchema, handleChangePack),
  ollama_chat: entry(chatSchema, handleChat),
};

export function listSkillCallableTools(): string[] {
  return Object.keys(SKILL_HANDLERS).sort();
}
