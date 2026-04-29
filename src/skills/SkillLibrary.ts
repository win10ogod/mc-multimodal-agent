import path from "node:path";
import { ensureDir, listJsonFiles, readJsonFile, readTextFile, writeJsonFile, writeTextFile } from "../utils/fs";
import { compactText, nowIso } from "../utils/misc";
import type { JsonObject, JsonValue } from "../types";

export type LearnedSkill = {
  name: string;
  description: string;
  trigger: string;
  steps: JsonValue[];
  tags: string[];
  scope?: Record<string, JsonValue>;
  preconditions?: string[];
  successCriteria?: string;
  failureModes?: string[];
  attempts: number;
  successes: number;
  createdAt: string;
  updatedAt: string;
  mdPath?: string;
  jsonPath?: string;
};

type SkillJson = Omit<LearnedSkill, "description" | "mdPath" | "jsonPath"> & {
  schemaVersion: 1;
};

function keyFor(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
}

function frontmatter(skill: LearnedSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    `trigger: ${JSON.stringify(skill.trigger)}`,
    `tags: [${skill.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    `scope: ${JSON.stringify(skill.scope ?? {})}`,
    `successCriteria: ${JSON.stringify(skill.successCriteria ?? "")}`,
    `successes: ${skill.successes}`,
    `attempts: ${skill.attempts}`,
    "---",
    "",
  ].join("\n");
}

export class SkillLibrary {
  private skills = new Map<string, LearnedSkill>();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    await ensureDir(this.dir);
    this.skills.clear();
    const files = await listJsonFiles(this.dir);
    for (const filePath of files) {
      const raw = await readJsonFile<SkillJson | undefined>(filePath, undefined);
      if (!raw?.name) {
        continue;
      }
      const name = keyFor(raw.name);
      const mdPath = this.mdPath(name);
      const md = await readTextFile(mdPath, "");
      const description = this.descriptionFromMarkdown(md) || raw.trigger || name;
      this.skills.set(name, {
        name,
        description,
        trigger: raw.trigger,
        steps: raw.steps ?? [],
        tags: raw.tags ?? [],
        scope: raw.scope ?? {},
        preconditions: raw.preconditions ?? [],
        successCriteria: raw.successCriteria,
        failureModes: raw.failureModes ?? [],
        attempts: raw.attempts ?? 0,
        successes: raw.successes ?? 0,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        mdPath,
        jsonPath: filePath,
      });
    }
  }

  async record(params: {
    name: string;
    description: string;
    trigger?: string;
    steps?: unknown[];
    tags?: string[];
    scope?: Record<string, unknown>;
    preconditions?: string[];
    successCriteria?: string;
    failureModes?: string[];
  }): Promise<LearnedSkill> {
    const key = keyFor(params.name);
    if (!key) {
      throw new Error("Skill name must contain at least one filename-safe character.");
    }
    const now = nowIso();
    const existing = this.skills.get(key);
    const skill: LearnedSkill = {
      name: key,
      description: params.description.trim(),
      trigger: params.trigger?.trim() || existing?.trigger || params.description.trim(),
      steps: (params.steps ?? existing?.steps ?? []) as JsonValue[],
      tags: Array.from(new Set([...(existing?.tags ?? []), ...(params.tags ?? [])])),
      scope: params.scope
        ? (JSON.parse(JSON.stringify(params.scope)) as Record<string, JsonValue>)
        : existing?.scope ?? {},
      preconditions: params.preconditions ?? existing?.preconditions ?? [],
      successCriteria: params.successCriteria ?? existing?.successCriteria,
      failureModes: params.failureModes ?? existing?.failureModes ?? [],
      attempts: existing?.attempts ?? 0,
      successes: existing?.successes ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      mdPath: this.mdPath(key),
      jsonPath: this.jsonPath(key),
    };
    this.skills.set(key, skill);
    await this.writeSkill(skill);
    return skill;
  }

  async markAttempt(name: string, success: boolean): Promise<void> {
    const key = keyFor(name);
    const skill = this.skills.get(key);
    if (!skill) {
      return;
    }
    skill.attempts += 1;
    if (success) {
      skill.successes += 1;
    }
    skill.updatedAt = nowIso();
    await this.writeSkill(skill);
  }

  query(term: string, limit = 8): LearnedSkill[] {
    const terms = term
      .toLowerCase()
      .split(/\W+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return [...this.skills.values()]
      .map((skill) => {
        const haystack = `${skill.name} ${skill.description} ${skill.trigger} ${skill.tags.join(
          " ",
        )} ${JSON.stringify(skill.scope)} ${JSON.stringify(skill.steps)}`.toLowerCase();
        const score = terms.reduce((sum, item) => sum + (haystack.includes(item) ? 1 : 0), 0);
        return { skill, score };
      })
      .filter((entry) => entry.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score || b.skill.updatedAt.localeCompare(a.skill.updatedAt))
      .slice(0, limit)
      .map((entry) => entry.skill);
  }

  get(name: string): LearnedSkill | undefined {
    return this.skills.get(keyFor(name));
  }

  buildPromptSection(maxSkills = 12, focus = ""): string {
    const selected = new Map<string, LearnedSkill>();
    if (focus.trim()) {
      for (const skill of this.query(focus, Math.ceil(maxSkills / 2))) {
        selected.set(skill.name, skill);
      }
    }
    for (const skill of [...this.skills.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, maxSkills)) {
      selected.set(skill.name, skill);
      if (selected.size >= maxSkills) {
        break;
      }
    }
    const skills = [...selected.values()];
    if (skills.length === 0) {
      return "No learned skills yet. Use record_skill after discovering a repeatable procedure.";
    }
    return skills
      .map((skill) => {
        const rate = skill.attempts > 0 ? `${skill.successes}/${skill.attempts}` : "untested";
        return `- ${skill.name} (${rate}): ${compactText(skill.description, 220)} Trigger: ${compactText(
          skill.trigger,
          140,
        )} Scope: ${compactText(JSON.stringify(skill.scope ?? {}), 220)} Files: ${skill.jsonPath}, ${skill.mdPath}`;
      })
      .join("\n");
  }

  toJson(): JsonObject {
    return {
      schemaVersion: 1,
      skills: Object.fromEntries(this.skills),
    } as unknown as JsonObject;
  }

  private async writeSkill(skill: LearnedSkill): Promise<void> {
    await ensureDir(this.dir);
    const json: SkillJson = {
      schemaVersion: 1,
      name: skill.name,
      trigger: skill.trigger,
      steps: skill.steps,
      tags: skill.tags,
      scope: skill.scope ?? {},
      preconditions: skill.preconditions ?? [],
      successCriteria: skill.successCriteria,
      failureModes: skill.failureModes ?? [],
      attempts: skill.attempts,
      successes: skill.successes,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
    await writeJsonFile(this.jsonPath(skill.name), json);
    await writeTextFile(this.mdPath(skill.name), this.renderMarkdown(skill));
  }

  private renderMarkdown(skill: LearnedSkill): string {
    const preconditions =
      skill.preconditions && skill.preconditions.length > 0
        ? skill.preconditions.map((item) => `- ${item}`).join("\n")
        : "- None recorded.";
    const failureModes =
      skill.failureModes && skill.failureModes.length > 0
        ? skill.failureModes.map((item) => `- ${item}`).join("\n")
        : "- None recorded.";
    const method =
      skill.steps.length > 0
        ? skill.steps
            .map((step, index) => {
              const entry = step && typeof step === "object" && !Array.isArray(step)
                ? (step as Record<string, unknown>)
                : {};
              const tool = typeof entry.tool === "string" ? entry.tool : `step_${index + 1}`;
              const args = entry.arguments ?? entry.args ?? {};
              return `${index + 1}. ${tool}\n\n   Arguments: \`${JSON.stringify(args)}\``;
            })
            .join("\n")
        : "Describe the procedure here.";
    return [
      frontmatter(skill),
      `# ${skill.name}`,
      "",
      "## Summary",
      "",
      skill.description.trim(),
      "",
      "## Trigger",
      "",
      skill.trigger,
      "",
      "## Scope",
      "",
      "```json",
      JSON.stringify(skill.scope ?? {}, null, 2),
      "```",
      "",
      "## Preconditions",
      "",
      preconditions,
      "",
      "## Method",
      "",
      method,
      "",
      "## Success Criteria",
      "",
      skill.successCriteria ?? "Not recorded.",
      "",
      "## Failure Handling",
      "",
      failureModes,
      "",
      "## Raw Steps",
      "",
      "```json",
      JSON.stringify(skill.steps, null, 2),
      "```",
      "",
    ].join("\n");
  }

  private descriptionFromMarkdown(markdown: string): string {
    return markdown
      .replace(/^---[\s\S]*?---\s*/m, "")
      .replace(/^# .+$/m, "")
      .trim();
  }

  private jsonPath(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  private mdPath(name: string): string {
    return path.join(this.dir, `${name}.md`);
  }
}
