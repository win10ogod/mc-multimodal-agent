import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GoalStore } from "../src/goals/GoalStore";

async function makeGoals(): Promise<GoalStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-goals-"));
  const goals = new GoalStore(path.join(dir, "goals.json"));
  await goals.load();
  return goals;
}

describe("GoalStore", () => {
  it("creates persistent task trees and returns next work", async () => {
    const goals = await makeGoals();
    const plan = await goals.createPlan({
      task: "Build a small wooden house",
      goals: [
        { title: "Gather logs", priority: 0.9, successCriteria: "Inventory contains logs." },
        { title: "Craft planks", priority: 0.8 },
      ],
    });

    expect(plan.root.status).toBe("running");
    expect(plan.goals).toHaveLength(2);
    expect(goals.next(plan.root.id)?.title).toBe("Gather logs");

    const updated = await goals.update({
      id: plan.goals[0]!.id,
      status: "done",
      verification: "Inventory contains 12 oak_log.",
    });
    expect(updated.status).toBe("done");
    expect(goals.next(plan.root.id)?.title).toBe("Craft planks");
  });

  it("records blockers and checkpoints", async () => {
    const goals = await makeGoals();
    const plan = await goals.createPlan({
      task: "Craft a modded item",
      goals: [{ title: "Find machine recipe" }],
    });

    const blocked = await goals.update({
      id: plan.goals[0]!.id,
      blockers: ["Recipe packets skipped on this modpack."],
      note: "Need player guidance or JEI companion.",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockers[0]).toContain("Recipe packets");

    const checkpoint = await goals.checkpoint({
      rootId: plan.root.id,
      note: "Player started explaining the machine workflow.",
    });
    expect(checkpoint.notes.at(-1)).toContain("machine workflow");
    expect(goals.buildPromptSection("machine")).toContain("Recipe packets");
  });
});
