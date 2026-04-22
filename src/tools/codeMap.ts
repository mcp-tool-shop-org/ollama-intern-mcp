/**
 * ollama_code_map — fast structural summary of a repo (no-LLM, deterministic).
 *
 * Walks the caller's source_paths, classifies each file by extension,
 * inspects manifests (package.json / pyproject.toml / Cargo.toml / go.mod)
 * for framework hints, and surfaces likely entrypoints via simple filename +
 * manifest heuristics.
 *
 * Deterministic by design — the Instant tier LLM is NOT invoked. Frameworks
 * are detected from dependency/lock-file names; no model call is needed to
 * see "vitest" in package.json.devDependencies. Keeps the tool cheap enough
 * to run as a first pass in any onboarding loop.
 *
 * Accepts DIRECTORIES as well as individual files — directories are walked
 * recursively up to `max_files`. Skips obvious cruft (node_modules, dist,
 * target, .git, .venv) so a one-line `source_paths: ["."]` stays useful.
 */

import { z } from "zod";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, basename, join, resolve } from "node:path";
import type { Envelope } from "../envelope.js";
import { buildEnvelope } from "../envelope.js";
import { callEvent } from "../observability.js";
import { InternError } from "../errors.js";
import type { RunContext } from "../runContext.js";

export const codeMapSchema = z.object({
  source_paths: z
    .array(z.string().min(1))
    .min(1)
    .describe("Absolute or relative paths to scan (files or directories). Directories are walked recursively."),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe("Cap on total files scanned. Default 500 — raise for large repos, but this is a FAST pass, not an exhaustive crawl."),
});

export type CodeMapInput = z.infer<typeof codeMapSchema>;

export interface CodeMapResult {
  languages: Array<{ ext: string; file_count: number }>;
  frameworks: string[];
  entrypoints: Array<{ file: string; type: "cli" | "lib" | "web" | "test" | "config" }>;
  build_commands: string[];
  notable_files: string[];
  total_files_scanned: number;
  max_files_hit: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".turbo",
  ".cache",
  "coverage",
]);

const NOTABLE_FILE_NAMES = new Set([
  "README.md",
  "README",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "tsconfig.json",
  "Dockerfile",
  ".gitignore",
]);

const CONFIG_EXTENSIONS = new Set([".json", ".toml", ".yaml", ".yml", ".ini", ".cfg"]);

/** Walk a starting path; returns a flat list of regular files up to the cap. */
async function walkPaths(
  roots: string[],
  maxFiles: number,
): Promise<{ files: string[]; hitCap: boolean }> {
  const out: string[] = [];
  let hitCap = false;
  for (const root of roots) {
    const abs = resolve(root);
    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      throw new InternError(
        "CODE_MAP_SCAN_FAILED",
        `Cannot stat path: ${root} — ${(err as Error).message}`,
        "Check the path exists and is readable.",
        false,
      );
    }
    if (st.isFile()) {
      out.push(abs);
      if (out.length >= maxFiles) {
        hitCap = true;
        return { files: out, hitCap };
      }
      continue;
    }
    if (!st.isDirectory()) continue;
    // BFS to keep depth bounded by file count.
    const queue: string[] = [abs];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.name.startsWith(".") && SKIP_DIRS.has(ent.name)) continue;
        if (SKIP_DIRS.has(ent.name)) continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          queue.push(full);
        } else if (ent.isFile()) {
          out.push(full);
          if (out.length >= maxFiles) {
            hitCap = true;
            return { files: out, hitCap };
          }
        }
      }
    }
  }
  return { files: out, hitCap };
}

/** Read a manifest file safely; returns null on read/parse failure. */
async function tryReadText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function tryReadJson(path: string): Promise<Record<string, unknown> | null> {
  const body = await tryReadText(path);
  if (body === null) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Collect framework hints from package.json. */
function frameworksFromPackageJson(pkg: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const deps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
    ...((pkg.peerDependencies as Record<string, unknown>) ?? {}),
  };
  const markers: Record<string, string> = {
    vitest: "vitest",
    jest: "jest",
    mocha: "mocha",
    astro: "astro",
    "@astrojs/starlight": "starlight",
    next: "next",
    react: "react",
    vue: "vue",
    svelte: "svelte",
    "@modelcontextprotocol/sdk": "mcp-server",
    typescript: "typescript",
    eslint: "eslint",
    express: "express",
    fastify: "fastify",
    tauri: "tauri",
    "@tauri-apps/api": "tauri",
    electron: "electron",
    zod: "zod",
    commander: "commander",
    yargs: "yargs",
  };
  for (const [key, label] of Object.entries(markers)) {
    if (deps[key] !== undefined) found.add(label);
  }
  return Array.from(found).sort();
}

function frameworksFromPyproject(body: string): string[] {
  const found = new Set<string>();
  const pairs: Array<[RegExp, string]> = [
    [/["']pytest["']/, "pytest"],
    [/["']fastapi["']/, "fastapi"],
    [/["']flask["']/, "flask"],
    [/["']django["']/, "django"],
    [/["']pydantic["']/, "pydantic"],
    [/["']numpy["']/, "numpy"],
    [/["']torch["']/, "pytorch"],
  ];
  for (const [re, label] of pairs) {
    if (re.test(body)) found.add(label);
  }
  return Array.from(found).sort();
}

function frameworksFromCargo(body: string): string[] {
  const found = new Set<string>();
  const pairs: Array<[RegExp, string]> = [
    [/^\s*tokio\s*=/m, "tokio"],
    [/^\s*serde\s*=/m, "serde"],
    [/^\s*clap\s*=/m, "clap"],
    [/^\s*ratatui\s*=/m, "ratatui"],
    [/^\s*tauri\s*=/m, "tauri"],
    [/^\s*axum\s*=/m, "axum"],
    [/^\s*rocket\s*=/m, "rocket"],
  ];
  for (const [re, label] of pairs) {
    if (re.test(body)) found.add(label);
  }
  return Array.from(found).sort();
}

function classifyEntrypoint(
  file: string,
): "cli" | "lib" | "web" | "test" | "config" | null {
  const name = basename(file).toLowerCase();
  const ext = extname(file).toLowerCase();
  if (name.includes(".test.") || name.includes(".spec.") || /(^|\/)tests?\//.test(file.replace(/\\/g, "/"))) {
    return "test";
  }
  if (name === "main.py" || name === "main.rs" || name === "main.go" || name === "main.ts" || name === "main.js") {
    return "cli";
  }
  if (name === "index.ts" || name === "index.js" || name === "index.mts" || name === "index.cts") {
    return "lib";
  }
  if (name === "server.ts" || name === "server.js" || name === "app.ts" || name === "app.js") {
    return "web";
  }
  if (CONFIG_EXTENSIONS.has(ext) && name !== "package.json") {
    return "config";
  }
  return null;
}

export async function handleCodeMap(
  input: CodeMapInput,
  ctx: RunContext,
): Promise<Envelope<CodeMapResult>> {
  const startedAt = Date.now();
  const maxFiles = input.max_files ?? 500;

  const { files, hitCap } = await walkPaths(input.source_paths, maxFiles);

  // Language tallies by extension.
  const byExt = new Map<string, number>();
  const entrypoints: Array<{ file: string; type: "cli" | "lib" | "web" | "test" | "config" }> = [];
  const notable: string[] = [];
  const manifestHits: string[] = [];

  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (ext.length > 0) byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    const name = basename(f);
    if (NOTABLE_FILE_NAMES.has(name)) notable.push(f);
    if (
      name === "package.json" ||
      name === "pyproject.toml" ||
      name === "Cargo.toml" ||
      name === "go.mod"
    ) {
      manifestHits.push(f);
    }
    const kind = classifyEntrypoint(f);
    if (kind !== null) entrypoints.push({ file: f, type: kind });
  }

  // Frameworks + build commands from manifests.
  const frameworks = new Set<string>();
  const buildCommands: string[] = [];
  for (const manifestPath of manifestHits) {
    const name = basename(manifestPath);
    if (name === "package.json") {
      const pkg = await tryReadJson(manifestPath);
      if (pkg) {
        for (const fw of frameworksFromPackageJson(pkg)) frameworks.add(fw);
        const scripts = pkg.scripts as Record<string, unknown> | undefined;
        if (scripts && typeof scripts === "object") {
          for (const [scriptName, cmd] of Object.entries(scripts)) {
            if (typeof cmd === "string") buildCommands.push(`npm run ${scriptName}`);
          }
        }
        // bin field → CLI entrypoint hint (usually points inside dist/, which
        // may not have been walked — add as entrypoint anyway).
        const bin = pkg.bin;
        if (typeof bin === "string") {
          entrypoints.push({ file: bin, type: "cli" });
        } else if (bin && typeof bin === "object") {
          for (const binPath of Object.values(bin)) {
            if (typeof binPath === "string") entrypoints.push({ file: binPath, type: "cli" });
          }
        }
      }
    } else if (name === "pyproject.toml") {
      const body = await tryReadText(manifestPath);
      if (body) for (const fw of frameworksFromPyproject(body)) frameworks.add(fw);
    } else if (name === "Cargo.toml") {
      const body = await tryReadText(manifestPath);
      if (body) for (const fw of frameworksFromCargo(body)) frameworks.add(fw);
    } else if (name === "go.mod") {
      frameworks.add("go-modules");
    }
  }

  const languages = Array.from(byExt.entries())
    .map(([ext, file_count]) => ({ ext, file_count }))
    .sort((a, b) => {
      if (b.file_count !== a.file_count) return b.file_count - a.file_count;
      return a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0;
    });

  // Dedup entrypoints by (file, type); stable sort.
  const seen = new Set<string>();
  const uniqEntrypoints: typeof entrypoints = [];
  for (const e of entrypoints) {
    const key = `${e.file}|${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqEntrypoints.push(e);
  }
  uniqEntrypoints.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const result: CodeMapResult = {
    languages,
    frameworks: Array.from(frameworks).sort(),
    entrypoints: uniqEntrypoints,
    build_commands: Array.from(new Set(buildCommands)).sort(),
    notable_files: Array.from(new Set(notable)).sort(),
    total_files_scanned: files.length,
    max_files_hit: hitCap,
  };

  const warnings: string[] = [];
  if (hitCap) {
    warnings.push(
      `Hit max_files cap (${maxFiles}). Result is a partial map; raise max_files for a complete picture or narrow source_paths.`,
    );
  }

  const envelope = buildEnvelope<CodeMapResult>({
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
  await ctx.logger.log(callEvent("ollama_code_map", envelope));
  return envelope;
}
