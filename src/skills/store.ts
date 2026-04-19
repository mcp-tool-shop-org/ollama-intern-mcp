/**
 * Skill store — reads JSON skill files from global (~/.ollama-intern/skills/)
 * and project (<cwd>/skills/) directories. Project ids override global ids.
 *
 * Malformed files are surfaced as warnings and skipped, never silently merged.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { skillSchema, type LoadedSkill, type Skill, type SkillScope } from "./types.js";

export interface SkillStoreOptions {
  projectDir?: string;
  globalDir?: string;
}

export interface SkillLoadResult {
  skills: LoadedSkill[];
  warnings: Array<{ path: string; reason: string }>;
}

export function globalSkillsDir(override?: string): string {
  return override ?? path.join(os.homedir(), ".ollama-intern", "skills");
}

export function projectSkillsDir(override?: string): string {
  return override ?? path.join(process.cwd(), "skills");
}

async function readJsonDir(dir: string): Promise<Array<{ file: string; json: unknown; error?: string }>> {
  if (!existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Array<{ file: string; json: unknown; error?: string }> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const file = path.join(dir, e.name);
    try {
      const raw = await fs.readFile(file, "utf8");
      out.push({ file, json: JSON.parse(raw) });
    } catch (err) {
      out.push({ file, json: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

async function loadScope(
  dir: string,
  scope: SkillScope,
  warnings: SkillLoadResult["warnings"],
): Promise<LoadedSkill[]> {
  const raw = await readJsonDir(dir);
  const loaded: LoadedSkill[] = [];
  for (const entry of raw) {
    if (entry.error) {
      warnings.push({ path: entry.file, reason: `read/parse failed: ${entry.error}` });
      continue;
    }
    const parsed = skillSchema.safeParse(entry.json);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      warnings.push({ path: entry.file, reason: `schema invalid: ${detail}` });
      continue;
    }
    const skill: Skill = parsed.data;
    const stem = path.basename(entry.file, ".json");
    if (stem !== skill.id) {
      warnings.push({
        path: entry.file,
        reason: `filename stem "${stem}" does not match skill.id "${skill.id}"`,
      });
      continue;
    }
    loaded.push({ skill, scope, source_path: entry.file });
  }
  return loaded;
}

/** Load and merge global + project skills. Project id wins over global id. */
export async function loadSkills(opts: SkillStoreOptions = {}): Promise<SkillLoadResult> {
  const warnings: SkillLoadResult["warnings"] = [];
  const globalSkills = await loadScope(globalSkillsDir(opts.globalDir), "global", warnings);
  const projectSkills = await loadScope(projectSkillsDir(opts.projectDir), "project", warnings);
  const byId = new Map<string, LoadedSkill>();
  for (const s of globalSkills) byId.set(s.skill.id, s);
  for (const s of projectSkills) byId.set(s.skill.id, s); // project overrides global
  const skills = Array.from(byId.values()).sort((a, b) => (a.skill.id < b.skill.id ? -1 : 1));
  return { skills, warnings };
}

export async function getSkill(id: string, opts: SkillStoreOptions = {}): Promise<LoadedSkill | null> {
  const { skills } = await loadSkills(opts);
  return skills.find((s) => s.skill.id === id) ?? null;
}
