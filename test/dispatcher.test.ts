import { describe, it, expect, vi } from "vitest";
import { dispatchObservation } from "../src/agentbeats/agents/Dispatcher";
import { makeEpisodeState } from "../src/agentbeats/agents/SubAgent";
import { defaultMcuAction } from "../src/agentbeats/McuPrompt";
import type { SubAgent, SubAgentKind } from "../src/agentbeats/agents/SubAgent";

function stubSubagent(kind: SubAgentKind, step: any): SubAgent {
  return { kind, systemPrompt: "", step: async () => step };
}

const allStubs = (overrides: Partial<Record<SubAgentKind, SubAgent>> = {}) => ({
  ui_inventory: stubSubagent("ui_inventory", { kind: "act", action: defaultMcuAction(), holdSteps: 1 }),
  world_explore: stubSubagent("world_explore", { kind: "act", action: defaultMcuAction(), holdSteps: 1 }),
  mining: stubSubagent("mining", { kind: "act", action: defaultMcuAction(), holdSteps: 1 }),
  combat: stubSubagent("combat", { kind: "act", action: defaultMcuAction(), holdSteps: 1 }),
  placing: stubSubagent("placing", { kind: "act", action: defaultMcuAction(), holdSteps: 1 }),
  ...overrides,
});

function mockClient(plannerJson: string) {
  return { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: plannerJson } }] })) } } } as any;
}

describe("Dispatcher", () => {
  it("calls planner once on first obs and dispatches mining act when no GUI", async () => {
    const state = makeEpisodeState("mine 3 logs");
    const client = mockClient(JSON.stringify({
      overall_done: false,
      subgoals: [{ kind: "mining", description: "mine 3 logs", success_criteria: "have 3 logs" }],
    }));
    const closedLoop = vi.fn();
    const out = await dispatchObservation(
      { client, plannerModel: "x", subagents: allStubs(), runClosedLoopStep: closedLoop as any },
      state,
      { imageBase64: "", contextId: "c1" },
    );
    expect(state.subgoals).toHaveLength(1);
    expect(state.singleTask).toBe(true);
    expect(closedLoop).not.toHaveBeenCalled();
    expect(out.taskDone).toBe(false);
  });

  it("sets earlyStop when single-task ui_inventory subgoal reports done", async () => {
    const state = makeEpisodeState("craft planks");
    const client = mockClient(JSON.stringify({
      overall_done: false,
      subgoals: [{ kind: "ui_inventory", description: "craft planks", success_criteria: "planks present" }],
    }));
    const closedLoop = vi.fn(async () => ({ kind: "subgoal_done", summary: "done" }));
    const out = await dispatchObservation(
      { client, plannerModel: "x", subagents: allStubs(), runClosedLoopStep: closedLoop as any },
      state,
      { imageBase64: "", contextId: "c1" },
    );
    expect(state.earlyStop).toBe(true);
    expect(out.taskDone).toBe(true);
  });

  it("emits NOOP_DONE on subsequent obs after earlyStop", async () => {
    const state = makeEpisodeState("x");
    state.earlyStop = true;
    const out = await dispatchObservation(
      { client: mockClient("{}"), plannerModel: "x", subagents: allStubs(), runClosedLoopStep: vi.fn() as any },
      state,
      { imageBase64: "", contextId: "c1" },
    );
    expect(out.taskDone).toBe(true);
  });

  it("re-plans after subgoal_done in multi-subgoal mode", async () => {
    const state = makeEpisodeState("two-step");
    const client = { chat: { completions: { create: vi.fn() } } } as any;
    client.chat.completions.create
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        overall_done: false,
        subgoals: [
          { kind: "mining", description: "mine", success_criteria: "have logs" },
          { kind: "ui_inventory", description: "craft", success_criteria: "have planks" },
        ],
      }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ overall_done: true, subgoals: [] }) } }] });

    const subs = allStubs({ mining: stubSubagent("mining", { kind: "subgoal_done", summary: "got 3 logs" }) });
    const closedLoop = vi.fn();
    await dispatchObservation(
      { client, plannerModel: "x", subagents: subs, runClosedLoopStep: closedLoop as any },
      state,
      { imageBase64: "", contextId: "c1" },
    );
    expect(state.singleTask).toBe(false);
    expect(state.idx).toBe(1);
    expect(state.completedSummaries).toEqual(["got 3 logs"]);
  });
});
