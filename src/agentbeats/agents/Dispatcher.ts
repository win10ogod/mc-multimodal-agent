import type OpenAI from "openai";
import type {
  EpisodeState,
  SubAgent,
  SubAgentKind,
  SubAgentStep,
} from "./SubAgent";
import { planGoals } from "./GoalPlanner";
import { detectGuiSlots } from "../tools/SlotDetector";
import type { McuEnvAction } from "../McuPrompt";
import { defaultMcuAction } from "../McuPrompt";

export type DispatchDeps = {
  client: OpenAI;
  plannerModel: string;
  subagents: Record<SubAgentKind, SubAgent>;
  /** Direct closed-loop entry point — invoked when routing to ui_inventory.
   *  See FastUIInteraction.ts for why this bypasses SubAgent.step. */
  runClosedLoopStep: (args: {
    state: EpisodeState;
    obsBase64: string;
    contextId: string;
  }) => Promise<SubAgentStep>;
};

export type DispatchResult = {
  action: McuEnvAction;
  holdSteps: number;
  taskDone: boolean;
};

const NOOP_DONE: DispatchResult = { action: defaultMcuAction(), holdSteps: 1, taskDone: true };
const NOOP_ONE: DispatchResult = { action: defaultMcuAction(), holdSteps: 1, taskDone: false };

export async function dispatchObservation(
  deps: DispatchDeps,
  state: EpisodeState,
  obs: { imageBase64: string; inventory?: unknown; contextId: string },
): Promise<DispatchResult> {
  if (state.earlyStop) return NOOP_DONE;
  state.iteration += 1;

  if (state.subgoals.length === 0) {
    const out = await planGoals({ client: deps.client, model: deps.plannerModel }, state.taskText, state.completedSummaries);
    if (out.overall_done) { state.earlyStop = true; return NOOP_DONE; }
    state.subgoals = out.subgoals;
    // singleTask dropped in planner-first refactor — every task goes through planner loop
  }

  const current = state.subgoals[state.idx];
  if (!current) { state.earlyStop = true; return NOOP_DONE; }

  const guiOpen = (() => {
    try {
      const det = detectGuiSlots(obs.imageBase64);
      return (det?.slots?.length ?? 0) >= 2;
    } catch {
      return false;
    }
  })();
  const kind: SubAgentKind = guiOpen ? "ui_inventory" : current.kind;

  let step: SubAgentStep;
  if (kind === "ui_inventory") {
    step = await deps.runClosedLoopStep({ state, obsBase64: obs.imageBase64, contextId: obs.contextId });
  } else {
    const sa = deps.subagents[kind];
    step = await sa.step({
      obs,
      subgoal: current,
      history: state.history,
      contextId: obs.contextId,
      iteration: state.iteration,
    });
  }

  if (step.kind === "act") {
    return { action: step.action, holdSteps: step.holdSteps, taskDone: false };
  }

  if (step.kind === "subgoal_done") {
    state.completedSummaries.push(step.summary);
    state.history.push(`done: ${current.description} -> ${step.summary}`);
    state.idx += 1;
    if (state.idx >= state.subgoals.length) {
      const out = await planGoals({ client: deps.client, model: deps.plannerModel }, state.taskText, state.completedSummaries);
      if (out.overall_done || out.subgoals.length === 0) { state.earlyStop = true; return NOOP_DONE; }
      state.subgoals = out.subgoals;
      state.idx = 0;
    }
    return NOOP_ONE;
  }

  // subgoal_failed
  state.history.push(`failed: ${current.description} -> ${step.reason}`);
  const out = await planGoals({ client: deps.client, model: deps.plannerModel }, state.taskText, [...state.completedSummaries, `FAILED: ${step.reason}`]);
  if (out.overall_done || out.subgoals.length === 0) { state.earlyStop = true; return NOOP_DONE; }
  state.subgoals = out.subgoals;
  state.idx = 0;
  return NOOP_ONE;
}
