import type { McuEnvAction } from "../McuPrompt";
import type { ClosedLoopCraftPlan } from "../tools/UiFastControl";
import type { GuiLayout } from "../tools/SlotDetector";
import { TaskChecklist } from "./TaskChecklist";

export type SubAgentKind =
  | "ui_inventory"
  | "world_explore"
  | "mining"
  | "combat"
  | "placing"
  | "use_block";

export type Subgoal = {
  kind: SubAgentKind;
  description: string;
  success_criteria: string;
  /** Structured target identifier for sub-agents that act on a single
   *  named entity (placing.target / use_block.target = a block id like
   *  "crafting_table"). Required for kind="placing" and kind="use_block";
   *  ignored by other kinds. */
  target?: string;
  /** For kind="ui_inventory": which GUI is open and being operated.
   *  Tells the FastUI sub-agent the layout to expect. Set to a block
   *  id (e.g. "crafting_table", "furnace") for placed-block GUIs, or
   *  omit / pass "player_inventory" for the player's 2x2. The runtime
   *  no longer auto-opens the GUI from this field — use a separate
   *  use_block(target=<block>) dispatch first to open it. */
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
  };
}
