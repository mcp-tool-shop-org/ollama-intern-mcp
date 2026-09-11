/**
 * Canonical identity for corpus names and filesystem paths.
 *
 * Win32 NTFS is case-preserving but case-insensitive: "Notes" and "notes"
 * must share one lock slot and one on-disk filename, and "C:\\Users\\a.md"
 * vs "c:\\Users\\a.md" must compare equal in reuse / stale / refresh maps.
 * POSIX stays case-sensitive. NFC-normalize everywhere so composed vs
 * decomposed names don't take two identities either.
 */

import { lstat } from "node:fs/promises";
import { dirname, normalize } from "node:path";

export function canonicalCorpusKey(name: string): string {
  const nfc = name.normalize("NFC");
  return process.platform === "win32" ? nfc.toLowerCase() : nfc;
}

export function canonicalFsPath(p: string): string {
  const n = normalize(p).normalize("NFC");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

/** True when `dirname(absPath)` itself is ENOENT (unmounted volume / missing share). */
export async function parentDirMissing(absPath: string): Promise<boolean> {
  try {
    await lstat(dirname(absPath));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}
