import type { SubAgent, SubAgentStep, SubAgentStepInput } from "../SubAgent";
import { PLACING_SYSTEM_PROMPT } from "../../prompts/subagents/placing";
import { type WorldSubAgentDeps } from "./WorldExplorer";
import { HotbarVerifier } from "../../tools/HotbarVerifier";
import { defaultMcuAction, type McuEnvAction } from "../../McuPrompt";

// Phase machine:
//   equip    : runtime HotbarVerifier sweeps hotbar slots, OCR-confirms target
//   aim_down : single hard camera tilt down so the crosshair lands on ground
//   settle   : noop frame to let camera lerp finish before use
//   place    : single use=1 frame
//   post     : noop frame to let MC register the placement
//   done     : returns subgoal_done; planner verifies via inspect_inventory/visual.
//
// We deliberately keep the LLM out of the place macro: in eval cake (run 3) the
// LLM held the verified crafting_table for 54 frames and never committed to
// use=1 — it kept emitting micro camera tilts. A deterministic 5-frame macro
// guarantees a place attempt; if the world is genuinely obstructed the planner
// will re-dispatch after seeing no crafting_table on its next inspect.
type PlacingPhase = "equip" | "aim_down" | "settle" | "place" | "post" | "done";

type PlacingState = {
  subgoalKey: string;
  target: string;
  phase: PlacingPhase;
  verifier: HotbarVerifier | null;
  equippedSlot: number | null;
};

// Hard tilt — measured from MC: pitch +45 deg from neutral horizon points the
// crosshair at the ground tile ~1 block in front of the player on flat terrain.
const PLACE_PITCH_DEG = 45;

function camAction(yawDeg: number, pitchDeg: number): McuEnvAction {
  const a = defaultMcuAction();
  a.camera = [yawDeg, pitchDeg];
  return a;
}

function useAction(): McuEnvAction {
  const a = defaultMcuAction();
  a.use = 1;
  return a;
}

function noop(): McuEnvAction {
  return defaultMcuAction();
}

/** Resolve the placing target. Prefer the structured subgoal.target field
 *  (filled by the GoalPlanner via dispatch_subgoal). Fall back to a regex
 *  on the description for backwards compat when an older planner doesn't
 *  pass target — but log a warning so we notice the planner regression. */
function resolvePlacingTarget(subgoal: { target?: string; description: string }): string | null {
  if (subgoal.target && /^[a-z][a-z0-9_]+$/.test(subgoal.target)) {
    return subgoal.target.toLowerCase();
  }
  const m = subgoal.description.match(/\bplace\s+(?:(?:a|an|the)\s+)?([a-z][a-z0-9_]+)/i);
  if (m) {
    console.warn(`[placing] subgoal.target missing; fell back to regex parse of description: "${subgoal.description}" -> ${m[1]}`);
    return m[1].toLowerCase();
  }
  return null;
}

export function createPlacing(deps: WorldSubAgentDeps): SubAgent {
  let state: PlacingState | null = null;

  function resetForSubgoal(
    subgoal: SubAgentStepInput["subgoal"],
    contextId: string,
  ): PlacingState | null {
    const target = resolvePlacingTarget(subgoal);
    if (!target) return null;
    return {
      subgoalKey: subgoal.description,
      target,
      phase: "equip",
      verifier: new HotbarVerifier({
        target,
        deps,
        contextId,
        subgoalDescription: subgoal.description,
      }),
      equippedSlot: null,
    };
  }

  return {
    kind: "placing",
    systemPrompt: PLACING_SYSTEM_PROMPT,
    step: async (input): Promise<SubAgentStep> => {
      if (!state || state.subgoalKey !== input.subgoal.description) {
        state = resetForSubgoal(input.subgoal, input.contextId);
        if (!state) {
          return {
            kind: "subgoal_failed",
            reason: `placing_target_unparseable: ${input.subgoal.description}`,
            reportFields: {
              code: "placing_target_unparseable",
              description: input.subgoal.description,
            },
          };
        }
      }

      if (state.phase === "equip") {
        const r = await state.verifier!.nextAction(input.obs.imageBase64);
        if (r.kind === "act") {
          return { kind: "act", action: r.action, holdSteps: r.holdSteps };
        }
        if (r.kind === "done") {
          state.phase = "aim_down";
          state.equippedSlot = r.equippedSlot;
          console.log(`[placing-macro] equip done → aim_down (target=${state.target}, slot=${r.equippedSlot})`);
          return { kind: "act", action: noop(), holdSteps: 1 };
        }
        return { kind: "subgoal_failed", reason: r.reason, reportFields: r.reportFields };
      }

      if (state.phase === "aim_down") {
        state.phase = "settle";
        console.log(`[placing-macro] aim_down → settle (camera=[0, +${PLACE_PITCH_DEG}])`);
        return { kind: "act", action: camAction(0, PLACE_PITCH_DEG), holdSteps: 2 };
      }

      if (state.phase === "settle") {
        state.phase = "place";
        console.log(`[placing-macro] settle → place`);
        return { kind: "act", action: noop(), holdSteps: 1 };
      }

      if (state.phase === "place") {
        state.phase = "post";
        console.log(`[placing-macro] place → post (use=1)`);
        return { kind: "act", action: useAction(), holdSteps: 2 };
      }

      if (state.phase === "post") {
        state.phase = "done";
        console.log(`[placing-macro] post → done`);
        return { kind: "act", action: noop(), holdSteps: 2 };
      }

      // phase === "done"
      console.log(`[placing-macro] subgoal_done target=${state.target}`);
      return {
        kind: "subgoal_done",
        summary: `placed ${state.target} via deterministic macro (equip hotbar.${state.equippedSlot} → tilt +${PLACE_PITCH_DEG} → use)`,
      };
    },
  };
}
