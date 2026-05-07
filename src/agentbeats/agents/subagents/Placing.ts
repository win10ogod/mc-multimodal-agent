import type { SubAgent, SubAgentStep, SubAgentStepInput } from "../SubAgent";
import { PLACING_SYSTEM_PROMPT } from "../../prompts/subagents/placing";
import { callWorldVlm, type WorldSubAgentDeps } from "./WorldExplorer";
import { HotbarVerifier } from "../../tools/HotbarVerifier";
import { defaultMcuAction, type McuButtonKey, type McuEnvAction } from "../../McuPrompt";

type PlacingPhase = "equip" | "post_equip";

type PlacingState = {
  subgoalKey: string;
  target: string;
  phase: PlacingPhase;
  verifier: HotbarVerifier | null;
  equippedSlot: number | null;
};

const HOTBAR_KEYS: ReadonlyArray<McuButtonKey> = [
  "hotbar.1", "hotbar.2", "hotbar.3", "hotbar.4", "hotbar.5",
  "hotbar.6", "hotbar.7", "hotbar.8", "hotbar.9",
];

function emittedHotbarSlot(action: McuEnvAction): number | null {
  for (let i = 0; i < HOTBAR_KEYS.length; i += 1) {
    const k = HOTBAR_KEYS[i]!;
    if ((action as Record<string, number | [number, number]>)[k] === 1) {
      return i + 1;
    }
  }
  return null;
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
          state.phase = "post_equip";
          state.equippedSlot = r.equippedSlot;
          return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
        }
        return { kind: "subgoal_failed", reason: r.reason, reportFields: r.reportFields };
      }

      const llmStep = await callWorldVlm(deps, PLACING_SYSTEM_PROMPT, input, "placing");
      if (llmStep.kind === "act") {
        const slot = emittedHotbarSlot(llmStep.action);
        if (slot !== null) {
          return {
            kind: "subgoal_failed",
            reason: `post_equip_hotbar_switch: attempted hotbar.${slot} after equip on hotbar.${state.equippedSlot}`,
            reportFields: {
              code: "post_equip_hotbar_switch",
              item: state.target,
              equippedSlot: state.equippedSlot,
              attemptedSlot: slot,
            },
          };
        }
      }
      return llmStep;
    },
  };
}
