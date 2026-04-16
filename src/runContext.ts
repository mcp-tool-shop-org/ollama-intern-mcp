/**
 * Shared dependencies every tool handler needs.
 *
 * Passing one RunContext is cleaner than threading 3+ positional args,
 * and gives us a stable shape to extend later (metrics, tracing, etc.)
 * without touching 8 call sites.
 */

import type { OllamaClient } from "./ollama.js";
import type { TierConfig } from "./tiers.js";
import type { Logger } from "./observability.js";

export interface RunContext {
  client: OllamaClient;
  /** Concrete tier→model picks from the active Profile. */
  tiers: TierConfig;
  /** Profile name written onto every envelope + NDJSON line. */
  hardwareProfile: string;
  logger: Logger;
}
