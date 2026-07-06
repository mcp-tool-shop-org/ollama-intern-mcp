/**
 * Embed-rail timeout guardrail (H4-res / 2026-07 health pass).
 *
 * Embeddings are local-only (Ollama Cloud serves no embed models), so they
 * don't go through the cloud/local routing or the tier-fallback cascade. But
 * they DO acquire the same global Ollama semaphore permit in `post()` as
 * generate/chat, and every embed call site historically passed no AbortSignal
 * — so a wedged or cold-loading embed model could hold a permit for the full
 * undici header-timeout x transparent-retries (minutes), starving every other
 * tool. That is the embed sibling of the H4 `ollama_chat` defect.
 *
 * `embedWithTimeout` wraps a single embed call in an AbortController bounded by
 * the embed tier budget, mirroring the generate/chat contract in
 * `guardrails/timeouts.ts`. On timeout it aborts (the H1 abort-aware semaphore
 * dequeues a still-queued waiter; a fetch-in-flight is cancelled) and throws a
 * structured `OLLAMA_TIMEOUT` — the SAME code the queued-abort and fetch-abort
 * paths already emit, so callers classify it uniformly. There is no tier
 * cascade: embed is a single tier with no cheaper fallback.
 *
 * The budget defaults to the canonical `TIER_TIMEOUT_MS.embed`; handler sites
 * that carry a `RunContext` pass the active profile's `ctx.timeouts.embed` so an
 * operator override is honored.
 */

import type { OllamaClient, EmbedRequest, EmbedResponse } from "../ollama.js";
import { InternError } from "../errors.js";
import type { Logger } from "../observability.js";
import { timestamp } from "../observability.js";
import { TIER_TIMEOUT_MS } from "../tiers.js";

export interface EmbedTimeoutOptions {
  /** Tool name for the timeout log event. Default "ollama_embed". */
  tool?: string;
  /** Logger for the timeout event (fire-and-forget). Optional. */
  logger?: Logger;
}

/**
 * Run one embed call bounded by `budgetMs` (default `TIER_TIMEOUT_MS.embed`).
 * Throws `OLLAMA_TIMEOUT` if the budget elapses; re-throws any other error
 * unchanged.
 */
export async function embedWithTimeout(
  client: OllamaClient,
  req: EmbedRequest,
  budgetMs: number = TIER_TIMEOUT_MS.embed,
  opts: EmbedTimeoutOptions = {},
): Promise<EmbedResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);
  try {
    return await client.embed(req, controller.signal, "embed");
  } catch (err) {
    // Only remap the abort WE caused (the budget timer). A caller-propagated
    // abort or any other embed error surfaces unchanged.
    if (timedOut) {
      void opts.logger?.log({
        kind: "timeout",
        ts: timestamp(),
        tool: opts.tool ?? "ollama_embed",
        tier: "embed",
        timeout_ms: budgetMs,
      });
      throw new InternError(
        "OLLAMA_TIMEOUT",
        `Embed timed out after ${budgetMs}ms on tier embed`,
        "The embed model may be cold-loading or the Ollama host is saturated. Raise the embed tier timeout, reduce the batch size, or check 'ollama ps' for a wedged in-flight call.",
        true,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
