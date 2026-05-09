import type { SubAgent, SubAgentStep, SubAgentStepInput } from "../SubAgent";
import { PLACING_SYSTEM_PROMPT } from "../../prompts/subagents/placing";
import { type WorldSubAgentDeps } from "./WorldExplorer";
import { HotbarVerifier } from "../../tools/HotbarVerifier";
import { hotbarBannerMatch } from "../../tools/HotbarOcr";
import { defaultMcuAction, type McuButtonKey, type McuEnvAction } from "../../McuPrompt";

// Phase machine (jump-place macro):
//   equip       : runtime HotbarVerifier sweeps hotbar slots, OCR-confirms target
//   aim_down    : single hard camera tilt down so the crosshair lands on ground
//   settle      : noop frame to let camera lerp finish before jumping
//   jump        : jump=1 frame on its own — the MCU encoding cannot deliver
//                 jump+use in the same tick, so we split them across frames
//   midair      : noop frames while the player rises toward the jump apex;
//                 use=1 must land while still off-ground so MC places the
//                 block on the tile the player just left, then lands on top
//   place       : use=1 frame (no jump key) — places block beneath the player
//   post        : noop frame to let MC register the placement and the player
//                 land before the swap-banner verify chain runs
//   done        : returns subgoal_done; planner verifies via inspect_inventory/visual.
//
// Why jump-place instead of "aim ahead and use": when the agent stands on
// terrain where the +45° tilt aims the crosshair at the player's own hitbox
// or at a non-solid face (grass, edge of a slope), use=1 silently no-ops and
// the OCR verify reports place_did_not_consume. Jump-place sidesteps this:
// the tile directly under the player is always a solid block face after jump.
//
// We deliberately keep the LLM out of the place macro: in eval cake (run 3) the
// LLM held the verified crafting_table for 54 frames and never committed to
// use=1 — it kept emitting micro camera tilts. A deterministic macro
// guarantees a place attempt; if the world is genuinely obstructed the planner
// will re-dispatch after seeing no crafting_table on its next inspect.
type PlacingPhase =
  | "equip"
  | "aim_down"
  | "settle"
  | "jump"
  | "midair"
  // sneak_engage: when the subgoal asks for sneak (e.g. placing onto a
  // crafting_table or chest face that would otherwise open a GUI on use),
  // we hold sneak for one tick before firing the place tick. Sneaking
  // suppresses MC's "use" interaction on the target block, so the right-
  // click is interpreted as a block placement instead.
  | "sneak_engage"
  | "place"
  | "post"
  // Post-place verify phases (FastUI-inspired): swap away from equipped slot,
  // swap back to force the held-item banner to render again, settle, then
  // OCR the banner. If the target name still appears, the use=1 didn't
  // actually consume the item (obstructed, looking at sky, etc.) — escalate.
  | "verify_swap_away"
  | "verify_swap_to"
  | "verify_settle"
  | "verify_read"
  | "done";

type PlacingState = {
  subgoalKey: string;
  target: string;
  phase: PlacingPhase;
  verifier: HotbarVerifier | null;
  equippedSlot: number | null;
  verifySettleCounter: number;
  /** Remaining camera ticks to emit during aim_down. Each tick clips to
   *  ±10 deg per the encoder, so we accumulate pitch by emitting one
   *  per obs across multiple Placing.step() calls. */
  aimTicksRemaining: number;
  /** Remaining noop frames for the midair settle (player rises to apex). */
  midairTicksRemaining: number;
  /** When true, the macro inserts a sneak_engage tick before place and
   *  emits sneak=1 on the same tick as use=1. Needed when placing onto a
   *  block whose right-click would otherwise open a GUI (crafting_table,
   *  chest, furnace, etc.) — sneaking suppresses the use-interaction so
   *  the click is interpreted as a placement. */
  useSneak: boolean;
};

// Per-tick camera clip is ±10 deg. Look STRAIGHT DOWN (~90 deg pitch) so
// the crosshair is on the tile beneath the player. Combined with jump,
// this places the block on the player's standing tile (the player lands
// on top of the placed block — clean "place under player" behavior).
const PLACE_PITCH_PER_TICK = 10;
const AIM_DOWN_TICKS = 9; // 9 * 10 deg ≈ straight down from neutral horizon
const MIDAIR_TICKS = 5;   // ticks the player needs to reach jump apex

// McuEnvAction.camera is [delta_pitch, delta_yaw] (see McuPrompt system
// prompt and the cameraX/cameraY split in McuPolicy.toCompactMcuAgentActionPayload).
// Positive pitch = look DOWN; positive yaw = turn RIGHT.
function camAction(pitchDeg: number, yawDeg: number): McuEnvAction {
  const a = defaultMcuAction();
  a.camera = [pitchDeg, yawDeg];
  return a;
}

function useAction(): McuEnvAction {
  const a = defaultMcuAction();
  a.use = 1;
  return a;
}

function jumpAction(): McuEnvAction {
  const a = defaultMcuAction();
  a.jump = 1;
  return a;
}

function sneakAction(): McuEnvAction {
  const a = defaultMcuAction();
  a.sneak = 1;
  return a;
}

function sneakUseAction(): McuEnvAction {
  const a = defaultMcuAction();
  a.sneak = 1;
  a.use = 1;
  return a;
}

function hotbarAct(slot: number): McuEnvAction {
  const a = defaultMcuAction();
  (a as Record<McuButtonKey | "camera", unknown>)[`hotbar.${slot}` as McuButtonKey] = 1;
  return a;
}

function noop(): McuEnvAction {
  return defaultMcuAction();
}

const VERIFY_SETTLE_FRAMES = 1;

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
    // Subgoal description triggers sneak when it contains the word
    // "sneak" (case-insensitive). Planner can request sneak by writing
    // e.g. "place crafting_table on top of the chest (sneak)" — the
    // mention is enough; we don't need a structured field yet.
    const useSneak = /\bsneak\b/i.test(subgoal.description);
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
      verifySettleCounter: 0,
      aimTicksRemaining: AIM_DOWN_TICKS,
      midairTicksRemaining: MIDAIR_TICKS,
      useSneak,
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
        // Verifier reported full-sweep miss — terminal failure. Clear
        // closure state so the next planner re-dispatch (e.g. after a
        // fetch-from-inventory recovery) re-runs the verifier from
        // scratch instead of resuming a stale phase.
        state = null;
        return { kind: "subgoal_failed", reason: r.reason, reportFields: r.reportFields };
      }

      if (state.phase === "aim_down") {
        // Per-tick camera delta is clipped to ±10 deg by the encoder, so
        // we emit one camera tick per step() call until we've accumulated
        // a full pitch-down (~90 deg from neutral horizon). Each step()
        // call corresponds to one obs/tick, so 9 ticks at +10 deg lands
        // the crosshair on the tile directly beneath the player.
        if (state.aimTicksRemaining > 0) {
          state.aimTicksRemaining -= 1;
          const remaining = state.aimTicksRemaining;
          if (remaining === 0) {
            state.phase = "settle";
          }
          console.log(`[placing-macro] aim_down tick → camera=[+${PLACE_PITCH_PER_TICK}, 0] (remaining=${remaining})`);
          return { kind: "act", action: camAction(PLACE_PITCH_PER_TICK, 0), holdSteps: 1 };
        }
        // Should be unreachable, but fall through cleanly if it happens.
        state.phase = "settle";
      }

      if (state.phase === "settle") {
        state.phase = "jump";
        console.log(`[placing-macro] settle → jump`);
        return { kind: "act", action: noop(), holdSteps: 1 };
      }

      if (state.phase === "jump") {
        // Fire jump alone — the MCU encoding routes jump and use through
        // separate button groups, but the eval sim does not reliably
        // execute jump+use in the same tick. Splitting them across frames
        // ensures the player actually rises before the place fires.
        state.phase = "midair";
        console.log(`[placing-macro] jump → midair (jump=1)`);
        return { kind: "act", action: jumpAction(), holdSteps: 1 };
      }

      if (state.phase === "midair") {
        // Wait a few ticks for the player to rise toward the jump apex
        // so the upcoming use=1 lands while still off-ground. With the
        // crosshair pointing straight down, MC resolves the placement
        // against the top face of the tile the player just left — the
        // block ends up beneath the player's original position and the
        // player lands on top of it.
        if (state.midairTicksRemaining > 0) {
          state.midairTicksRemaining -= 1;
          const remaining = state.midairTicksRemaining;
          if (remaining === 0) {
            state.phase = state.useSneak ? "sneak_engage" : "place";
          }
          console.log(`[placing-macro] midair noop (remaining=${remaining})`);
          return { kind: "act", action: noop(), holdSteps: 1 };
        }
        state.phase = state.useSneak ? "sneak_engage" : "place";
      }

      if (state.phase === "sneak_engage") {
        // One tick of sneak=1 alone before the place tick. Without this
        // priming tick MC sometimes drops the sneak=1 component of the
        // sneak+use compound (similar to how jump+use is unreliable when
        // co-emitted). Holding sneak across the prior tick guarantees
        // the sneaking flag is set when the place use=1 fires.
        state.phase = "place";
        console.log(`[placing-macro] sneak_engage → place (sneak=1 priming tick)`);
        return { kind: "act", action: sneakAction(), holdSteps: 1 };
      }

      if (state.phase === "place") {
        state.phase = "post";
        if (state.useSneak) {
          console.log(`[placing-macro] place → post (sneak=1 + use=1)`);
          return { kind: "act", action: sneakUseAction(), holdSteps: 2 };
        }
        console.log(`[placing-macro] place → post (use=1)`);
        return { kind: "act", action: useAction(), holdSteps: 2 };
      }

      if (state.phase === "post") {
        const equipped = state.equippedSlot ?? 1;
        const swapAway = (equipped % 9) + 1;
        state.phase = "verify_swap_away";
        console.log(`[placing-macro] post → verify_swap_away (hotbar.${swapAway})`);
        return { kind: "act", action: hotbarAct(swapAway), holdSteps: 1 };
      }

      if (state.phase === "verify_swap_away") {
        const equipped = state.equippedSlot ?? 1;
        state.phase = "verify_swap_to";
        console.log(`[placing-macro] verify_swap_away → verify_swap_to (hotbar.${equipped})`);
        return { kind: "act", action: hotbarAct(equipped), holdSteps: 1 };
      }

      if (state.phase === "verify_swap_to") {
        state.phase = "verify_settle";
        state.verifySettleCounter = 0;
        console.log(`[placing-macro] verify_swap_to → verify_settle`);
        return { kind: "act", action: noop(), holdSteps: 1 };
      }

      if (state.phase === "verify_settle") {
        if (state.verifySettleCounter < VERIFY_SETTLE_FRAMES) {
          state.verifySettleCounter += 1;
          return { kind: "act", action: noop(), holdSteps: 1 };
        }
        state.phase = "verify_read";
        // Fall through to read on the same frame so the banner is freshest.
      }

      if (state.phase === "verify_read") {
        const result = await hotbarBannerMatch({
          client: deps.client,
          model: deps.model,
          obsBase64: input.obs.imageBase64,
          target: state.target,
          candidateLabel: `hotbar.${state.equippedSlot ?? "?"} (post-place verify)`,
        });
        console.log(`[placing-macro] verify_read observed=${JSON.stringify(result.observed)} match=${result.match}`);
        if (result.match) {
          // Banner still shows the target → place did not consume the item.
          // Most common cause: crosshair on sky / blocked by entity / the
          // target slot has a stack >1 (we placed one but more remain — the
          // place actually succeeded but the consume signal is ambiguous).
          // For stack=1 cases (typical for crafting_table in eval givens)
          // this is a true failure signal; escalate so the planner can
          // re-dispatch and re-run the macro.
          const target = state.target;
          const equippedSlot = state.equippedSlot;
          state = null;
          return {
            kind: "subgoal_failed",
            reason: `place_did_not_consume: ${target} still on hotbar.${equippedSlot} after use=1`,
            reportFields: {
              code: "place_did_not_consume",
              item: target,
              equippedSlot,
              observed: result.observed,
            },
          };
        }
        state.phase = "done";
        // Fall through to done.
      }

      // phase === "done"
      console.log(`[placing-macro] subgoal_done target=${state.target} (verified consumed)`);
      const summary = `placed ${state.target} via under-player macro (equip hotbar.${state.equippedSlot} → pitch +${AIM_DOWN_TICKS * PLACE_PITCH_PER_TICK} → jump → use → verified item consumed)`;
      // Clear closure state so a future re-dispatch (e.g. another
      // placing subgoal in the same purple process for a re-tried or
      // chained recipe) starts a fresh equip/verify sweep instead of
      // short-circuiting straight to done.
      state = null;
      return {
        kind: "subgoal_done",
        summary,
      };
    },
  };
}
