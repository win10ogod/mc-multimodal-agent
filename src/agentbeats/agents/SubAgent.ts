import type { McuEnvAction } from "../McuPrompt";
import type { ClosedLoopCraftPlan } from "../tools/UiFastControl";
import type { GuiLayout } from "../tools/SlotDetector";
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
};

export type SubAgentStep =
  | { kind: "act"; action: McuEnvAction; holdSteps: number }
  | { kind: "subgoal_done"; summary: string }
  | { kind: "subgoal_failed"; reason: string };

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
  pendingReflection: { subgoal: Subgoal; outcome: "done" | "failed"; summary: string } | null;
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
