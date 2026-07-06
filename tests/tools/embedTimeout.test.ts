/**
 * H4-res (2026-07 health pass) — the embed rail must be bounded by an
 * application-level timeout, like generate/chat. An un-timed embed holds an
 * Ollama semaphore permit for up to the undici header-timeout x retries — long
 * enough to starve every other tool. handleEmbed (and the other embed sites)
 * now thread a tier-bounded signal via embedWithTimeout.
 */

import { describe, it, expect } from "vitest";
import { handleEmbed } from "../../src/tools/embed.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
import { InternError } from "../../src/errors.js";
import type {
  OllamaClient,
  GenerateRequest,
  GenerateResponse,
  ChatRequest,
  ChatResponse,
  EmbedRequest,
  EmbedResponse,
} from "../../src/ollama.js";
import type { Residency } from "../../src/envelope.js";
import type { RunContext } from "../../src/runContext.js";

/** An embed that hangs until its AbortSignal fires (a wedged / cold-loading model). */
class HangingEmbedMock implements OllamaClient {
  public embedCalls = 0;
  public lastSignalAborted: boolean | undefined;
  async generate(_r: GenerateRequest): Promise<GenerateResponse> {
    throw new Error("not used");
  }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    throw new Error("not used");
  }
  async embed(_req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse> {
    this.embedCalls += 1;
    return new Promise<EmbedResponse>((_resolve, reject) => {
      const abort = (): void => {
        this.lastSignalAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async residency(_m: string): Promise<Residency | null> {
    return { in_vram: true, size_bytes: 1, size_vram_bytes: 1, evicted: false, expires_at: null };
  }
}

function makeCtx(client: OllamaClient, embedTimeoutMs: number): RunContext {
  return {
    client,
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: { ...PROFILES["dev-rtx5080"].timeouts, embed: embedTimeoutMs },
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

describe("ollama_embed — bounded by the embed tier timeout (H4-res)", () => {
  it("a hung embed aborts at the embed budget and surfaces OLLAMA_TIMEOUT (no un-timed semaphore permit)", async () => {
    const client = new HangingEmbedMock();
    let thrown: unknown = null;
    try {
      await handleEmbed({ input: "hello" }, makeCtx(client, 50));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InternError);
    expect((thrown as InternError).code).toBe("OLLAMA_TIMEOUT");
    // The embed WAS invoked, and it was the bounded signal (not undici's) that
    // ended it — proving the application-level budget is what fired.
    expect(client.embedCalls).toBe(1);
    expect(client.lastSignalAborted).toBe(true);
  });
});
