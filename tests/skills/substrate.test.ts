import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadSkills } from "../../src/skills/store.js";
import { matchSkills } from "../../src/skills/matcher.js";
import { __internal } from "../../src/skills/runner.js";

function tmpdir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
}

async function writeSkill(dir: string, id: string, body: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, ...body }, null, 2), "utf8");
}

const minimalBody = (overrides: Record<string, unknown> = {}) => ({
  name: "Thing",
  description: "Does a thing",
  trigger: { keywords: ["thing"], input_shape: {} },
  pipeline: [{ id: "a", tool: "ollama_classify", inputs: { text: "x" } }],
  result_from: "a",
  ...overrides,
});

describe("skills/store", () => {
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    globalDir = tmpdir();
    projectDir = tmpdir();
  });
  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("loads skills from both scopes", async () => {
    await writeSkill(globalDir, "alpha", minimalBody({ name: "Alpha" }));
    await writeSkill(projectDir, "beta", minimalBody({ name: "Beta" }));
    const { skills, warnings } = await loadSkills({ globalDir, projectDir });
    expect(warnings).toEqual([]);
    expect(skills.map((s) => s.skill.id)).toEqual(["alpha", "beta"]);
    const alpha = skills.find((s) => s.skill.id === "alpha")!;
    expect(alpha.scope).toBe("global");
    const beta = skills.find((s) => s.skill.id === "beta")!;
    expect(beta.scope).toBe("project");
  });

  it("project scope overrides global by id", async () => {
    await writeSkill(globalDir, "same", minimalBody({ name: "Global version" }));
    await writeSkill(projectDir, "same", minimalBody({ name: "Project version" }));
    const { skills } = await loadSkills({ globalDir, projectDir });
    expect(skills).toHaveLength(1);
    expect(skills[0].skill.name).toBe("Project version");
    expect(skills[0].scope).toBe("project");
  });

  it("warns on malformed skill files but keeps loading", async () => {
    await writeSkill(globalDir, "good", minimalBody());
    await fs.writeFile(path.join(globalDir, "bad.json"), "{ not valid json", "utf8");
    const { skills, warnings } = await loadSkills({ globalDir, projectDir });
    expect(skills.map((s) => s.skill.id)).toEqual(["good"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toMatch(/read\/parse failed/);
  });

  it("warns when filename stem disagrees with skill.id", async () => {
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(globalDir, "wrongname.json"),
      JSON.stringify({ id: "realname", ...minimalBody() }, null, 2),
      "utf8",
    );
    const { skills, warnings } = await loadSkills({ globalDir, projectDir });
    expect(skills).toHaveLength(0);
    expect(warnings[0].reason).toMatch(/does not match skill\.id/);
  });
});

describe("skills/matcher", () => {
  it("scores skills by keyword overlap with the task", async () => {
    const globalDir = tmpdir();
    const projectDir = tmpdir();
    try {
      await writeSkill(
        globalDir,
        "triage",
        minimalBody({
          name: "Triage logs",
          description: "Pulls errors from logs",
          trigger: { keywords: ["logs", "triage", "errors"], input_shape: {} },
          status: "approved",
        }),
      );
      await writeSkill(
        globalDir,
        "summarize",
        minimalBody({
          name: "Summarize long docs",
          description: "Digest a long document",
          trigger: { keywords: ["summary", "digest"], input_shape: {} },
          status: "approved",
        }),
      );
      const { skills } = await loadSkills({ globalDir, projectDir });
      const matches = matchSkills(skills, "I need to triage some CI logs for errors", 5);
      expect(matches[0].id).toBe("triage");
      expect(matches[0].reasons.join(" ")).toMatch(/keywords/);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("excludes deprecated skills", async () => {
    const globalDir = tmpdir();
    const projectDir = tmpdir();
    try {
      await writeSkill(
        globalDir,
        "old",
        minimalBody({
          trigger: { keywords: ["old"], input_shape: {} },
          status: "deprecated",
        }),
      );
      const { skills } = await loadSkills({ globalDir, projectDir });
      const matches = matchSkills(skills, "old thing", 5);
      expect(matches).toHaveLength(0);
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("skills/runner — template resolution", () => {
  it("resolves ${input.x} to the caller input", () => {
    const out = __internal.resolveValue(
      { text: "${input.log_text}" },
      { log_text: "boom" },
      {},
    );
    expect(out).toEqual({ text: "boom" });
  });

  it("preserves non-string types when the whole string is a single template", () => {
    const out = __internal.resolveValue(
      { source_paths: "${input.paths}" },
      { paths: ["a", "b"] },
      {},
    );
    expect(out).toEqual({ source_paths: ["a", "b"] });
  });

  it("resolves ${step.result.path} from prior step outputs", () => {
    const stepOutputs = { prior: { result: { digest: "gold" } } };
    const out = __internal.resolveValue(
      { focus: "${prior.result.digest}" },
      {},
      stepOutputs,
    );
    expect(out).toEqual({ focus: "gold" });
  });

  it("handles nested structures", () => {
    const out = __internal.resolveValue(
      { items: [{ id: "a", text: "${input.a}" }, { id: "b", text: "${input.b}" }] },
      { a: "first", b: "second" },
      {},
    );
    expect(out).toEqual({ items: [{ id: "a", text: "first" }, { id: "b", text: "second" }] });
  });

  it("returns empty string for missing refs inside mixed templates", () => {
    const out = __internal.resolveValue(
      "hello ${input.nope}!",
      {},
      {},
    );
    expect(out).toBe("hello !");
  });
});
