/**
 * `doctor --cloud-check` — the only in-product proof that a cloud key works.
 *
 * Wave-11 (F-34227a72) added this because the existing cloud probe hits
 * `/api/tags`, which returns 200 for an INVALID key — so `auth` could only
 * ever read "unverified" and an operator had no way to tell a bad key from a
 * working one until a real call failed.
 *
 * The module shipped untested. These tests pin the contracts that carry the
 * operator's trust: the four-state verdict (collapsing any pair of them sends
 * someone hunting the wrong problem), the gate rule, catalog comparison, and
 * the nearest-id suggestion. Network-free: the generate path is a stub.
 */

import { describe, it, expect } from "vitest";
import {
  nearestModelId,
  compareCatalog,
  shouldGate,
  type CloudCheckResult,
} from "../src/cloudCheck.js";

/** Minimal CloudCheckResult for the pure-predicate tests. */
function result(over: Partial<CloudCheckResult>): CloudCheckResult {
  return {
    host: "https://ollama.com",
    mode: "standby",
    auth: "ok",
    model_requested: "qwen3-coder-next:cloud",
    latency_ms: 12,
    ...over,
  } as CloudCheckResult;
}

describe("nearestModelId — the suggestion when a pinned id is gone", () => {
  it("matches on base name first: the real miss is a dropped :cloud tag", () => {
    // Cloud ids rotate server-side and the commonest operator error is
    // pinning the local spelling of a cloud model.
    expect(nearestModelId("qwen3-coder-next", ["qwen3-coder-next:cloud", "glm-4.6:cloud"])).toBe(
      "qwen3-coder-next:cloud",
    );
  });

  it("falls back to a near-miss when no base name matches", () => {
    expect(nearestModelId("glm-4.5:cloud", ["glm-4.6:cloud"])).toBe("glm-4.6:cloud");
  });

  it("suggests nothing rather than something misleading when nothing is close", () => {
    // A wrong suggestion is worse than none: it sends the operator to pin an
    // id that is not the one they meant.
    expect(nearestModelId("qwen3-coder-next:cloud", ["totally-unrelated:cloud"])).toBeUndefined();
  });

  it("suggests nothing against an empty catalog", () => {
    expect(nearestModelId("anything:cloud", [])).toBeUndefined();
  });
});

describe("compareCatalog — report, never enforce", () => {
  const configured = [
    { source: "INTERN_CLOUD_MODEL", id: "qwen3-coder-next:cloud" },
    { source: "INTERN_CLOUD_DEEP_MODEL", id: "minimax-m3:cloud" },
  ];

  it("marks a configured id present when the backend lists it", () => {
    const out = compareCatalog(configured, ["qwen3-coder-next:cloud", "minimax-m3:cloud"]);
    expect(out.every((e) => e.status === "present")).toBe(true);
  });

  it("marks a retired id missing and names the nearest live one", () => {
    const out = compareCatalog(configured, ["qwen3-coder-next:cloud", "minimax-m4:cloud"]);
    const deep = out.find((e) => e.source === "INTERN_CLOUD_DEEP_MODEL");
    expect(deep?.status).toBe("missing");
    expect(deep?.suggestion).toBe("minimax-m4:cloud");
  });

  it("claims NOTHING when the catalog could not be read", () => {
    // `unknown` is the honest state. Reporting `missing` on an unreadable
    // catalog would tell an operator to re-pin a model that is fine.
    const out = compareCatalog(configured, null);
    expect(out.every((e) => e.status === "unknown")).toBe(true);
    expect(out.every((e) => e.suggestion === undefined)).toBe(true);
  });

  it("de-dupes by id so the one divergent knob is not buried", () => {
    // INTERN_CLOUD_MODEL serves instant+workhorse+deep by default; printing
    // the same id three times hides the deep override when it differs.
    const same = [
      { source: "INTERN_CLOUD_MODEL", id: "qwen3-coder-next:cloud" },
      { source: "INTERN_CLOUD_DEEP_MODEL", id: "qwen3-coder-next:cloud" },
    ];
    const out = compareCatalog(same, ["qwen3-coder-next:cloud"]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("INTERN_CLOUD_MODEL");
  });
});

describe("shouldGate — what may fail --fail-unhealthy", () => {
  it("gates on a definitively bad key", () => {
    expect(shouldGate(result({ auth: "failed" }))).toBe(true);
  });

  it("gates on unverified — an unusable config is not a passing state", () => {
    expect(shouldGate(result({ auth: "unverified" }))).toBe(true);
  });

  it("does NOT gate on a proven key", () => {
    expect(shouldGate(result({ auth: "ok" }))).toBe(false);
  });

  it("does NOT gate on an outage — unreachable is not operator misconfiguration", () => {
    // A CI job must not go red because ollama.com had a bad minute.
    expect(shouldGate(result({ auth: "unreachable" }))).toBe(false);
  });

  it("does NOT gate on a catalog miss even when the key verified", () => {
    // The catalog lookup is advisory: a false negative failing CI on a model
    // the backend would have served is worse than the miss it reports.
    const r = result({
      auth: "ok",
      catalog: {
        status: "ok",
        size: 1,
        entries: [
          { source: "INTERN_CLOUD_MODEL", id: "gone:cloud", status: "missing" },
        ],
      },
    } as Partial<CloudCheckResult>);
    expect(shouldGate(r)).toBe(false);
  });
});
