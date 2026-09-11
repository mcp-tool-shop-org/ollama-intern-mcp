/**
 * Stage B+C humanization — error hints must point at a concrete fix path.
 *
 * Walks every InternError site in the tree and asserts the hint contains at
 * least one actionable signal: an env var name, the `ollama` CLI, OLLAMA_HOST,
 * a handbook pointer, or a concrete action verb. Catches generic "check
 * things" hints before they ship.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";

/**
 * Node-20-compatible recursive .ts walker. `fs.globSync` is Node-22+; we run
 * CI on the Node-20 LTS too, so we hand-roll the small piece we need.
 */
function walkTsFilesSync(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith(".ts")) {
        out.push(relative(root, full));
      }
    }
  }
  return out;
}

const ACTIONABLE_PATTERNS: RegExp[] = [
  /OLLAMA_HOST/,
  /INTERN_/,
  /'?ollama /i, // the CLI
  /~\//, // filesystem pointer (~/.ollama-intern/...)
  /see (the )?(handbook|README)/i,
  /\/api\//, // API endpoint
  // Concrete action verbs — "do X" beats "things went wrong". Kept broad
  // so file-level hints (pick, rename, split, reduce) count as actionable.
  /\b(set|unset|run|rename|increase|decrease|check|switch|start|pick|split|reduce|rebuild|remove|add|use|call|pass|provide|replace|retry|update|bump|install|pull|configure|prefer|preferred|is required|require|specify|supply|ensure|avoid|drop|only|shorten|trim|narrow|widen|enable|disable|rerun|prune|strip|quote|escape|omit|include|try|confirm|fix|resolve|delete|clean|clear|reindex|index|re-run|re-index|needs|need)\b/i,
  // Constraint-style hints ("X must be Y", "X must end with Y") — they tell
  // the operator how to fix the input, even without a leading verb.
  /\bmust\b/i,
];

/**
 * Extract (approximately) the third string literal of every `new InternError(
 *   CODE, message, hint, ...)` call in src/. Parser is grep-based on purpose
 * — we want to catch regressions without pulling in a full TS AST dep here.
 */
function extractInternErrorHints(): Array<{ file: string; code: string; hint: string }> {
  const srcDir = resolve(process.cwd(), "src");
  const files = walkTsFilesSync(srcDir);
  const hits: Array<{ file: string; code: string; hint: string }> = [];
  for (const rel of files) {
    const abs = resolve(srcDir, rel);
    const text = readFileSync(abs, "utf8");
    // Match: new InternError\(\s*"CODE",\s*(message),\s*(hint)
    // Allow backticks and quoted hints; allow multi-line args.
    const re =
      /new\s+InternError\s*\(\s*"([A-Z_]+)"\s*,\s*(?:"[^"]*"|`(?:[^`\\]|\\.)*`|[^,]+(?:\([^)]*\))?[^,]*)\s*,\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const code = m[1];
      // Strip surrounding quotes/backticks from the raw literal.
      const raw = m[2];
      const hint = raw.slice(1, -1);
      hits.push({ file: rel, code, hint });
    }
  }
  return hits;
}

describe("error hint quality", () => {
  const hints = extractInternErrorHints();

  it("we actually parsed some hints (sanity)", () => {
    expect(hints.length).toBeGreaterThan(5);
  });

  it("every InternError hint is non-empty", () => {
    for (const h of hints) {
      expect(h.hint.trim().length, `${h.file}:${h.code} has empty hint`).toBeGreaterThan(0);
    }
  });

  it("every InternError hint contains an actionable signal", () => {
    for (const h of hints) {
      const matched = ACTIONABLE_PATTERNS.some((re) => re.test(h.hint));
      expect(
        matched,
        `${h.file}:${h.code} hint lacks actionable signal — got: ${h.hint.slice(0, 120)}`,
      ).toBe(true);
    }
  });

  it("domain-specific hints point at the right fix path", () => {
    const byCode = new Map<string, string[]>();
    for (const h of hints) {
      if (!byCode.has(h.code)) byCode.set(h.code, []);
      byCode.get(h.code)!.push(h.hint);
    }

    // OLLAMA_UNREACHABLE has two flavors: a reachability outage (point at
    // OLLAMA_HOST / `ollama serve`) and a definitive 4xx refusal that keeps
    // the same error code but must not claim Ollama is down.
    const unreach = byCode.get("OLLAMA_UNREACHABLE") ?? [];
    expect(unreach.length).toBeGreaterThan(0);
    for (const h of unreach) {
      const outage = /OLLAMA_HOST|ollama serve/i.test(h);
      const refused = /HTTP/.test(h) && /refus/i.test(h);
      expect(
        outage || refused,
        `OLLAMA_UNREACHABLE hint should mention OLLAMA_HOST / 'ollama serve' or name an HTTP refusal — got: ${h}`,
      ).toBe(true);
    }

    // OLLAMA_MODEL_MISSING has two flavors (H3): the LOCAL hint says `ollama
    // pull` + names the profile path; the CLOUD hint names the cloud model env
    // vars and deliberately NEVER says `ollama pull` (cloud models aren't
    // pulled to the local machine).
    const missing = byCode.get("OLLAMA_MODEL_MISSING") ?? [];
    expect(missing.length).toBeGreaterThan(0);
    const localMissing = missing.filter((h) => /ollama pull/i.test(h));
    const cloudMissing = missing.filter((h) => /INTERN_CLOUD_MODEL/i.test(h));
    expect(
      localMissing.length,
      "expected a local `ollama pull` OLLAMA_MODEL_MISSING hint",
    ).toBeGreaterThan(0);
    for (const h of localMissing) {
      expect(
        /INTERN_PROFILE|README|tier/i.test(h),
        `local OLLAMA_MODEL_MISSING hint should point at INTERN_PROFILE / README / tier — got: ${h}`,
      ).toBe(true);
    }
    for (const h of cloudMissing) {
      expect(
        /ollama pull/i.test(h),
        `cloud OLLAMA_MODEL_MISSING hint must NOT say 'ollama pull' — got: ${h}`,
      ).toBe(false);
      expect(
        /INTERN_CLOUD_MODEL|INTERN_CLOUD_DEEP_MODEL/i.test(h),
        `cloud OLLAMA_MODEL_MISSING hint should name the cloud model env vars — got: ${h}`,
      ).toBe(true);
    }

    // TIER_TIMEOUT → mention how to extend timeout + fallback context
    const timeoutHints = byCode.get("TIER_TIMEOUT") ?? [];
    expect(timeoutHints.length).toBeGreaterThan(0);
    for (const h of timeoutHints) {
      expect(
        /INTERN_PROFILE|timeout|Fallback/i.test(h),
        `TIER_TIMEOUT hint should mention timeout extension / fallback — got: ${h}`,
      ).toBe(true);
    }

    // CONFIG_INVALID → at least some hints should name a relevant env var
    const configHints = byCode.get("CONFIG_INVALID") ?? [];
    expect(configHints.length).toBeGreaterThan(0);
    const anyNamesEnv = configHints.some((h) => /INTERN_|OLLAMA_/i.test(h));
    expect(
      anyNamesEnv,
      `CONFIG_INVALID hints should at least sometimes name the specific env var — got: ${configHints.join(" | ")}`,
    ).toBe(true);
  });
});
