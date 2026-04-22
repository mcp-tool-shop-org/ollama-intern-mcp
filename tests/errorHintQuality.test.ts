/**
 * Stage B+C humanization — error hints must point at a concrete fix path.
 *
 * Walks every InternError site in the tree and asserts the hint contains at
 * least one actionable signal: an env var name, the `ollama` CLI, OLLAMA_HOST,
 * a handbook pointer, or a concrete action verb. Catches generic "check
 * things" hints before they ship.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globSync } from "node:fs";

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
  const files = globSync("**/*.ts", { cwd: srcDir });
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

    // OLLAMA_UNREACHABLE → mention OLLAMA_HOST or ollama serve
    const unreach = byCode.get("OLLAMA_UNREACHABLE") ?? [];
    expect(unreach.length).toBeGreaterThan(0);
    for (const h of unreach) {
      expect(
        /OLLAMA_HOST|ollama serve/i.test(h),
        `OLLAMA_UNREACHABLE hint should mention OLLAMA_HOST or 'ollama serve' — got: ${h}`,
      ).toBe(true);
    }

    // OLLAMA_MODEL_MISSING → mention `ollama pull` and the profile path
    const missing = byCode.get("OLLAMA_MODEL_MISSING") ?? [];
    expect(missing.length).toBeGreaterThan(0);
    for (const h of missing) {
      expect(
        /ollama pull/i.test(h),
        `OLLAMA_MODEL_MISSING hint should mention 'ollama pull' — got: ${h}`,
      ).toBe(true);
      expect(
        /INTERN_PROFILE|README|tier/i.test(h),
        `OLLAMA_MODEL_MISSING hint should point at INTERN_PROFILE / README / tier — got: ${h}`,
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
