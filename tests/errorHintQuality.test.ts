/**
 * Stage B+C humanization — error hints must point at a concrete fix path.
 *
 * Walks every InternError site in the tree and asserts the hint contains at
 * least one actionable signal: an env var name, the `ollama` CLI, OLLAMA_HOST,
 * a handbook pointer, or a concrete action verb. Catches generic "check
 * things" hints before they ship.
 *
 * Wave 9 (F-1e0fedd7) — the gate used to grep for a quoted literal in the
 * third argument position, which silently skipped 17 of 155 call sites: the
 * hoisted `const hint = …` idiom in corpus/manifest.ts, corpus/storage.ts and
 * tools/triageLogs.ts (the corrupt-corpus recovery path — exactly where an
 * operator needs a fix command). Its only self-guard was
 * `expect(hints.length).toBeGreaterThan(5)`, so the extractor could have
 * rotted down to 4% coverage and still reported green. Three changes:
 *   1. a real argument splitter so EVERY construction site is accounted for,
 *      with a named allowlist for the sites whose hint is deliberately not a
 *      literal — a new un-parseable shape now fails loudly instead of vanishing;
 *   2. bare identifiers in the hint position resolve against a file-local
 *      `const <ident> = "…"`;
 *   3. a vagueness filter, so the header's "catches generic 'check things'
 *      hints" claim is actually enforced (it was not: `check` is an
 *      ACTIONABLE_PATTERN, so the literal hint "Check things." passed).
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
 * The other half of the contract: a verb alone is not a fix path. These match
 * hints whose entire content is an action pointed at nothing — "Check things.",
 * "Try again.", "Fix the issue." Every one of them satisfies ACTIONABLE_PATTERNS
 * (that is the bug this list closes), so actionability is now
 * `matches an actionable signal AND does not match a vague shape`.
 *
 * Measured against the tree before landing: 0 of the 154 real hints match any
 * pattern here. The stricter rule the finding floated — "require the verb to
 * co-occur with an identifier-shaped token (env var, tool name, path, CLI)" —
 * was tried and rejected: it red-lit 27 legitimate hints that name a domain
 * object in plain prose ("Pass an absolute directory — pack artifact writes
 * never resolve against a working directory.", "Pass the real file path, not a
 * symlink."). A gate with that many false positives gets deleted, not obeyed.
 */
const VAGUE_HINT_PATTERNS: RegExp[] = [
  // verb + contentless object, and nothing else
  /^\s*(?:please\s+)?(?:just\s+)?(?:check|try|fix|resolve|verify|review|inspect|examine|look\s+at|handle|address|sort\s+out|deal\s+with|use|run|set|do|rerun|re-run|retry)\s+(?:it|this|that|them|things|stuff|something|anything|everything|your\s+(?:setup|environment|config(?:uration)?|system)|the\s+(?:problem|issue|error|situation|setup|environment|input|config(?:uration)?|details|logs?))\s*[.!]?\s*$/i,
  // whole-hint boilerplate that carries no fix path at all
  /^\s*(?:try\s+again|please\s+retry|retry(?:\s+the\s+(?:request|call|operation))?|something\s+went\s+wrong|an?\s+(?:unknown|unexpected)\s+error\s+occurred|see\s+above|see\s+below|contact\s+support|no\s+hint|n\/?a|tbd|todo)\s*[.!]?\s*$/i,
  // "check the things" / "fix whatever" anywhere in the hint
  /\b(?:check|fix|verify|review|update|inspect)\s+(?:the\s+|your\s+|all\s+the\s+)?(?:things|stuff|whatever)\b/i,
];

export function isActionableHint(hint: string): boolean {
  if (VAGUE_HINT_PATTERNS.some((re) => re.test(hint))) return false;
  return ACTIONABLE_PATTERNS.some((re) => re.test(hint));
}

/**
 * Split the argument list of a call whose `(` sits at `openIdx`. Tracks
 * bracket depth, string/template state and `${}` interpolation so a comma
 * inside a template literal or a nested call does not split an argument.
 * Returns null if the call never closes (unbalanced source).
 */
function splitCallArgs(text: string, openIdx: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = openIdx + 1;
  let quote: string | null = null;
  const tplStack: number[] = [];
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (quote === "`" && ch === "$" && text[i + 1] === "{") {
        tplStack.push(depth);
        depth++;
        i++;
        continue;
      }
      if (
        quote === "`" &&
        ch === "}" &&
        tplStack.length > 0 &&
        depth === tplStack[tplStack.length - 1]! + 1
      ) {
        tplStack.pop();
        depth--;
        continue;
      }
      if (tplStack.length === 0 && ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** True when `arg` is exactly one string/template literal. */
function isStringLiteral(arg: string): boolean {
  if (arg.length < 2) return false;
  const q = arg[0]!;
  if (q !== '"' && q !== "'" && q !== "`") return false;
  if (arg[arg.length - 1] !== q) return false;
  for (let i = 1; i < arg.length - 1; i++) {
    if (arg[i] === "\\") {
      i++;
      continue;
    }
    if (arg[i] === q) return false;
  }
  return true;
}

/** Resolve `const <ident> = "…"` (or backtick/single-quote) in the same file. */
function resolveFileLocalLiteral(text: string, ident: string): string | null {
  const re = new RegExp(
    `\\b(?:const|let|var)\\s+${ident}\\s*(?::[^=]+)?=\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
  );
  const m = re.exec(text);
  return m ? m[1]! : null;
}

interface HintSite {
  file: string;
  code: string;
  hint: string;
}
interface UnresolvedSite {
  file: string;
  code: string;
  /** The raw third-argument expression we could not reduce to a literal. */
  expr: string;
}

/**
 * Every `new InternError(CODE, message, hint, …)` site in src/, split into the
 * ones whose hint reduces to a literal (checked below) and the ones that
 * forward a non-literal expression (allowlisted below). `rawSites` is the
 * independent count of `new InternError(` occurrences — the three numbers must
 * reconcile, which is what keeps the extractor honest.
 */
function extractInternErrorHints(): {
  hints: HintSite[];
  unresolved: UnresolvedSite[];
  rawSites: number;
  rawByFile: Map<string, number>;
} {
  const srcDir = resolve(process.cwd(), "src");
  const files = walkTsFilesSync(srcDir);
  const hints: HintSite[] = [];
  const unresolved: UnresolvedSite[] = [];
  const rawByFile = new Map<string, number>();
  let rawSites = 0;
  for (const rel of files) {
    const abs = resolve(srcDir, rel);
    const text = readFileSync(abs, "utf8");
    const raw = (text.match(/new\s+InternError\s*\(/g) ?? []).length;
    if (raw > 0) rawByFile.set(rel, raw);
    rawSites += raw;
    const re = /new\s+InternError\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const args = splitCallArgs(text, m.index + m[0].length - 1);
      if (args === null || args.length < 3) {
        unresolved.push({
          file: rel,
          code: args?.[0] ?? "<unparsed>",
          expr: args === null ? "<call never closes>" : args.join(" , "),
        });
        continue;
      }
      const code = isStringLiteral(args[0]!) ? args[0]!.slice(1, -1) : args[0]!;
      let hintArg = args[2]!;
      if (!isStringLiteral(hintArg) && /^[A-Za-z_$][\w$]*$/.test(hintArg)) {
        const literal = resolveFileLocalLiteral(text, hintArg);
        if (literal !== null) hintArg = literal;
      }
      if (isStringLiteral(hintArg)) {
        hints.push({ file: rel, code, hint: hintArg.slice(1, -1) });
      } else {
        unresolved.push({ file: rel, code, expr: hintArg });
      }
    }
  }
  return { hints, unresolved, rawSites, rawByFile };
}

/**
 * Sites whose hint is deliberately NOT a literal. Each key is
 * `<src-relative file>:<CODE>` and must carry a reason — adding an entry is a
 * decision, not a formality. Anything not listed here that stops resolving
 * fails the reconciliation test below.
 */
const NON_LITERAL_HINT_SITES = new Map<string, string>([
  [
    "tools/corpusAmend.ts:CORPUS_AMEND_FAILED",
    "re-wraps an InternError thrown by the corpus layer and forwards err.hint verbatim; the originating site is itself covered by this gate",
  ],
]);

describe("error hint quality", () => {
  const { hints, unresolved, rawSites, rawByFile } = extractInternErrorHints();

  it("accounts for every InternError construction site (extractor cannot silently rot)", () => {
    // The old guard was `expect(hints.length).toBeGreaterThan(5)` — the
    // extractor could have fallen from 138 parsed hints to 6 and still passed.
    // These three assertions pin the real relationship instead of a floor.
    expect(rawSites, "no InternError sites found — did src/ move?").toBeGreaterThan(100);
    expect(
      hints.length + unresolved.length,
      `extractor lost sites: ${rawSites} \`new InternError(\` occurrences but ${hints.length} resolved + ${unresolved.length} unresolved`,
    ).toBe(rawSites);

    const unexpected = unresolved
      .map((u) => `${u.file.replace(/\\/g, "/")}:${u.code}`)
      .filter((key) => !NON_LITERAL_HINT_SITES.has(key));
    expect(
      unexpected,
      `these hints are no longer reachable by the extractor, so they are exempt from every check below — ` +
        `pass a literal (or a file-local \`const hint = …\`), or add them to NON_LITERAL_HINT_SITES with a reason. ` +
        `Unresolved exprs: ${JSON.stringify(unresolved.map((u) => `${u.file}:${u.code} -> ${u.expr}`))}`,
    ).toEqual([]);

    // Per-file reconciliation — names the file that regressed rather than
    // leaving a bare total mismatch for a human to bisect.
    const seenByFile = new Map<string, number>();
    for (const h of hints) seenByFile.set(h.file, (seenByFile.get(h.file) ?? 0) + 1);
    for (const u of unresolved) seenByFile.set(u.file, (seenByFile.get(u.file) ?? 0) + 1);
    for (const [file, raw] of rawByFile) {
      expect(
        seenByFile.get(file) ?? 0,
        `${file}: ${raw} InternError site(s) in source but ${seenByFile.get(file) ?? 0} accounted for`,
      ).toBe(raw);
    }
  });

  it("resolves the hoisted `const hint = …` idiom (corrupt-corpus recovery path)", () => {
    // These three files pass a hoisted const into every throw; the old
    // literal-only regex skipped all 16 of those sites, which is why the
    // corrupt-corpus and oversized-log hints were never quality-checked.
    for (const [file, needle] of [
      ["corpus/manifest.ts", "ollama_corpus_index"],
      ["corpus/storage.ts", "ollama_corpus_index"],
      ["tools/triageLogs.ts", "batch mode"],
    ] as const) {
      const forFile = hints.filter((h) => h.file.replace(/\\/g, "/") === file);
      expect(forFile.length, `${file}: no hints resolved — the const-hint resolver regressed`).toBeGreaterThan(
        1,
      );
      expect(
        forFile.some((h) => h.hint.includes(needle)),
        `${file}: expected a resolved hoisted hint naming "${needle}" — got ${JSON.stringify(forFile.map((h) => h.hint.slice(0, 60)))}`,
      ).toBe(true);
    }
  });

  it("every InternError hint is non-empty", () => {
    for (const h of hints) {
      expect(h.hint.trim().length, `${h.file}:${h.code} has empty hint`).toBeGreaterThan(0);
    }
  });

  it("every InternError hint contains an actionable signal", () => {
    for (const h of hints) {
      expect(
        isActionableHint(h.hint),
        `${h.file}:${h.code} hint lacks actionable signal — got: ${h.hint.slice(0, 120)}`,
      ).toBe(true);
    }
  });

  it("rejects generic 'check things' hints — the claim in this file's header", () => {
    // Negative table: each of these satisfies ACTIONABLE_PATTERNS on its own
    // (check / try / fix / use are all action verbs), so before the vagueness
    // filter every one of them shipped green.
    for (const bad of [
      "Check things.",
      "check things",
      "Check all the things",
      "Try again.",
      "Please retry.",
      "Something went wrong.",
      "Fix it.",
      "Use it.",
      "Resolve the issue!",
      "Check your setup.",
      "Review the logs",
      "TODO",
    ]) {
      expect(isActionableHint(bad), `vague hint should be rejected: "${bad}"`).toBe(false);
    }
    // Positive table — prose hints that name a real object must survive. These
    // are verbatim shapes from src/; the filter must not red-light them.
    for (const good of [
      "Check the path exists and is readable.",
      "Pass an absolute directory — pack artifact writes never resolve against a working directory.",
      "Pass the real file path, not a symlink.",
      "Set OLLAMA_HOST to the machine running Ollama.",
      "Split the file or raise the cap. The 50MB limit exists to prevent OOM.",
      "Export writes markdown only. Pick a target filename ending in .md.",
    ]) {
      expect(isActionableHint(good), `real hint must not be flagged vague: "${good}"`).toBe(true);
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
    // the same error code but must not claim Ollama is down. Split the grep
    // so restoring the pre-fix 4xx 'ollama serve' hint cannot satisfy both.
    const unreach = byCode.get("OLLAMA_UNREACHABLE") ?? [];
    expect(unreach.length).toBeGreaterThan(0);
    const refusedHints = unreach.filter((h) => /HTTP/.test(h) && /refus/i.test(h));
    expect(
      refusedHints.length,
      "expected at least one OLLAMA_UNREACHABLE hint that names an HTTP refusal",
    ).toBeGreaterThan(0);
    for (const h of refusedHints) {
      expect(
        /ollama serve/i.test(h),
        `HTTP-refusal OLLAMA_UNREACHABLE hint must not mention 'ollama serve' — got: ${h}`,
      ).toBe(false);
    }
    const outageHints = unreach.filter((h) => /OLLAMA_HOST|ollama serve/i.test(h));
    expect(
      outageHints.length,
      "expected at least one reachability-outage OLLAMA_UNREACHABLE hint (OLLAMA_HOST / ollama serve)",
    ).toBeGreaterThan(0);

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
