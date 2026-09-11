/**
 * ollama_log_tail's `filter_kind` roster must match LOG_EVENT_KINDS exactly.
 *
 * Wave-9 briefly generated that roster into the description with a template
 * literal, which made it drift-proof but unparseable by
 * scripts/gen-tool-docs.mjs — the generator reads the description statically
 * and accepts only a double-quoted literal, so the handbook docgen failed
 * outright. The description went back to a plain literal and the no-drift
 * guarantee moved here.
 *
 * RED-on-revert: add a kind to LOG_EVENT_KIND_COVERAGE without updating the
 * description (or misspell one in the description) and this fails naming the
 * exact kind, instead of shipping a tool description that under-reports the
 * filters a caller may pass.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_EVENT_KINDS } from "../src/observability.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("ollama_log_tail filter_kind roster", () => {
  const src = readFileSync(resolve(REPO, "src/index.ts"), "utf8");
  const start = src.indexOf('"ollama_log_tail",');
  const description = src.slice(start, start + 2000);

  it("lists every LOG_EVENT_KINDS value, quoted, in the description", () => {
    const missing = LOG_EVENT_KINDS.filter((k) => !description.includes(`'${k}'`));
    expect(missing, `log_tail description is missing kind(s): ${missing.join(", ")}`).toEqual([]);
  });

  it("lists no kind that is not in LOG_EVENT_KINDS", () => {
    // Pull every 'single-quoted' token out of the roster clause only, so the
    // surrounding prose (which quotes 'cloud_egress' as an aside) cannot add
    // a false positive.
    const clause = description.slice(
      description.indexOf("EXACT equality"),
      description.indexOf("so mind the colon"),
    );
    const quoted = [...clause.matchAll(/'([a-z_:]+)'/g)].map((m) => m[1]);
    const known = new Set<string>(LOG_EVENT_KINDS);
    const strays = quoted.filter((k) => !known.has(k));
    expect(strays, `description lists unknown kind(s): ${strays.join(", ")}`).toEqual([]);
    expect(quoted.length).toBe(LOG_EVENT_KINDS.length);
  });

  it("keeps the description a plain string literal so gen-tool-docs can parse it", () => {
    // A backtick immediately after the tool name means someone reintroduced a
    // template literal — the shape that broke `npm run gen:tool-docs`.
    const afterName = src.slice(start + '"ollama_log_tail",'.length).trimStart();
    expect(afterName.startsWith("`"), "log_tail description must not be a template literal").toBe(
      false,
    );
  });
});
