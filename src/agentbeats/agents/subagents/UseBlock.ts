import type { SubAgent, SubAgentStep, SubAgentStepInput } from "../SubAgent";
import { type WorldSubAgentDeps } from "./WorldExplorer";
import { WorldBlockOpener } from "../../tools/WorldBlockOpener";
import { detectGuiSlots } from "../../tools/SlotDetector";
import { defaultMcuAction } from "../../McuPrompt";

const SYSTEM_PROMPT = `Find the requested placed block in view and right-click it to open its GUI. Used by the GoalPlanner as the bridge between "block is placed in the world" and "GUI is open and ready for slot work".`;

const RENDER_WAIT_FRAMES = 6;

type UseBlockState = {
  subgoalKey: string;
  target: string;
  opener: WorldBlockOpener | null;
  phase: "scanning" | "wait_render";
  renderWaitFramesLeft: number;
};

function noop() {
  return defaultMcuAction();
}

export function createUseBlock(deps: WorldSubAgentDeps): SubAgent {
  let state: UseBlockState | null = null;

  return {
    kind: "use_block",
    systemPrompt: SYSTEM_PROMPT,
    step: async (input: SubAgentStepInput): Promise<SubAgentStep> => {
      // Reset on subgoal change.
      if (!state || state.subgoalKey !== input.subgoal.description) {
        const target = input.subgoal.target;
        if (!target) {
          return {
            kind: "subgoal_failed",
            reason: `use_block requires subgoal.target (snake_case block id)`,
            reportFields: { code: "use_block_target_missing", description: input.subgoal.description },
          };
        }
        state = {
          subgoalKey: input.subgoal.description,
          target,
          opener: new WorldBlockOpener({ target, deps }),
          phase: "scanning",
          renderWaitFramesLeft: RENDER_WAIT_FRAMES,
        };
      }

      if (state.phase === "scanning") {
        const r = await state.opener!.nextAction(input.obs.imageBase64);
        if (r.kind === "act") {
          return { kind: "act", action: r.action, holdSteps: r.holdSteps };
        }
        if (r.kind === "done") {
          // WBO finished its align + use=1 macro. MC takes 1-3 frames
          // to render the just-opened block GUI; hold a noop budget
          // and check guiOpen each frame instead of returning success
          // immediately on a frame where the GUI hasn't rendered yet.
          state.opener = null;
          state.phase = "wait_render";
          state.renderWaitFramesLeft = RENDER_WAIT_FRAMES;
          return { kind: "act", action: noop(), holdSteps: 1 };
        }
        // r.kind === "fail"
        const reason = r.reason;
        const reportFields = r.reportFields;
        state = null;
        return { kind: "subgoal_failed", reason, reportFields };
      }

      // wait_render: poll guiOpen each frame until detected or budget runs out.
      const det = detectGuiSlots(input.obs.imageBase64);
      const guiOpen = (det?.slots?.length ?? 0) >= 2;
      if (guiOpen) {
        const target = state.target;
        state = null;
        return { kind: "subgoal_done", summary: `use_block opened ${target} GUI; ready for slot work` };
      }
      state.renderWaitFramesLeft -= 1;
      if (state.renderWaitFramesLeft <= 0) {
        const target = state.target;
        state = null;
        return {
          kind: "subgoal_failed",
          reason: `use_block: WBO completed but ${target} GUI never rendered within ${RENDER_WAIT_FRAMES} frames`,
          reportFields: { code: "gui_render_timeout", target },
        };
      }
      return { kind: "act", action: noop(), holdSteps: 1 };
    },
  };
}
