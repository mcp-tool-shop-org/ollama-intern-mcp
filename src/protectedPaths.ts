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
 * True on case-INSENSITIVE default filesystems (Windows NTFS, macOS APFS). On
 * these, "Memory/x" and "memory/x" are the SAME file, so protected-path
 * matching must lowercase to catch cased bypasses of the confirm_write gate
 * (M3, 2026-07 health pass — the m5-max prod target is darwin). Case-sensitive
 * Linux preserves case: the cased path is a genuinely different, unprotected
 * file. `process.platform` is a coarse proxy (a case-insensitive Linux mount or
 * a case-sensitive APFS volume can exist) but matches the OS default, and a
 * false positive here is protective in direction (over-asks for confirm_write).
 */
function isCaseInsensitiveFs(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/**
 * Normalize a path for comparison: forward slashes, no leading ./, lowercase on
 * case-insensitive filesystems.
 *
 * On Windows (NTFS) and macOS (APFS) — case-insensitive — input is lowercased so
 * callers comparing against canonical lowercase patterns honor the platform's
 * filesystem semantics. On case-sensitive Linux, case is preserved.
 */
export function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/");
  if (n.startsWith("./")) n = n.slice(2);
  if (isCaseInsensitiveFs()) n = n.toLowerCase();
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
  const ci = isCaseInsensitiveFs();
  for (const rule of rules) {
    // On case-insensitive filesystems (Windows/macOS), lowercase the rule
    // pattern to match the lowercased input. On case-sensitive Linux, compare
    // verbatim — case sensitivity matches the filesystem.
    const pat = ci ? rule.pattern.toLowerCase() : rule.pattern;
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
