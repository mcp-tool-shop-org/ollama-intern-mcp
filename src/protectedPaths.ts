/**
 * Protected-path list — explicit, versioned, one place.
 *
 * Writes from `ollama_draft` that target these paths require explicit
 * `confirm_write: true`, enforced server-side (never prompt-side).
 *
 * Do NOT scatter conditionals across tool handlers. Add a new protected
 * path here, bump PROTECTED_PATHS_VERSION, and the whole system picks it up.
 */

export const PROTECTED_PATHS_VERSION = 1;

export interface ProtectedPathRule {
  /** Glob-ish pattern, evaluated by matchesProtectedPath(). Use POSIX separators. */
  pattern: string;
  /** Human-readable reason shown in the error. */
  reason: string;
}

/**
 * Rules — kept explicit so a reviewer can eyeball them.
 *
 * Matching is substring-against-normalized-path with "/" as separator.
 * A pattern ending in "/" matches any descendant.
 */
export const PROTECTED_PATHS: ProtectedPathRule[] = [
  { pattern: "memory/", reason: "Canon-adjacent memory — human judgment only." },
  { pattern: "MEMORY.md", reason: "Memory index — only the memory system updates this." },
  { pattern: ".claude/", reason: "Claude configuration and rules — human-owned." },
  { pattern: "docs/canon/", reason: "Game canon — authored by humans, never drafted." },
  { pattern: "canon/", reason: "Game canon — authored by humans, never drafted." },
  { pattern: "doctrine/", reason: "Combat/systems doctrine — human-owned." },
  { pattern: "games/", reason: "Proprietary game data root." },
  { pattern: ".git/", reason: "Git internals." },
  { pattern: "SECURITY.md", reason: "Security policy — reviewed changes only." },
  { pattern: "LICENSE", reason: "License — do not auto-modify." },
];

/**
 * Normalize a path for comparison: forward slashes, no leading ./, lowercase on Windows.
 */
export function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/");
  if (n.startsWith("./")) n = n.slice(2);
  return n;
}

export interface ProtectedMatch {
  protected: boolean;
  rule?: ProtectedPathRule;
}

export function matchesProtectedPath(
  path: string,
  rules: ProtectedPathRule[] = PROTECTED_PATHS,
): ProtectedMatch {
  const n = normalizePath(path);
  for (const rule of rules) {
    const pat = rule.pattern;
    if (pat.endsWith("/")) {
      // Directory rule: any segment boundary containing the dir name matches.
      if (n.startsWith(pat) || n.includes("/" + pat)) {
        return { protected: true, rule };
      }
    } else if (n === pat || n.endsWith("/" + pat)) {
      return { protected: true, rule };
    }
  }
  return { protected: false };
}
