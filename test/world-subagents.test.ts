import { describe, it, expect, vi } from "vitest";
import { createMining } from "../src/agentbeats/agents/subagents/Mining";
import { defaultMcuAction } from "../src/agentbeats/McuPrompt";

function mockClient(content: string): any {
  return { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content } }] })) } } };
}

const baseInput = {
  obs: { imageBase64: "" },
  subgoal: { kind: "mining" as const, description: "mine 3 logs", success_criteria: "3 logs in inv" },
  history: [],
  contextId: "c",
  iteration: 1,
};

describe("Mining sub-agent", () => {
  it("returns act when VLM emits a normal action", async () => {
    const action = defaultMcuAction(); action.attack = 1;
    const json = JSON.stringify({
      type: "action", action_type: "env", hold_steps: 3, task_done: false, action,
    });
    const sa = createMining({ client: mockClient(json), model: "m" });
    const step = await sa.step(baseInput);
    expect(step.kind).toBe("act");
  });

  it("returns subgoal_done when task_done=true", async () => {
    const action = defaultMcuAction();
    const json = JSON.stringify({
      type: "action", action_type: "env", hold_steps: 1, task_done: true, action,
    });
    const sa = createMining({ client: mockClient(json), model: "m" });
    const step = await sa.step(baseInput);
    expect(step.kind).toBe("subgoal_done");
  });

  it("returns subgoal_failed on unparseable response", async () => {
    const sa = createMining({ client: mockClient("garbage"), model: "m" });
    const step = await sa.step(baseInput);
    expect(step.kind).toBe("subgoal_failed");
  });
});
