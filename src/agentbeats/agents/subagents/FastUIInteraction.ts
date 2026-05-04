import type {
  SubAgent,
  SubAgentStep,
  SubAgentStepInput,
} from "../SubAgent";
import { UI_INVENTORY_SYSTEM_PROMPT } from "../../prompts/subagents/ui_inventory";
import type { ClosedLoopCraftPlan } from "../../tools/UiFastControl";
import { planClosedLoopCraft } from "../../tools/UiFastControl";
import type OpenAI from "openai";

export type FastUIDeps = {
  client: OpenAI;
  model: string;
  /** Called once per step with the current plan; returns either the next env
   *  action to emit, or a done/failed signal. The Dispatcher wires this to
   *  the existing closed-loop body in McuPolicy. */
  runOneClosedLoopStep: (args: {
    plan: ClosedLoopCraftPlan;
    obsBase64: string;
    contextId: string;
    iteration: number;
    subgoalDescription: string;
  }) => Promise<SubAgentStep>;
};

export function createFastUIInteraction(deps: FastUIDeps): SubAgent & {
  getOrInitPlan(taskText: string, current: ClosedLoopCraftPlan | null): ClosedLoopCraftPlan;
} {
  return {
    kind: "ui_inventory",
    systemPrompt: UI_INVENTORY_SYSTEM_PROMPT,
    getOrInitPlan(taskText, current) {
      return current ?? planClosedLoopCraft(taskText);
    },
    async step(_input: SubAgentStepInput): Promise<SubAgentStep> {
      // The closed-loop owns plan mutation across iterations and needs a
      // concrete ClosedLoopCraftPlan reference, not the SubAgent input. The
      // Dispatcher calls runOneClosedLoopStep directly when routing to
      // ui_inventory; .step() exists only for SubAgent registry conformance.
      throw new Error(
        "FastUIInteraction.step is unsupported; call deps.runOneClosedLoopStep via the Dispatcher",
      );
    },
  };
}
