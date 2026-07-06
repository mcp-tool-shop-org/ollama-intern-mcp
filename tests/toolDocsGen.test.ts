/**
 * Handbook tool-docs invariant (A2, v2.9.1).
 *
 * Every registered ollama_* tool must have a handbook page, and generated
 * pages must be byte-identical to a fresh docgen run — a schema change
 * without a docs regen fails here (and in the CI lockfile-sync leg, which
 * runs the same --check against the committed lockfile's zod, where the
 * JSON-schema key order is deterministic).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

beforeAll(() => {
  if (!existsSync(resolve(REPO, "dist/index.js"))) {
    throw new Error("dist not built. Run `npm run build` before the tool-docs tests.");
  }
});

describe("handbook tool docs — generated pages", () => {
  it("gen-tool-docs --check passes: every tool has a page and generated pages match a fresh run", () => {
    // Throws with the script's drift report when any page is missing,
    // drifted, or orphaned (a stale page for a renamed/removed tool).
    execFileSync(process.execPath, [resolve(REPO, "scripts/gen-tool-docs.mjs"), "--check"], {
      cwd: REPO,
      encoding: "utf8",
    });
  });

  it("page count matches the registry count (no hand-synced number)", () => {
    const src = readFileSync(resolve(REPO, "src/index.ts"), "utf8");
    // Same registry line-count heuristic sync-doc-versions.mjs guards with.
    const registered = (src.match(/^\s+"ollama_[a-z_]+",\s*$/gm) || []).length;
    const pages = readdirSync(resolve(REPO, "site/src/content/docs/handbook/tools")).filter((f) =>
      f.endsWith(".md"),
    );
    expect(registered).toBeGreaterThanOrEqual(28); // same floor mcpGolden uses
    expect(pages.length).toBe(registered);
  });
});
