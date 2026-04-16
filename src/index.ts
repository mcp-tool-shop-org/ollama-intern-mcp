#!/usr/bin/env node

/**
 * Ollama Intern MCP — entrypoint.
 *
 * Registers the 8-tool labor surface. Tool descriptions encode *when* to reach
 * for them — Claude picks the tier by picking the tool, and the tool implies
 * the model. ollama_chat is visibly last-resort.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VERSION } from "./version.js";
import { loadTierConfig } from "./tiers.js";
import { HttpOllamaClient, type OllamaClient } from "./ollama.js";
import { NdjsonLogger, type Logger } from "./observability.js";
import { toErrorShape } from "./errors.js";

import { classifySchema, handleClassify } from "./tools/classify.js";
import { triageLogsSchema, handleTriageLogs } from "./tools/triageLogs.js";
import { summarizeFastSchema, handleSummarizeFast } from "./tools/summarizeFast.js";
import { summarizeDeepSchema, handleSummarizeDeep } from "./tools/summarizeDeep.js";
import { draftSchema, handleDraft } from "./tools/draft.js";
import { extractSchema, handleExtract } from "./tools/extract.js";
import { researchSchema, handleResearch } from "./tools/research.js";
import { embedSchema, handleEmbed } from "./tools/embed.js";
import { chatSchema, handleChat } from "./tools/chat.js";

export interface ServerDeps {
  client: OllamaClient;
  tierConfig: ReturnType<typeof loadTierConfig>;
  logger: Logger;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: "ollama-intern-mcp", version: VERSION });

  const wrap = <T>(p: Promise<T>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> =>
    p.then(
      (value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }),
      (err) => ({
        content: [{ type: "text" as const, text: JSON.stringify(toErrorShape(err), null, 2) }],
        isError: true as const,
      }),
    );

  // FLAGSHIP — ollama_research
  server.tool(
    "ollama_research",
    "FLAGSHIP. Answer a question grounded in specific files. Takes FILE PATHS (not raw text) — reads and chunks locally, returns a digest with validated citations. Use this to understand a repo/doc without burning Claude context on the full content. Citations outside source_paths are stripped server-side.",
    researchSchema.shape,
    (args) => wrap(handleResearch(args, deps)),
  );

  // FLAGSHIP — ollama_embed
  server.tool(
    "ollama_embed",
    "FLAGSHIP. Produce vector embeddings for one text or a batch. Bridge from filename search to concept search over memory/, canon, doctrine, protocols. Returns model_version alongside vectors so drift is detectable.",
    embedSchema.shape,
    (args) => wrap(handleEmbed(args, deps)),
  );

  // Core — classify
  server.tool(
    "ollama_classify",
    "Single-label classification with confidence. Use for commit-type / severity / yes-no bucketing. Set allow_none=true when weak guesses are worse than 'unsure' — label returns null below threshold (default 0.7).",
    classifySchema.shape,
    (args) => wrap(handleClassify(args, deps)),
  );

  // Core — triage_logs
  server.tool(
    "ollama_triage_logs",
    "Stable-shape log digest: {errors, warnings, suspected_root_cause}. Use before grep-storms on long CI/test output. Returns deduplicated error strings without stack traces.",
    triageLogsSchema.shape,
    (args) => wrap(handleTriageLogs(args, deps)),
  );

  // Core — summarize_fast
  server.tool(
    "ollama_summarize_fast",
    "Gist of short input (best under ~4k tokens). Use as a decision gate: 'is this file worth reading in full?' Summary carries source_preview so you can spot-check fabrication.",
    summarizeFastSchema.shape,
    (args) => wrap(handleSummarizeFast(args, deps)),
  );

  // Core — summarize_deep
  server.tool(
    "ollama_summarize_deep",
    "Digest of long input (~32k tokens) with optional focus. Use for doctrine/canon/long-doc distillation when Claude only needs the gist. Carries source_preview.",
    summarizeDeepSchema.shape,
    (args) => wrap(handleSummarizeDeep(args, deps)),
  );

  // Core — draft
  server.tool(
    "ollama_draft",
    "DRAFT code or prose stubs (never autonomous — Claude reviews). Pass language for a server-side compile check: envelope returns {compiles, checker, stderr_tail}. target_path pointing into memory/, .claude/, docs/canon/, games/ requires confirm_write: true.",
    draftSchema.shape,
    (args) => wrap(handleDraft(args, deps)),
  );

  // Core — extract
  server.tool(
    "ollama_extract",
    "Schema-constrained JSON extraction using Ollama's JSON mode. Returns {ok: true, data} or {ok: false, error: 'unparseable'} — never partial.",
    extractSchema.shape,
    (args) => wrap(handleExtract(args, deps)),
  );

  // Last resort — chat
  server.tool(
    "ollama_chat",
    "LAST RESORT catch-all. Prefer a specialty tool above when one fits. If you reach for this often, a specialty tool is missing and should be added.",
    chatSchema.shape,
    (args) => wrap(handleChat(args, deps)),
  );

  return server;
}

async function main(): Promise<void> {
  const deps: ServerDeps = {
    client: new HttpOllamaClient(),
    tierConfig: loadTierConfig(),
    logger: new NdjsonLogger(),
  };
  const server = createServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run only when invoked as a script (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1] ?? "");
if (isMain) {
  main().catch((err) => {
    console.error(JSON.stringify(toErrorShape(err), null, 2));
    process.exit(1);
  });
}
