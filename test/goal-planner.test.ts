import { describe, it, expect, vi } from "vitest";
import { planGoals } from "../src/agentbeats/agents/GoalPlanner";

function mockClient(returnText: string): any {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: returnText } }] })),
      },
    },
  };
}

describe("GoalPlanner", () => {
  it("parses a valid plan", async () => {
    const client = mockClient(JSON.stringify({
      overall_done: false,
      subgoals: [{ kind: "mining", description: "mine 3 oak logs", success_criteria: "inventory has >=3 oak_log" }],
    }));
    const out = await planGoals({ client, model: "x" }, "get planks", []);
    expect(out.subgoals).toHaveLength(1);
    expect(out.subgoals[0].kind).toBe("mining");
    expect(out.overall_done).toBe(false);
  });

  it("falls back to single ui_inventory subgoal on bad JSON", async () => {
    const client = mockClient("not json");
    const out = await planGoals({ client, model: "x" }, "craft 4 planks", []);
    expect(out.subgoals).toHaveLength(1);
    expect(out.subgoals[0].kind).toBe("ui_inventory");
    expect(out.subgoals[0].description).toBe("craft 4 planks");
  });

  it("falls back when subgoals array is empty", async () => {
    const client = mockClient(JSON.stringify({ overall_done: false, subgoals: [] }));
    const out = await planGoals({ client, model: "x" }, "task", []);
    expect(out.subgoals).toHaveLength(1);
    expect(out.subgoals[0].kind).toBe("ui_inventory");
  });
});
