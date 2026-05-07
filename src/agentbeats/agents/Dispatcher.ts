import type OpenAI from "openai";
import type {
  EpisodeState,
  SubAgent,
  SubAgentKind,
  SubAgentStep,
} from "./SubAgent";
import { runPlannerLoop } from "./PlannerLoop";
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
  /** Optional debug sink — receives planner_turn_start / planner_assistant /
   *  planner_tool / planner_dispatch / planner_done / planner_error events. */
  recordDebug?: (kind: string, payload: unknown) => Promise<void> | void;
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

  if (state.subgoals.length === 0 || state.idx >= state.subgoals.length) {
    state.subgoals = []; state.idx = 0;
    const r = await runPlannerLoop(
      { client: deps.client, model: deps.plannerModel, recordDebug: deps.recordDebug },
      state, obs.imageBase64, obs.contextId,
    );
    if (r.kind === "done") { state.earlyStop = true; return NOOP_DONE; }
    if (r.kind === "error") {
      console.warn(`[dispatcher] planner error: ${r.reason}`);
      state.earlyStop = true; return NOOP_DONE;
    }
    state.subgoals = [r.subgoal];
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
    state.pendingReflection = { subgoal: current, outcome: "done", summary: step.summary };
    state.subgoals = []; state.idx = 0;  // force planner re-call next obs (which will see pendingReflection)
    return NOOP_ONE;
  }

  // subgoal_failed
  state.completedSummaries.push(`SUBGOAL_FAILED: ${step.reason}`);
  state.history.push(`failed: ${current.description} -> ${step.reason}`);
  state.pendingReflection = {
    subgoal: current,
    outcome: "failed",
    summary: step.reason,
    reportFields: step.reportFields,
  };
  state.subgoals = []; state.idx = 0;
  return NOOP_ONE;
}
