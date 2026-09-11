/**
 * Protected-path list — explicit, versioned, one place.
 *
 * Writes from `ollama_draft` that target these paths require explicit
 * `confirm_write: true`, enforced server-side (never prompt-side).
 *
 * Do NOT scatter conditionals across tool handlers. Add a new protected
 * path here, bump PROTECTED_PATHS_VERSION, and the whole system picks it up.
 */

import { posix } from "node:path";

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
 * Normalize a path for comparison: forward slashes, collapsed `.`/`./`,
 * no leading `./`, Win32 ADS suffixes + trailing dots/spaces stripped per
 * segment, lowercase on case-insensitive filesystems.
 *
 * On Windows, CreateFile strips trailing spaces and dots unless a `\\?\`
 * prefix is used — so `SECURITY.md.` and `SECURITY.md ` are the same file as
 * `SECURITY.md`, and `memory./x` lands on `memory/x`. Canonicalize before
 * matching so confirm_write cannot be skipped via those aliases.
 *
 * On Windows, NTFS Alternate Data Streams ride after a colon (`file::$DATA`,
 * `file:stream`). CreateFile opens `SECURITY.md::$DATA` as `SECURITY.md` and
 * writes `SECURITY.md:hidden` as an ADS on that same file. Strip the ADS
 * suffix from each segment (keeping a leading `X:` drive prefix) so
 * confirm_write covers the file the OS will open.
 *
 * On Windows (NTFS) and macOS (APFS) — case-insensitive — input is lowercased so
 * callers comparing against canonical lowercase patterns honor the platform's
 * filesystem semantics. On case-sensitive Linux, case is preserved.
 */
export function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/");
  n = posix.normalize(n);
  while (n.startsWith("./")) n = n.slice(2);
  if (process.platform === "win32") {
    n = n
      .split("/")
      .map(canonicalizeWin32Segment)
      .join("/")
      .replace(/\/{2,}/g, "/");
  }
  if (isCaseInsensitiveFs()) n = n.toLowerCase();
  return n;
}

function canonicalizeWin32Segment(seg: string): string {
  if (seg === "." || seg === "..") return seg;
  // Drive prefix `C:` (and `C:foo` without a slash) is not an ADS.
  const drive = /^[A-Za-z]:/.exec(seg);
  const prefix = drive ? drive[0] : "";
  let rest = drive ? seg.slice(prefix.length) : seg;
  // ADS: first colon starts the stream (`::$DATA`, `:stream`, `:stream:$DATA`).
  const colon = rest.indexOf(":");
  if (colon !== -1) rest = rest.slice(0, colon);
  return prefix + rest.replace(/[ .]+$/, "");
}

/** True when a Win32 path segment looks like an 8.3 short name (`SECURI~1.MD`). */
function isWin83TildeSegment(seg: string): boolean {
  return /^[^.]{1,6}~\d(?:\.[^.]{0,3})?$/i.test(seg);
}

function splitBaseExt(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name.replace(/^\./, ""), ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

function win83Stem(name: string): { prefix: string; ext: string } {
  const { base, ext } = splitBaseExt(name);
  const cleanBase = base.replace(/[^A-Za-z0-9]/g, "");
  const cleanExt = ext.replace(/[^A-Za-z0-9]/g, "");
  return {
    prefix: cleanBase.slice(0, 6).toLowerCase(),
    ext: cleanExt.slice(0, 3).toLowerCase(),
  };
}

function win83MatchesLongName(shortSeg: string, longName: string): boolean {
  if (!isWin83TildeSegment(shortSeg)) return false;
  const m = /^([^.]{1,6})~(\d)(?:\.([^.]{0,3}))?$/i.exec(shortSeg);
  if (!m) return false;
  const stem = win83Stem(longName);
  return m[1].toLowerCase() === stem.prefix && (m[3] ?? "").toLowerCase() === stem.ext;
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
      // Win32 8.3: `MEMORY~1/x.md` is the same directory as `memory/`.
      if (process.platform === "win32") {
        const dir = pat.slice(0, -1);
        const dirBase = dir.includes("/") ? dir.slice(dir.lastIndexOf("/") + 1) : dir;
        const segs = n.split("/").filter(Boolean);
        if (segs.some((seg) => win83MatchesLongName(seg, dirBase))) {
          return { protected: true, rule };
        }
      }
    } else if (n === pat || n.endsWith("/" + pat)) {
      return { protected: true, rule };
    } else if (process.platform === "win32") {
      // Win32 8.3: `SECURI~1.MD` is the same file as `SECURITY.md`.
      const base = n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n;
      const patBase = pat.includes("/") ? pat.slice(pat.lastIndexOf("/") + 1) : pat;
      if (win83MatchesLongName(base, patBase)) {
        return { protected: true, rule };
      }
    }
  }
  return { protected: false };
}
