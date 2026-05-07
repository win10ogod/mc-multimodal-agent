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
import { WorldBlockOpener } from "../tools/WorldBlockOpener";

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

  // For ui_inventory dispatches with gui_target set (e.g. cake → use placed
  // crafting_table), run the WorldBlockOpener align+use macro before falling
  // through to the regular closed-loop step. Once the opener reports done,
  // the next observation should see the GUI open and closedLoopStep takes
  // over normally. On fail (target_ui_not_in_view) escalate to the planner.
  if (current.kind === "ui_inventory" && current.gui_target && current.gui_target !== "player_inventory" && !guiOpen) {
    if (!state.worldBlockOpener) {
      state.worldBlockOpener = new WorldBlockOpener({
        target: current.gui_target,
        deps: { client: deps.client, model: deps.plannerModel },
      });
    }
    const r = await state.worldBlockOpener.nextAction(obs.imageBase64);
    if (r.kind === "act") {
      return { action: r.action, holdSteps: r.holdSteps, taskDone: false };
    }
    if (r.kind === "done") {
      state.worldBlockOpener = null;
      // Emit one noop frame so the use=1 the opener emitted lands and the GUI
      // appears in the next observation; closedLoopStep will see it open.
      return NOOP_ONE;
    }
    // r.kind === "fail"
    state.worldBlockOpener = null;
    state.completedSummaries.push(`SUBGOAL_FAILED: ${r.reason}`);
    state.history.push(`failed: ${current.description} -> ${r.reason}`);
    state.pendingReflection = {
      subgoal: current,
      outcome: "failed",
      summary: r.reason,
      reportFields: r.reportFields,
    };
    state.subgoals = []; state.idx = 0;
    return NOOP_ONE;
  }

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
    state.worldBlockOpener = null;
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
  state.worldBlockOpener = null;
  return NOOP_ONE;
}
