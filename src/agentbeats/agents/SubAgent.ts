import type { McuEnvAction } from "../McuPrompt";
import type { ClosedLoopCraftPlan } from "../tools/UiFastControl";
import type { GuiLayout } from "../tools/SlotDetector";
import type { WorldBlockOpener } from "../tools/WorldBlockOpener";
import { TaskChecklist } from "./TaskChecklist";

export type SubAgentKind =
  | "ui_inventory"
  | "world_explore"
  | "mining"
  | "combat"
  | "placing";

export type Subgoal = {
  kind: SubAgentKind;
  description: string;
  success_criteria: string;
  /** Structured target identifier for sub-agents that act on a single
   *  named entity (e.g. placing.target = "crafting_table"). Required
   *  for kind="placing"; ignored by other kinds today. */
  target?: string;
  /** For kind="ui_inventory": the GUI the agent must interact with.
   *  When omitted (or "player_inventory"), the runtime opens the
   *  player's 2x2 inventory via the inventory key. When set to a
   *  block id (e.g. "crafting_table", "furnace", "chest"), the
   *  runtime expects that block to already be visible in the world
   *  and runs a VLM-guided align loop to centre it on the crosshair
   *  before emitting use=1 to open its GUI. If the block is not
   *  visible after a bounded search the subagent escalates
   *  target_ui_not_in_view to the planner. */
  gui_target?: string;
};

export type SubAgentStep =
  | { kind: "act"; action: McuEnvAction; holdSteps: number }
  | { kind: "subgoal_done"; summary: string }
  | { kind: "subgoal_failed"; reason: string; reportFields?: Record<string, unknown> };

export interface SubAgentStepInput {
  obs: { imageBase64: string; inventory?: unknown };
  subgoal: Subgoal;
  history: string[];
  layout?: GuiLayout | null;
  contextId: string;
  iteration: number;
}

export interface SubAgent {
  kind: SubAgentKind;
  systemPrompt: string;
  step(input: SubAgentStepInput): Promise<SubAgentStep>;
}

export type EpisodeState = {
  taskText: string;
  subgoals: Subgoal[];
  idx: number;
  completedSummaries: string[];
  earlyStop: boolean;
  uiState: ClosedLoopCraftPlan | null;
  history: string[];
  iteration: number;
  plannerMessages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_call_id?: string;
    tool_calls?: any[];
  }>;
  checklist: TaskChecklist;
  pendingReflection: {
    subgoal: Subgoal;
    outcome: "done" | "failed";
    summary: string;
    reportFields?: Record<string, unknown>;
  } | null;
  /** Set lazily by Dispatcher when the current subgoal has gui_target and
   *  the agent is still in world view; consumed each step until the opener
   *  reports done (GUI open) or fail (target_ui_not_in_view). Cleared on
   *  subgoal completion. */
  worldBlockOpener: WorldBlockOpener | null;
};

export function makeEpisodeState(taskText: string): EpisodeState {
  return {
    taskText,
    subgoals: [],
    idx: 0,
    completedSummaries: [],
    earlyStop: false,
    uiState: null,
    history: [],
    iteration: 0,
    plannerMessages: [],
    checklist: new TaskChecklist(),
    pendingReflection: null,
    worldBlockOpener: null,
  };
}
