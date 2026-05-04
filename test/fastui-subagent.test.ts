import { describe, it, expect } from "vitest";
import { createFastUIInteraction } from "../src/agentbeats/agents/subagents/FastUIInteraction";

describe("FastUIInteraction", () => {
  it("registers as ui_inventory kind", () => {
    const sa = createFastUIInteraction({
      client: {} as never,
      model: "test",
      runOneClosedLoopStep: async () => ({ kind: "subgoal_done", summary: "x" }),
    });
    expect(sa.kind).toBe("ui_inventory");
  });

  it("getOrInitPlan returns existing plan if set", () => {
    const sa = createFastUIInteraction({
      client: {} as never,
      model: "test",
      runOneClosedLoopStep: async () => ({ kind: "subgoal_done", summary: "x" }),
    });
    const existing = sa.getOrInitPlan("craft", null);
    expect(existing.taskText).toBe("craft");
    const same = sa.getOrInitPlan("ignored", existing);
    expect(same).toBe(existing);
  });

  it("step() throws (intentional design)", async () => {
    const sa = createFastUIInteraction({
      client: {} as never,
      model: "test",
      runOneClosedLoopStep: async () => ({ kind: "subgoal_done", summary: "x" }),
    });
    await expect(
      sa.step({
        obs: { imageBase64: "" },
        subgoal: { kind: "ui_inventory", description: "x", success_criteria: "y" },
        history: [],
        contextId: "c",
        iteration: 1,
      }),
    ).rejects.toThrow(/runOneClosedLoopStep/);
  });
});
