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
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { VERSION } from "./version.js";
import { loadProfile } from "./profiles.js";
import { HttpOllamaClient } from "./ollama.js";
import { NdjsonLogger } from "./observability.js";
import { toErrorShape } from "./errors.js";
import { runPrewarm } from "./prewarm.js";
import type { RunContext } from "./runContext.js";

import { classifySchema, handleClassify } from "./tools/classify.js";
import { triageLogsSchema, handleTriageLogs } from "./tools/triageLogs.js";
import { summarizeFastSchema, handleSummarizeFast } from "./tools/summarizeFast.js";
import { summarizeDeepSchema, handleSummarizeDeep } from "./tools/summarizeDeep.js";
import { draftSchema, handleDraft } from "./tools/draft.js";
import { extractSchema, handleExtract } from "./tools/extract.js";
import { researchSchema, handleResearch } from "./tools/research.js";
import { embedSchema, handleEmbed } from "./tools/embed.js";
import { chatSchema, handleChat } from "./tools/chat.js";

export function createServer(ctx: RunContext): McpServer {
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
    (args) => wrap(handleResearch(args, ctx)),
  );

  // FLAGSHIP — ollama_embed
  server.tool(
    "ollama_embed",
    "FLAGSHIP. Produce vector embeddings for one text or a batch. Bridge from filename search to concept search over memory/, canon, doctrine, protocols. Returns model_version alongside vectors so drift is detectable.",
    embedSchema.shape,
    (args) => wrap(handleEmbed(args, ctx)),
  );

  // Core — classify
  server.tool(
    "ollama_classify",
    "Single-label classification with confidence. Use for commit-type / severity / yes-no bucketing. Set allow_none=true when weak guesses are worse than 'unsure' — label returns null below threshold (default 0.7).",
    classifySchema.shape,
    (args) => wrap(handleClassify(args, ctx)),
  );

  // Core — triage_logs
  server.tool(
    "ollama_triage_logs",
    "Stable-shape log digest: {errors, warnings, suspected_root_cause}. Use before grep-storms on long CI/test output. Returns deduplicated error strings without stack traces.",
    triageLogsSchema.shape,
    (args) => wrap(handleTriageLogs(args, ctx)),
  );

  // Core — summarize_fast
  server.tool(
    "ollama_summarize_fast",
    "Gist of short input (best under ~4k tokens). Use as a decision gate: 'is this file worth reading in full?' Summary carries source_preview so you can spot-check fabrication.",
    summarizeFastSchema.shape,
    (args) => wrap(handleSummarizeFast(args, ctx)),
  );

  // Core — summarize_deep
  server.tool(
    "ollama_summarize_deep",
    "Digest of long input (~32k tokens) with optional focus. Use for doctrine/canon/long-doc distillation when Claude only needs the gist. Carries source_preview.",
    summarizeDeepSchema.shape,
    (args) => wrap(handleSummarizeDeep(args, ctx)),
  );

  // Core — draft
  server.tool(
    "ollama_draft",
    "DRAFT code or prose stubs (never autonomous — Claude reviews). Pass language for a server-side compile check: envelope returns {compiles, checker, stderr_tail}. target_path pointing into memory/, .claude/, docs/canon/, games/ requires confirm_write: true.",
    draftSchema.shape,
    (args) => wrap(handleDraft(args, ctx)),
  );

  // Core — extract
  server.tool(
    "ollama_extract",
    "Schema-constrained JSON extraction using Ollama's JSON mode. Returns {ok: true, data} or {ok: false, error: 'unparseable'} — never partial.",
    extractSchema.shape,
    (args) => wrap(handleExtract(args, ctx)),
  );

  // Last resort — chat
  server.tool(
    "ollama_chat",
    "LAST RESORT catch-all. Prefer a specialty tool above when one fits. If you reach for this often, a specialty tool is missing and should be added.",
    chatSchema.shape,
    (args) => wrap(handleChat(args, ctx)),
  );

  return server;
}

async function main(): Promise<void> {
  const profile = loadProfile();
  const ctx: RunContext = {
    client: new HttpOllamaClient(),
    tiers: profile.tiers,
    timeouts: profile.timeouts,
    hardwareProfile: profile.name,
    logger: new NdjsonLogger(),
  };

  // Profile-policy prewarm: pulls Instant tier into VRAM on dev profiles
  // before connecting transport, so the first real Claude call doesn't eat
  // cold-load latency. Failures are logged but never throw — server startup
  // must not depend on Ollama being reachable.
  if (profile.prewarm.length > 0) {
    await runPrewarm(ctx, profile.prewarm);
  }

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Run main() only when invoked as a script, not when imported by tests.
 *
 * Robust-on-Windows check: normalize both sides through realpathSync +
 * fileURLToPath so forward/backslash and symlink differences don't cause
 * the script to no-op silently (which is what Claude Code would see as
 * "connected then immediately disconnected").
 */
function isInvokedAsScript(): boolean {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isInvokedAsScript()) {
  main().catch((err) => {
    console.error(JSON.stringify(toErrorShape(err), null, 2));
    process.exit(1);
  });
}
