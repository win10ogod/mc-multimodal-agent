import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillLibrary } from "../src/skills/SkillLibrary";

describe("SkillLibrary", () => {
  it("records and retrieves learned skills", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-skills-"));
    const skills = new SkillLibrary(path.join(dir, "skills.json"));
    await skills.load();
    await skills.record({
      name: "pillar up",
      description: "Jump and place a block underneath to gain height.",
      tags: ["movement", "building"],
      steps: [{ tool: "place_screen", args: { x: 160, y: 130 } }],
      preconditions: ["A placeable block is selected."],
      successCriteria: "The bot is one block higher.",
      failureModes: ["No block is held."],
    });
    await skills.markAttempt("pillar up", true);

    const result = skills.query("height")[0];
    expect(result?.name).toBe("pillar_up");
    expect(result?.successes).toBe(1);
    expect(result?.jsonPath).toMatch(/pillar_up\.json$/);
    expect(result?.mdPath).toMatch(/pillar_up\.md$/);
    const markdown = await fs.readFile(result.mdPath!, "utf8");
    expect(markdown).toContain("## Preconditions");
    expect(markdown).toContain("A placeable block is selected.");
    expect(markdown).toContain("## Success Criteria");
  });
});
