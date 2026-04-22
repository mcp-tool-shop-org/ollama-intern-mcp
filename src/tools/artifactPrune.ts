/**
 * ollama_artifact_prune — safe cleanup of pack artifacts on disk (no-LLM).
 *
 * Dry-run by default — re-runs that accidentally ship with the wrong filter
 * don't silently nuke hand-kept artifacts. Caller must opt in to real delete
 * with `dry_run: false`.
 *
 * Scans the canonical artifact root (or INTERN_ARTIFACT_DIR) and matches on
 * `older_than_days` (against file mtime) and `pack_type` (which subdir).
 * Matching files always come in .md + .json pairs — both get deleted together.
 */

import { z } from "zod";
import { readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const artifactPruneSchema = z.object({
  older_than_days: z
    .number()
    .int()
    .min(0)
    .max(3650)
    .optional()
    .describe("Only match artifacts older than N days (by file mtime). Omit for no age filter."),
  pack_type: z
    .enum(["incident", "change", "repo", "all"])
    .optional()
    .describe("Limit prune to one pack directory. Default 'all' scans incident + change + repo."),
  dry_run: z
    .boolean()
    .optional()
    .describe("Report what would be deleted without touching disk. DEFAULTS TO true — pass false to actually delete."),
});

export type ArtifactPruneInput = z.infer<typeof artifactPruneSchema>;

export interface PruneMatch {
  pack: "incident" | "change" | "repo";
  slug: string;
  age_days: number;
  bytes: number;
}

export interface ArtifactPruneResult {
  matched: PruneMatch[];
  total_matched: number;
  total_bytes: number;
  dry_run: boolean;
  deleted: boolean;
  artifact_root: string;
}

function artifactRoot(): string {
  return process.env.INTERN_ARTIFACT_DIR ?? join(homedir(), ".ollama-intern", "artifacts");
}

async function listJsonFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => extname(e) === ".json").map((e) => join(dir, e));
  } catch (err) {
    throw new InternError(
      "ARTIFACT_PRUNE_FAILED",
      `Cannot list artifact dir ${dir}: ${(err as Error).message}`,
      "Check that the artifact root exists and is readable. Override with INTERN_ARTIFACT_DIR.",
      false,
    );
  }
}

export async function handleArtifactPrune(
  input: ArtifactPruneInput,
  ctx: RunContext,
): Promise<Envelope<ArtifactPruneResult>> {
  const startedAt = Date.now();
  const dryRun = input.dry_run ?? true;
  const packType = input.pack_type ?? "all";
  const root = artifactRoot();

  const packs: Array<"incident" | "change" | "repo"> =
    packType === "all" ? ["incident", "change", "repo"] : [packType];

  const now = Date.now();
  const matches: PruneMatch[] = [];
  const fileTargets: Array<{ json: string; md: string }> = [];

  for (const pack of packs) {
    const dir = join(root, pack);
    let jsons: string[];
    try {
      jsons = await listJsonFiles(dir);
    } catch (err) {
      // Missing directory isn't an error — just skip.
      if (err instanceof InternError && err.code === "ARTIFACT_PRUNE_FAILED" && !existsSync(dir)) {
        continue;
      }
      throw err;
    }
    for (const jsonPath of jsons) {
      let st;
      try {
        st = await stat(jsonPath);
      } catch {
        continue; // race: file vanished between readdir and stat
      }
      const ageDays = (now - st.mtimeMs) / (1000 * 60 * 60 * 24);
      if (input.older_than_days !== undefined && ageDays < input.older_than_days) continue;
      const slug = basename(jsonPath, ".json");
      const mdPath = jsonPath.replace(/\.json$/, ".md");
      let mdBytes = 0;
      if (existsSync(mdPath)) {
        try {
          mdBytes = (await stat(mdPath)).size;
        } catch {
          mdBytes = 0;
        }
      }
      matches.push({
        pack,
        slug,
        age_days: Math.floor(ageDays),
        bytes: st.size + mdBytes,
      });
      fileTargets.push({ json: jsonPath, md: mdPath });
    }
  }

  // Deterministic ordering — oldest first, then pack, then slug.
  matches.sort((a, b) => {
    if (a.age_days !== b.age_days) return b.age_days - a.age_days;
    if (a.pack !== b.pack) return a.pack < b.pack ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  const totalBytes = matches.reduce((sum, m) => sum + m.bytes, 0);
  let deleted = false;
  if (!dryRun && fileTargets.length > 0) {
    for (const t of fileTargets) {
      try {
        await unlink(t.json);
      } catch (err) {
        // ENOENT is benign (double delete race); anything else is fatal.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new InternError(
            "ARTIFACT_PRUNE_FAILED",
            `Failed to delete ${t.json}: ${(err as Error).message}`,
            "Check filesystem permissions. Some artifacts may have been deleted before the failure — re-run with dry_run: true to see what's left.",
            false,
          );
        }
      }
      if (existsSync(t.md)) {
        try {
          await unlink(t.md);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new InternError(
              "ARTIFACT_PRUNE_FAILED",
              `Failed to delete ${t.md}: ${(err as Error).message}`,
              "Check filesystem permissions. The JSON sibling may have already been deleted — re-run with dry_run: true to see what's left.",
              false,
            );
          }
        }
      }
    }
    deleted = true;
  }

  const warnings: string[] = [];
  if (dryRun && matches.length > 0) {
    warnings.push(
      `Dry run — ${matches.length} artifact(s) would be deleted (${totalBytes} bytes). Re-run with dry_run: false to actually prune.`,
    );
  }

  const result: ArtifactPruneResult = {
    matched: matches,
    total_matched: matches.length,
    total_bytes: totalBytes,
    dry_run: dryRun,
    deleted,
    artifact_root: root,
  };

  const envelope = buildEnvelope<ArtifactPruneResult>({
    result,
    tier: "instant",
    model: "",
    hardwareProfile: ctx.hardwareProfile,
    tokensIn: 0,
    tokensOut: 0,
    startedAt,
    residency: null,
    warnings: warnings.length > 0 ? warnings : undefined,
  });
  await ctx.logger.log(callEvent("ollama_artifact_prune", envelope));
  return envelope;
}
