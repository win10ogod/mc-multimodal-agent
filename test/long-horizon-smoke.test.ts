import { describe, it, expect, vi } from "vitest";
import { dispatchObservation } from "../src/agentbeats/agents/Dispatcher";
import { makeEpisodeState } from "../src/agentbeats/agents/SubAgent";
import { defaultMcuAction } from "../src/agentbeats/McuPrompt";
import * as SlotDetector from "../src/agentbeats/tools/SlotDetector";

vi.mock("../src/agentbeats/tools/SlotDetector", () => ({
  detectGuiSlots: vi.fn(),
}));

describe("Long-horizon dispatch", () => {
  it("plans gather then craft, advances on subgoal_done, terminates with earlyStop", async () => {
    const state = makeEpisodeState("get 4 oak planks from a tree");

    const plannerSeq = [
      JSON.stringify({
        overall_done: false,
        subgoals: [
          { kind: "mining", description: "mine 1 oak log", success_criteria: "have 1 log" },
          { kind: "ui_inventory", description: "craft 4 oak planks", success_criteria: "have 4 planks" },
        ],
      }),
      JSON.stringify({
        overall_done: true,
        subgoals: [{ kind: "noop", description: "task complete", success_criteria: "done" }]
      }),
    ];
    const client = { chat: { completions: { create: vi.fn() } } } as any;
    plannerSeq.forEach((c) =>
      client.chat.completions.create.mockResolvedValueOnce({ choices: [{ message: { content: c } }] }),
    );

    let miningCalls = 0;
    const subagents: any = {
      ui_inventory: { kind: "ui_inventory", systemPrompt: "", step: async () => ({ kind: "act", action: defaultMcuAction(), holdSteps: 1 }) },
      world_explore: { kind: "world_explore", systemPrompt: "", step: async () => ({ kind: "act", action: defaultMcuAction(), holdSteps: 1 }) },
      mining: { kind: "mining", systemPrompt: "", step: async () => {
        miningCalls += 1;
        return miningCalls < 3
          ? { kind: "act", action: defaultMcuAction(), holdSteps: 1 }
          : { kind: "subgoal_done", summary: "got 1 log" };
      } },
      combat: { kind: "combat", systemPrompt: "", step: async () => ({ kind: "act", action: defaultMcuAction(), holdSteps: 1 }) },
      placing: { kind: "placing", systemPrompt: "", step: async () => ({ kind: "act", action: defaultMcuAction(), holdSteps: 1 }) },
    };
    const closedLoop = vi.fn(async () => ({ kind: "subgoal_done", summary: "crafted 4 planks" }));

    const deps = { client, plannerModel: "m", subagents, runClosedLoopStep: closedLoop as any };

    // Mock detectGuiSlots to return GUI slots starting on Frame 4
    let obsCount = 0;
    (SlotDetector.detectGuiSlots as any).mockImplementation(() => {
      obsCount += 1;
      return obsCount >= 4 ? { slots: [{}, {}] } : null;
    });

    // Frame 1: planner runs + first mining act
    let out = await dispatchObservation(deps, state, { imageBase64: "", contextId: "c" });
    expect(state.subgoals).toHaveLength(2);
    expect(state.idx).toBe(0);
    expect(state.singleTask).toBe(false);
    expect(out.taskDone).toBe(false);

    // Frame 2: more mining
    await dispatchObservation(deps, state, { imageBase64: "", contextId: "c" });
    // Frame 3: mining returns subgoal_done -> idx becomes 1
    await dispatchObservation(deps, state, { imageBase64: "", contextId: "c" });
    expect(state.idx).toBe(1);
    expect(state.completedSummaries).toEqual(["got 1 log"]);

    // Frame 4: ui_inventory subgoal -> closed loop returns subgoal_done -> idx out of bounds -> re-plan -> overall_done -> earlyStop
    out = await dispatchObservation(deps, state, { imageBase64: "", contextId: "c" });
    expect(state.earlyStop).toBe(true);
    expect(out.taskDone).toBe(true);

    // Frame 5: still earlyStop
    out = await dispatchObservation(deps, state, { imageBase64: "", contextId: "c" });
    expect(out.taskDone).toBe(true);
  });
});
