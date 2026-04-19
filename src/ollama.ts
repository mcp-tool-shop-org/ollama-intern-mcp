/**
 * Ollama HTTP client — generate, embed, residency probe (/api/ps).
 *
 * Every call is guarded by the global semaphore. Timeouts via AbortController.
 * Residency probe runs on every call so the envelope can surface eviction
 * without the caller asking. This is what prevents silent 5–10× slowdowns
 * from hiding behind polished output.
 */

import { ollamaSemaphore } from "./semaphore.js";
import { InternError } from "./errors.js";
import type { Residency } from "./envelope.js";

const API_TIMEOUT_MS = 10_000;

export interface GenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  format?: "json";
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_p?: number;
  };
  /**
   * Thinking-mode toggle (Ollama 2026 API, added for Qwen 3 / DeepSeek R1 / etc.).
   * `false` suppresses CoT and keeps the `response` field tight; `true` lets
   * the model reason before answering (CoT goes into the `thinking` response
   * field, not `response`). Non-thinking models (e.g. hermes3:8b) ignore it.
   *
   * Load-bearing on Qwen 3: leaving thinking on for short-output tasks
   * (classify/extract/triage/summarize) causes `response` to come back empty
   * when num_predict gets consumed by thinking tokens. The prompt-level
   * `/no_think` soft-switch is IGNORED by Ollama — only this field works.
   */
  think?: boolean;
  /** Keep model resident for this long. "-1" = forever. */
  keep_alive?: string | number;
}

export interface GenerateResponse {
  model: string;
  response: string;
  /**
   * CoT content, populated when the request had think=true and the model
   * supports thinking. Separate from `response` — never concatenate.
   */
  thinking?: string;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  eval_duration?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  format?: "json";
  stream?: boolean;
  options?: GenerateRequest["options"];
  keep_alive?: string | number;
}

export interface ChatResponse {
  model: string;
  message: ChatMessage;
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface EmbedRequest {
  model: string;
  input: string | string[];
  keep_alive?: string | number;
}

export interface EmbedResponse {
  model: string;
  embeddings: number[][];
}

export interface PsModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  digest: string;
  expires_at: string;
}

export interface PsResponse {
  models: PsModel[];
}

export interface OllamaClient {
  generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse>;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse>;
  residency(model: string): Promise<Residency | null>;
}

/**
 * Normalize an OLLAMA_HOST value.
 *
 * Ollama's CLI accepts `127.0.0.1:11434` (no scheme) and routes Windows users
 * often set it that way. fetch() requires a full URL, so we coerce anything
 * that looks like host[:port] into a proper http:// URL, and strip trailing
 * slashes so path concatenation stays clean.
 */
export function normalizeOllamaHost(raw: string | undefined): string {
  const fallback = "http://127.0.0.1:11434";
  const value = (raw ?? "").trim();
  if (!value) return fallback;
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, "");
}

export class HttpOllamaClient implements OllamaClient {
  private baseUrl: string;
  constructor(baseUrl?: string) {
    this.baseUrl = normalizeOllamaHost(baseUrl ?? process.env.OLLAMA_HOST);
  }

  async generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
    return this.post<GenerateRequest, GenerateResponse>("/api/generate", { ...req, stream: false }, signal);
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.post<ChatRequest, ChatResponse>("/api/chat", { ...req, stream: false }, signal);
  }

  async embed(req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResponse> {
    return this.post<EmbedRequest, EmbedResponse>("/api/embed", req, signal);
  }

  async residency(model: string): Promise<Residency | null> {
    try {
      const ps = await this.get<PsResponse>("/api/ps");
      const hit = ps.models.find((m) => m.name === model || m.model === model);
      if (!hit) return null;
      const evicted = hit.size_vram < hit.size;
      return {
        in_vram: !evicted,
        size_bytes: hit.size,
        size_vram_bytes: hit.size_vram,
        evicted,
        expires_at: hit.expires_at ?? null,
      };
    } catch {
      return null;
    }
  }

  private async post<TReq, TRes>(path: string, body: TReq, signal?: AbortSignal): Promise<TRes> {
    const release = await ollamaSemaphore.acquire();
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 404) {
          throw new InternError(
            "OLLAMA_MODEL_MISSING",
            `Model not found (404): ${text}`,
            "Run `ollama pull <model>` — see README for the full tier list.",
            false,
          );
        }
        throw new InternError(
          "OLLAMA_UNREACHABLE",
          `Ollama returned ${res.status}: ${text}`,
          "Check that Ollama is running (`ollama serve`) and reachable at OLLAMA_HOST.",
          true,
        );
      }
      return (await res.json()) as TRes;
    } catch (err) {
      if (err instanceof InternError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new InternError("OLLAMA_TIMEOUT", "Ollama request aborted", "Tier timeout fired — see fallback in envelope.", true);
      }
      throw new InternError(
        "OLLAMA_UNREACHABLE",
        `Failed to reach Ollama: ${(err as Error).message}`,
        "Check that Ollama is running at OLLAMA_HOST (default http://127.0.0.1:11434).",
        true,
      );
    } finally {
      release();
    }
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) {
        throw new InternError("OLLAMA_UNREACHABLE", `Ollama GET ${path} → ${res.status}`, "Check Ollama is running.", true);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function countTokens(resp: { prompt_eval_count?: number; eval_count?: number }): {
  in: number;
  out: number;
} {
  return { in: resp.prompt_eval_count ?? 0, out: resp.eval_count ?? 0 };
}
