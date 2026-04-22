/**
 * Tests for ollama_batch_proof_check.
 *
 * Locks:
 *   - happy path: two passing checks → all_passed=true, any_missing=false
 *   - missing tool: exit_code=127 OR not_found → status="missing", no failure cascade
 *   - timeout: timed_out → status="timeout"
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  handleBatchProofCheck,
  __setSpawner,
  type SpawnOutcome,
} from "../../src/tools/batchProofCheck.js";
import { PROFILES } from "../../src/profiles.js";
import { NullLogger } from "../../src/observability.js";
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

class InertClient implements OllamaClient {
  async generate(_r: GenerateRequest): Promise<GenerateResponse> { throw new Error("not used"); }
  async chat(_r: ChatRequest): Promise<ChatResponse> { throw new Error("not used"); }
  async embed(_r: EmbedRequest): Promise<EmbedResponse> { throw new Error("not used"); }
  async residency(_m: string): Promise<Residency | null> { return null; }
}

function makeCtx(): RunContext {
  return {
    client: new InertClient(),
    tiers: PROFILES["dev-rtx5080"].tiers,
    timeouts: PROFILES["dev-rtx5080"].timeouts,
    hardwareProfile: "dev-rtx5080",
    logger: new NullLogger(),
  };
}

afterEach(() => {
  __setSpawner(null);
});

function fakeOk(stdout = "", stderr = ""): SpawnOutcome {
  return {
    stdout,
    stderr,
    exit_code: 0,
    timed_out: false,
    not_found: false,
    elapsed_ms: 5,
  };
}

describe("ollama_batch_proof_check — happy path", () => {
  it("marks every passing check as 'pass' with all_passed=true", async () => {
    __setSpawner(async (cmd) => {
      // Every spawn returns exit 0.
      return fakeOk(`ran ${cmd}`, "");
    });
    const env = await handleBatchProofCheck(
      { checks: ["typescript", "eslint"] },
      makeCtx(),
    );
    expect(env.result.all_passed).toBe(true);
    expect(env.result.any_missing).toBe(false);
    expect(env.result.checks).toHaveLength(2);
    expect(env.result.checks.every((c) => c.status === "pass")).toBe(true);
  });
});

describe("ollama_batch_proof_check — missing tool", () => {
  it("reports missing (not fail) when exit_code=127", async () => {
    __setSpawner(async () => ({
      stdout: "",
      stderr: "command not found",
      exit_code: 127,
      timed_out: false,
      not_found: false,
      elapsed_ms: 2,
    }));
    const env = await handleBatchProofCheck(
      { checks: ["cargo-check"] },
      makeCtx(),
    );
    expect(env.result.checks[0].status).toBe("missing");
    expect(env.result.all_passed).toBe(false);
    expect(env.result.any_missing).toBe(true);
  });

  it("reports missing when spawn sets not_found=true (ENOENT)", async () => {
    __setSpawner(async () => ({
      stdout: "",
      stderr: "spawn ENOENT",
      exit_code: null,
      timed_out: false,
      not_found: true,
      elapsed_ms: 1,
    }));
    const env = await handleBatchProofCheck(
      { checks: ["ruff"] },
      makeCtx(),
    );
    expect(env.result.checks[0].status).toBe("missing");
    expect(env.result.any_missing).toBe(true);
  });
});

describe("ollama_batch_proof_check — timeout", () => {
  it("reports status='timeout' when the spawner signals timed_out", async () => {
    __setSpawner(async () => ({
      stdout: "",
      stderr: "",
      exit_code: null,
      timed_out: true,
      not_found: false,
      elapsed_ms: 60000,
    }));
    const env = await handleBatchProofCheck(
      { checks: ["pytest"], timeout_ms: 1000 },
      makeCtx(),
    );
    expect(env.result.checks[0].status).toBe("timeout");
    expect(env.result.all_passed).toBe(false);
  });
});

describe("ollama_batch_proof_check — failure parsing", () => {
  it("extracts per-file line failures from tsc-style output", async () => {
    __setSpawner(async () => ({
      stdout: "src/foo.ts:42:10 - error TS2322: Type 'string' is not assignable to type 'number'.\n",
      stderr: "",
      exit_code: 1,
      timed_out: false,
      not_found: false,
      elapsed_ms: 50,
    }));
    const env = await handleBatchProofCheck(
      { checks: ["typescript"] },
      makeCtx(),
    );
    expect(env.result.checks[0].status).toBe("fail");
    expect(env.result.checks[0].failures && env.result.checks[0].failures.length > 0).toBe(true);
  });
});
