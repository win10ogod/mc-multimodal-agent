import type OpenAI from "openai";
import type { McuObservationPayload, McuContextState } from "../McuPolicy";
import type { EpisodeState, SubAgentStep } from "./SubAgent";
import type { McuPolicyDecision } from "../McuPrompt";
import {
  defaultMcuAction,
  MCU_BUTTON_KEYS,
} from "../McuPrompt";
import {
  servoCursorStep,
  lookupRecipe,
  makeServoIntegrator,
} from "../tools/UiFastControl";
import { detectCursorWithExpectation, detectGuiLayout, detectGuiSlots, samplePatchFingerprint, samplePatchPixels, patchSimilarity } from "../tools/SlotDetector";
import { repairDecisionForTask, shouldUseModelOnStep } from "../McuPolicyUtils";
import type { UiFastControlFrame } from "../tools/UiFastControl";

export type ClosedLoopDeps = {
  client: OpenAI;
  model: string;
  apiKey: string | undefined;
  maxHoldSteps: number;
  defaultHoldSteps: number;
  modelEveryNSteps: number;
  debugDir: string | null;
  recordDebug: (kind: string, payload: unknown, imageBase64?: string, imageExt?: "png" | "jpg") => Promise<void>;
  modelDecision: (context: McuContextState, step: number) => Promise<McuPolicyDecision>;
};

export type ClosedLoopInput = {
  /** Legacy context state — passed because the closed-loop body uses many of its fields */
  context: McuContextState;
  episode: EpisodeState;
  obsBase64: string;
  contextId: string;
  payload: McuObservationPayload;
  step: number;
};

export async function runClosedLoopStep(
  deps: ClosedLoopDeps,
  input: ClosedLoopInput,
): Promise<SubAgentStep> {
  const { context: state, payload, step } = input;

  // The current subgoal's description is the immediate intent the
  // GoalPlanner asked FastUI to handle this dispatch (e.g. "craft
  // enchanting_table" vs "verify inventory contains <items>" vs
  // "fill furnace with raw_iron and coal"). Distinct from
  // state.taskText, which is the EPISODE-level goal set once at init.
  // Surfaced so the FastUI Planner can branch on per-dispatch intent
  // (verify-only / organize / craft / smelt / etc.).
  const currentSubgoalDescription = input.episode.subgoals[input.episode.idx]?.description;

  // VLM-driven early stop: when the model previously set task_done=true,
  // do not call it again for the rest of the episode. Emit a dummy
  // no-op action each step. The benchmark cannot be early-ended by
  // the agent, but skipping API calls saves significant cost while
  // the env burns through its remaining max_steps.
  if (state.earlyStop) {
    return { kind: "subgoal_done", summary: "early-stop: task was already done" };
  }

  if (payload.obs) {
    state.recentObservationImages.push(payload.obs);
    state.recentObservationImages = state.recentObservationImages.slice(-3);
  }

  const emitMacroFrame = (frame: UiFastControlFrame): SubAgentStep => {
    const holdSteps = Math.max(
      1,
      Math.min(deps.maxHoldSteps, frame.holdSteps),
    );
    state.lastAction = frame.action;
    state.holdUntilStep = step + holdSteps - 1;
    state.recentActions.push(frame.action);
    state.recentActions = state.recentActions.slice(-16);
    console.log(
      `[agentbeats] macro step=${step} hold=${holdSteps} ${frame.label} action=${JSON.stringify({
        pressed: MCU_BUTTON_KEYS.filter((key) => frame.action[key] === 1),
        camera: frame.action.camera,
      })}`,
    );
    return { kind: "act", action: frame.action, holdSteps };
  };

  // Drain any queued macro frames first. Skip queued inventory=1 presses
  // when a GUI is already detected: pressing E toggles, so firing the
  // init-time "open inventory" macro after WorldBlockOpener has already
  // opened a 3x3 GUI (or after the player inventory is otherwise open)
  // would CLOSE the GUI and undo the prior step.
  while (state.pendingMacroFrames.length > 0) {
    const next = state.pendingMacroFrames[0];
    if (next.action.inventory === 1 && payload.obs) {
      let guiAlreadyOpen = false;
      try {
        const det = detectGuiSlots(payload.obs);
        guiAlreadyOpen = (det?.slots?.length ?? 0) >= 2;
      } catch { /* leave guiAlreadyOpen=false; emit frame as before */ }
      if (guiAlreadyOpen) {
        state.pendingMacroFrames.shift();
        if (state.pendingMacroFrames[0]?.label.endsWith(":settle_after_open")) {
          state.pendingMacroFrames.shift();
        }
        console.log(`[agentbeats] macro skipped open_inv (label=${next.label}) at step=${step} — GUI already open`);
        continue;
      }
    }
    return emitMacroFrame(state.pendingMacroFrames.shift()!);
  }

  // Auto-arm Planner re-judge whenever IBVS is idle (no pending click,
  // chain, or OCR batch) AND there's an active subtask in the checklist.
  // Any IBVS termination — successful chain end, OCR batch end, mismatch
  // abort, cursor-out-of-window safety bail — leaves us in this idle
  // state. Letting Planner observe + update the checklist on each idle
  // entry guarantees we never get stuck re-emitting the same subtask.
  if (
    state.closedLoopCraft
    && !state.closedLoopCraft.done
    && state.closedLoopCraft.sessionLayout != null
    && !state.closedLoopCraft.pendingClick
    && state.closedLoopCraft.pendingChain.length === 0
    && !state.closedLoopCraft.pendingOcrBatch
    && !state.closedLoopCraft.cursorVerifyJob
    && state.closedLoopCraft.checklist.length > 0
  ) {
    state.closedLoopCraft.judgeAfterChain = true;
  }

  // Compute the SoM-labeled image ONCE per obs and share it between
  // the Planner re-judge and the Action dispatch — both see the same
  // pixels with the same yellow badges. Layout is LOCKED at
  // session_lock (when the GUI first opens with cursor at park spot —
  // the only frame guaranteed to be free of tooltip occlusion /
  // dimmed-bg artefacts). Re-detecting per-obs here used to corrupt
  // the locked layout when the cursor was hovering an item. Reuse the
  // locked layout for SoM marking; if none yet (first obs of a new
  // GUI session), detect once just for marking — session_lock below
  // writes the authoritative copy.
  let markedObsForLLMs: string | null = null;
  if (state.closedLoopCraft && payload.obs) {
    try {
      const { markInventoryFrame } = await import("../tools/SlotMarker");
      const lockedLayout = state.closedLoopCraft.sessionLayout;
      const layoutForMark = lockedLayout
        ?? detectGuiLayout(payload.obs, state.closedLoopCraft.layoutHint ?? undefined);
      if (layoutForMark) {
        const marked = markInventoryFrame(payload.obs, layoutForMark as any);
        markedObsForLLMs = `data:image/png;base64,${marked.pngBase64}`;
      }
    } catch { /* fall back to raw */ }
  }


  // Planner re-judge after a successful chain. Fires once per arm.
  if (state.closedLoopCraft && state.closedLoopCraft.judgeAfterChain && payload.obs) {
    const cp = state.closedLoopCraft;
    cp.judgeAfterChain = false;
    try {
      // Cross-ref slotMemory pixel positions with the live layout to surface
      // concrete slot indices to the Planner (same shape Action sees).
      const sessionLayoutTyped = cp.sessionLayout as ReturnType<typeof detectGuiLayout> | null;
      const planLayoutSlots = sessionLayoutTyped?.slots ?? [];
      const knownSlotsForPlanner = cp.slotMemory.snapshot()
        .filter((e) => e.item && e.item !== "empty")
        .map((e) => {
          const closest = planLayoutSlots.reduce<{ s: typeof planLayoutSlots[number] | null; d: number }>(
            (acc, s) => {
              const d = Math.hypot(s.cx - e.x, s.cy - e.y);
              return d < acc.d ? { s, d } : acc;
            },
            { s: null, d: Number.POSITIVE_INFINITY },
          );
          return { index: closest.s?.index ?? 0, name: closest.s?.name, item: e.item };
        });
      const cursorHoldingItem = cp.cursorItemSignature
        ? (cp.cursorItemSignature.item ? `(holding ${cp.cursorItemSignature.item})` : "(holding something)")
        : null;
      const { runPlanner } = await import("./subagents/fastUi/Planner");
      const markedObs = markedObsForLLMs ?? payload.obs;
      const layoutSlotsForPlanner = (cp.sessionLayout as { slots: Array<{ index: number; name?: string; role?: string }> } | null)?.slots ?? [];
      const rj = await runPlanner({ client: deps.client, model: deps.model, recordDebug: deps.recordDebug }, {
        taskText: state.taskText,
        subgoalDescription: currentSubgoalDescription,
        recipeInfo: cp.recipeOverride,
        knownSlots: knownSlotsForPlanner,
        layoutSlots: layoutSlotsForPlanner,
        cursorHolding: cursorHoldingItem,
        currentChecklist: cp.checklist,
        trigger: "post_action",
        recentHistory: state.closedLoopHistory.slice(0, 3),
        obsBase64: markedObs,
      });
      cp.checklist = rj.checklist;
      if (rj.kind === "all_done") {
        // FastUI Planner all_done means the GUI checklist is complete
        // (e.g., the requested item is now in inventory). It does NOT
        // mean the whole episode is done — multi-task evals chain
        // multiple subgoals (place table → craft → place result → …)
        // and the top-level GoalPlanner is the only thing that can
        // judge overall completion. Mark the closed-loop plan done
        // to silence the post-action re-judge gate, but propagate
        // subgoal_done normally so Dispatcher records pendingReflection
        // and the GoalPlanner re-evaluates the checklist on the next obs.
        cp.done = true;
        // Surface what the player is now carrying so the GoalPlanner can
        // mark the right checklist item without re-inspecting the world.
        // We deliberately report items by NAME + COUNT only — no slot
        // indices, no pixel positions, no UI-specific raster IDs. Slot
        // numbering depends on which GUI is open (2x2 vs 3x3 vs chest
        // vs furnace), and the GoalPlanner doesn't care about that —
        // it only needs to know "<item> is now in your inventory".
        const counts = new Map<string, number>();
        for (const e of cp.slotMemory.snapshot()) {
          if (!e.item || e.item === "empty" || e.item === "unknown") continue;
          counts.set(e.item, (counts.get(e.item) ?? 0) + 1);
        }
        const itemsStr = counts.size > 0
          ? [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(", ")
          : "(none observed)";
        const recipeTarget = cp.recipeOverride?.target ?? null;
        const summary = recipeTarget
          ? `FastUI subgoal complete: ${recipeTarget} now in inventory (task=${state.taskText || "?"}). Items in inventory: ${itemsStr}`
          : `FastUI subgoal complete (task=${state.taskText || "?"}). Items in inventory: ${itemsStr}`;
        return { kind: "subgoal_done", summary };
      }
      cp.activeChecklistIdx = rj.nextIdx;
      // CURSOR INVARIANT GUARD: if cursor holds an item but the next
      // not-done step is pickup/take_result/verify_items_visible, the
      // planner LLM violated the cursor invariant. Auto-insert a
      // place_all recovery step so the runtime doesn't proceed to a
      // step that would swap or fail. Without this, a bad plan can
      // permanently corrupt slot state.
      if (cp.cursorItemSignature?.item) {
        const heldItem = cp.cursorItemSignature.item;
        const nextStep = cp.checklist.find((s, i) => i >= cp.activeChecklistIdx && !s.done);
        const nextKind = (nextStep?.task as { kind?: string } | undefined)?.kind;
        if (nextStep && (nextKind === "pickup" || nextKind === "take_result" || nextKind === "verify_items_visible")) {
          // Find an empty deposit slot — any slot index 11..36 not in known_slots, or fall back to 11.
          const occupied = new Set(knownSlotsForPlanner.map((k) => k.index));
          let dumpSlot = 11;
          for (let s = 11; s <= 36; s += 1) { if (!occupied.has(s)) { dumpSlot = s; break; } }
          const recovery = {
            id: `auto_recovery_${Date.now()}`,
            text: `AUTO: dump cursor (${heldItem}) into empty slot ${dumpSlot} before ${nextKind}`,
            task: { kind: "place_all" as const, destSlot: dumpSlot, expectedItem: heldItem },
            done: false,
            attempts: 0,
          };
          const insertAt = cp.checklist.indexOf(nextStep);
          cp.checklist.splice(insertAt, 0, recovery);
          cp.activeChecklistIdx = insertAt;
          console.warn(`[fastui-planner] CURSOR INVARIANT GUARD: planner returned ${nextKind} as next step while cursor holds ${heldItem}; auto-inserted place_all dest=${dumpSlot} recovery at idx ${insertAt}`);
        }
      }
    } catch (e) {
      console.warn(`[fastui-planner] post_action re-judge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Closed-loop crafting (Image-Based Visual Servoing):
  //   - Each obs: detect layout + cursor.
  //   - If no pendingClick: probe VLM for next action, set the click target.
  //   - With a pendingClick: emit ONE camera correction toward the slot,
  //     OR a click frame when the cursor is within tolerance of the target.
  //   - Repeats until VLM says "done" or iteration cap is hit.
  const plan = state.closedLoopCraft;
  if (plan && !plan.done && plan.iteration < plan.maxIterations && payload.obs) {
    // Each obs: detect the inventory window FRESH (CV-cheap) -- this is
    // how we know if the GUI is still open. If yes and we have a session
    // layout already, REUSE it so slot indices stay stable. If yes and
    // no session yet, capture one. If no window detected, RESET the
    // session (UI closed) and end the closed-loop.
    const liveLayout = detectGuiLayout(payload.obs, plan.layoutHint ?? undefined);
    if (!liveLayout) {
      console.log(`[agentbeats] closed-loop: inventory window no longer visible at step=${step}; resetting session`);
      // DEBUG: emit a gui_lost event so the debug dashboard renders the
      // raw obs frame at the moment the runtime gave up. Useful for
      // distinguishing (a) GUI never opened (right-click missed),
      // (b) GUI opened then closed, (c) GUI is open but the detector
      // failed to recognize it. Routed through recordDebug so the
      // image lands in the same imageFile-indexed events.jsonl that
      // local_tests/debug_dashboard.mjs already renders.
      const cleanedObs = payload.obs?.startsWith("data:image/")
        ? payload.obs.replace(/^data:image\/[a-z]+;base64,/, "")
        : payload.obs;
      void deps.recordDebug("gui_lost", {
        step,
        iteration: plan.iteration,
        layoutHint: plan.layoutHint ?? null,
        reason: "detectGuiLayout returned null after WBO/closed-loop entry — GUI not detected on the frame the closed-loop saw",
      }, cleanedObs, "jpg");
      plan.sessionLayout = null;
      plan.layoutHint = null;
      plan.pendingClick = null;
      plan.awaitingVerify = null;
      plan.done = true;
    } else if (plan.sessionLayout === null) {
      // First detection in this session -- lock it.
      plan.sessionLayout = liveLayout;
      plan.layoutHint = liveLayout.matchedLayoutId;
      console.log(`[agentbeats] closed-loop session locked: layout=${liveLayout.matchedLayoutId ?? "unknown"} slots=${liveLayout.slots.length}`);
    }
    const layout = (plan.sessionLayout as ReturnType<typeof detectGuiLayout> | null) ?? liveLayout;
    if (!layout) {
      // Already handled above (plan.done=true path)
    } else {
      const cursor = detectCursorWithExpectation(payload.obs, layout, null);
      plan.cursor = cursor ?? plan.cursor;

      // === Cursor-empty OCR verify (preempts everything) ===
      // Fires when a place_one/place_all returned no_op (or verify_slots
      // was refused) while cursorItemSignature was pinned. Held items
      // suppress slot tooltips in MC, so a readable tooltip on a known
      // slot proves the cursor is empty. Servo → hover → OCR → decide.
      // MUST run before the Planner / Action / probe-action handlers,
      // since verify_slots-refusal exits early at its own handler.
      if (plan.cursorVerifyJob && !plan.done) {
        const job = plan.cursorVerifyJob;
        const CV_SERVO_STEP_CAP = 20;
        const CV_HIT_THRESHOLD_PX = 5;

        if (job.phase === "servo") {
          const stepResult = servoCursorStep({
            cursor,
            target: job.target,
            button: "attack",
            hitThresholdPx: CV_HIT_THRESHOLD_PX,
          });
          job.servoSteps += 1;
          const arrived = !!cursor && Math.hypot(cursor.x - job.target.x, cursor.y - job.target.y) <= CV_HIT_THRESHOLD_PX;
          if (arrived || job.servoSteps > CV_SERVO_STEP_CAP) {
            job.phase = "hover_settle";
            job.hoverFrames = 0;
            console.log(`[cursor-verify] arrived at ${job.slotName ?? job.knownSlotIdx} (${job.target.x},${job.target.y}); hovering for tooltip`);
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          if (stepResult && !stepResult.click) {
            return { kind: "act", action: stepResult.action, holdSteps: 1 };
          }
          return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
        }

        if (job.phase === "hover_settle") {
          job.hoverFrames += 1;
          if (job.hoverFrames < 2) {
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          job.phase = "read";
          // Fall through to read on the same step — the OCR runs against
          // this frame which has had a hover frame to render.
        }

        if (job.phase === "read") {
          const { readTooltip } = await import("../tools/SlotOcr");
          let tooltipItem = "unknown";
          try {
            const r = await readTooltip({
              client: deps.client,
              model: deps.model,
              obsBase64: payload.obs ?? "",
              slotPos: { x: job.target.x, y: job.target.y },
              slotName: job.slotName,
            });
            tooltipItem = r.item;
          } catch (e) {
            console.warn(`[cursor-verify] readTooltip threw: ${e instanceof Error ? e.message : String(e)}`);
          }
          const matchesExpected = tooltipItem !== "empty" && tooltipItem !== "unknown" && tooltipItem === job.expectedItem;
          if (matchesExpected) {
            console.log(`[cursor-verify] tooltip="${tooltipItem}" matches expected — cursor confirmed EMPTY (clearing cursorItemSignature)`);
            const previouslyHeld = plan.cursorItemSignature?.item ?? "item";
            plan.cursorItemSignature = null;
            plan.pickupSourceSlot = null;
            state.closedLoopHistory.unshift(`cursor-verify (OCR-confirmed via tooltip): the ${previouslyHeld} the previous context said you were holding is now confirmed empty — it was fully placed/consumed in the prior step. The place_all destination is empty as expected; treat that subtask as completed and continue with the next recipe step.`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
          } else {
            // OCR returned "empty"/"unknown" or a different name. We're
            // using OCR to PROBE cursor state — when the cursor is holding,
            // MC suppresses ALL slot tooltips, so an "empty" reading on a
            // known-occupied slot is the EXPECTED holding signal, not
            // evidence that the slot is now empty. Do NOT update slotMemory
            // from cursor-verify OCR — that would erase legitimate context
            // (e.g. wipe the book entry at craft_3x3_1 because cursor was
            // suppressing its tooltip). Cursor state stays "holding"; the
            // outer planner gets a feedback line and can decide what to
            // do next.
            console.warn(`[cursor-verify] tooltip="${tooltipItem}" expected="${job.expectedItem}" — cursor probably STILL holding (tooltip suppressed by held item); leaving slotMemory and cursorItemSignature unchanged`);
            state.closedLoopHistory.unshift(`cursor-verify: OCR(${job.slotName ?? job.knownSlotIdx}) returned "${tooltipItem}" (expected "${job.expectedItem}"); cursor likely still holding ${plan.cursorItemSignature?.item ?? "(?)"} — slot memory preserved.`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
          }
          plan.cursorVerifyJob = null;
          // Either way, give control back to the Planner on the next obs.
          return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
        }
      }

      // Servo test mode: AGENTBEATS_SERVO_TEST=1 disables LLM /
      // Planner / Action and just cycles a hover-only pendingClick
      // through every hotbar+main_inv+craft slot. The trajectory
      // logger captures (cam, cursor) pairs each frame for offline
      // system identification (px-per-deg, deadzone boundaries,
      // CV-failure rates). No actual clicks are issued — kind=hover
      // exits the click servo before pressing attack/use.
      // Pickup test mode: AGENTBEATS_PICKUP_TEST=1 scripts a precise
      // sequence to exercise diff-based cursor-id end-to-end:
      //   step 0: park (capture parkEmptyCursorPatch baseline)
      //   step 1: verify_slots [38,39,40] (populate slot patches)
      //   step 2: pickup from slot 38 (cursor holds cobblestone)
      //   step 3: park → diff-id should log 'cursor-diff-id: cob'
      //   step 4: place_one slot 11 (free main_inv)
      //   step 5: park → diff-id should clear (cursor empty)
      // Pure CV-test, no LLM cost. Logs reveal whether diff-id
      // correctly identifies what the cursor holds vs what intent-
      // tracking thinks.
      if (process.env.AGENTBEATS_PICKUP_TEST === "1") {
        type PT = { phase: "park0" | "verify" | "pickup" | "park1" | "place" | "park2" | "done"; tickAfterIdle: number };
        const pt = (plan as unknown as { pickupTestState?: PT }).pickupTestState
          ?? (() => {
            const init: PT = { phase: "park0", tickAfterIdle: 0 };
            (plan as unknown as { pickupTestState: PT }).pickupTestState = init;
            console.log(`[pickup-test] init`);
            return init;
          })();
        if (plan.pendingClick === null && plan.pendingChain.length === 0 && !plan.pendingOcrBatch) {
          pt.tickAfterIdle += 1;
          // Wait a couple of probe ticks between phases so park
          // baseline / patch captures settle. Don't early-return —
          // we need the closed-loop probe block (which contains the
          // cursorHolding IIFE that runs cursor-diff-id) to execute
          // each tick. Just don't advance the phase yet.
          if (pt.tickAfterIdle < 2) {
            // fall through; phase stays the same
          } else {
          pt.tickAfterIdle = 0;
          if (pt.phase === "park0") {
            console.log(`[pickup-test] phase park0 done; parkEmptyCursorPatch=${plan.parkEmptyCursorPatch ? "captured" : "MISSING"}`);
            pt.phase = "verify";
          } else if (pt.phase === "verify") {
            const slots = layout.slots.filter((s) => [38, 39, 40].includes(s.index));
            if (slots.length > 0) {
              plan.pendingOcrBatch = {
                slots: slots.map((s) => ({ slot: s.index, x: s.cx, y: s.cy, name: s.name })),
                idx: 0, parking: false,
              };
              const first = plan.pendingOcrBatch.slots[0];
              plan.pendingClick = {
                rasterIndex: first.slot, slotName: first.name, slotRole: undefined,
                frozenTarget: { x: first.x, y: first.y },
                button: "attack", shift: false, expectAfter: "should_fill",
                phase: "servo", retries: 0, kind: "hover" as "click",
                actionKind: "pickup" as "pickup",
              };
              plan.servoSteps = 0;
              plan.skipNextPark = true;
              plan.pendingTooltipRead = { slotIndex: first.slot, x: first.x, y: first.y, slotName: first.name };
              console.log(`[pickup-test] phase verify: hovering slot ${first.slot}(${first.name ?? "?"})`);
            }
            pt.phase = "pickup";
          } else if (pt.phase === "pickup") {
            const fromSlot = layout.slots[38];
            if (fromSlot) {
              plan.pendingClick = {
                rasterIndex: fromSlot.index, slotName: fromSlot.name, slotRole: fromSlot.role,
                frozenTarget: { x: fromSlot.cx, y: fromSlot.cy },
                button: "attack", shift: false, expectAfter: "should_empty",
                phase: "servo", retries: 0, kind: "click" as "click",
                actionKind: "pickup" as "pickup",
              };
              plan.servoSteps = 0;
              console.log(`[pickup-test] phase pickup: clicking slot 38 (cob)`);
            }
            pt.phase = "park1";
          } else if (pt.phase === "park1") {
            console.log(`[pickup-test] phase park1: cursorItemSignature=${plan.cursorItemSignature?.item ?? "(none)"} — waiting at park for diff-id`);
            pt.phase = "place";
          } else if (pt.phase === "place") {
            const dest = layout.slots[11];
            if (dest) {
              plan.pendingClick = {
                rasterIndex: dest.index, slotName: dest.name, slotRole: dest.role,
                frozenTarget: { x: dest.cx, y: dest.cy },
                button: "attack", shift: false, expectAfter: "should_fill",
                phase: "servo", retries: 0, kind: "click" as "click",
                actionKind: "place_all" as "place_all",
                placedItemName: plan.cursorItemSignature?.item,
              };
              plan.servoSteps = 0;
              console.log(`[pickup-test] phase place: place_all at slot 11 (cob → main_inv_0)`);
            }
            pt.phase = "park2";
          } else if (pt.phase === "park2") {
            console.log(`[pickup-test] phase park2 (final): cursorItemSignature=${plan.cursorItemSignature?.item ?? "(none)"} ${plan.cursorItemSignature ? "STILL HOLDING (bug)" : "EMPTY (correct)"}`);
            pt.phase = "done";
          } else {
            console.log(`[pickup-test] all phases complete; ending session`);
            plan.done = true;
            state.earlyStop = true;
            return { kind: "subgoal_done", summary: "pickup-test complete" };
          }
          } // end else (tickAfterIdle >= 2)
        }
      }
      if (process.env.AGENTBEATS_SERVO_TEST === "1") {
        const servoTest = (plan as unknown as { servoTestState?: { idx: number; targets: number[] } }).servoTestState
          ?? (() => {
            const targets = layout.slots
              .filter((s) => s.role === "hotbar" || s.role === "main_inv" || s.role === "craft_2x2" || s.role === "craft_3x3")
              .map((s) => s.index);
            const init = { idx: 0, targets };
            (plan as unknown as { servoTestState: typeof init }).servoTestState = init;
            console.log(`[servo-test] init: ${targets.length} target slots queued`);
            return init;
          })();
        if (plan.pendingClick === null) {
          if (servoTest.idx >= servoTest.targets.length) {
            console.log(`[servo-test] all targets visited (${servoTest.targets.length}); ending session`);
            plan.done = true;
            state.earlyStop = true;
            return { kind: "subgoal_done", summary: "servo-test complete" };
          }
          const targetSlot = layout.slots[servoTest.targets[servoTest.idx]];
          servoTest.idx += 1;
          plan.pendingClick = {
            rasterIndex: targetSlot.index, slotName: targetSlot.name, slotRole: targetSlot.role,
            frozenTarget: { x: targetSlot.cx, y: targetSlot.cy },
            button: "attack", shift: false, expectAfter: "should_fill",
            phase: "servo", retries: 0, kind: "hover" as "click",
            actionKind: "pickup" as "pickup",
          };
          plan.servoSteps = 0;
          console.log(`[servo-test] target ${servoTest.idx}/${servoTest.targets.length}: slot ${targetSlot.index}(${targetSlot.name ?? "?"}) at (${targetSlot.cx},${targetSlot.cy})`);
        }
      }

      // Park the cursor in a clear left-side spot before each new
      // probe. This is REQUIRED so the VLM can clearly see whether
      // the cursor is carrying an item (held-item icon overlays the
      // cursor sprite). With the cursor anywhere over a slot, the
      // VLM cannot tell holding vs not-holding from the image alone.
      if (plan.pendingClick === null) {
        // Skip park if a previous "hover" action requested it (cursor
        // is intentionally on the slot the VLM wants to inspect so
        // MC's tooltip renders in the next probe image).
        if (plan.skipNextPark) {
          plan.skipNextPark = false;
          plan.parkSteps = 0;
          console.log(`[agentbeats] skipNextPark consumed; cursor stays at current spot for probe`);
          // OCR-on-settle: a verify_slots batch has cursor parked on
          // a slot; tooltip should be rendered. Read it, record memory,
          // advance the queue. After the last slot, servo back to the
          // park position before returning control to the main probe.
          if (plan.pendingTooltipRead) {
            const { readTooltip } = await import("../tools/SlotOcr");
            const target = plan.pendingTooltipRead;
            try {
              const r = await readTooltip({
                client: deps.client,
                model: deps.model,
                obsBase64: payload.obs ?? "",
                slotPos: { x: target.x, y: target.y },
                slotName: target.slotName,
              });
              // No retry: MC does not render a slot tooltip while
              // the cursor is holding an item; an "empty" reply in
              // that situation is the tooltip being suppressed, not
              // a transient miss, so retrying would hit the same
              // result. The agent must clear the cursor and re-issue
              // verify_slots if it really wants to inspect.
              // Do NOT capture fingerprint here. Cursor is on the
              // slot for OCR, which causes MC to draw a white hover
              // highlight on the item -- the fingerprint we'd
              // capture is brighter than the slot's natural
              // appearance and would not match later samples taken
              // when cursor is parked. Memory gets just the item
              // name now; the per-probe scan with cursor at park
              // will lazily populate the natural fingerprint.
              plan.slotMemory.record(target.x, target.y, r.item, plan.iteration);
              console.log(`[agentbeats] slot_ocr slot=${target.slotIndex}(${target.slotName ?? "?"}) -> ${r.item}`);
            } catch (e) {
              console.warn(`[agentbeats] slot OCR failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            plan.pendingTooltipRead = null;
          }
          // Advance the OCR batch.
          if (plan.pendingOcrBatch) {
            if (plan.pendingOcrBatch.parking) {
              // Cursor just finished parking; batch complete.
              console.log(`[agentbeats] verify_slots batch complete (parked)`);
              plan.pendingOcrBatch = null;
              // Refresh the park snapshot now that cursor is at park
              // and slot patches are clean (OCR pass mutated nothing,
              // but slot baselines may have been re-captured during
              // probe). Spec: 2026-05-07-park-snapshot-action-verify-design.md
              if (cursor && plan.sessionLayout) {
                const { takeLayoutSnapshot } = await import("../tools/SnapshotDiff");
                {
                  const sl = plan.sessionLayout as import("../tools/SlotDetector").GuiLayout;
                  // Fallback to last-known cursor position when current
                  // detection failed (held item can occlude the sprite).
                  // Last-known is closer to baseline-cursor than parkSpot.
                  plan.lastParkSnapshot = takeLayoutSnapshot(payload.obs, sl, cursor, plan.iteration, plan.parkEmptyCursorPatch, plan.lastProbeCursor);
                }
              }
              // Arm Planner re-judge: a verify_slots subtask just
              // finished and Known got fresh entries. Without this,
              // Planner never re-evaluates and the Action agent keeps
              // re-issuing verify_slots forever.
              plan.judgeAfterChain = true;
              // Fall through to probe.
            } else {
              plan.pendingOcrBatch.idx += 1;
              if (plan.pendingOcrBatch.idx < plan.pendingOcrBatch.slots.length) {
                const next = plan.pendingOcrBatch.slots[plan.pendingOcrBatch.idx];
                plan.pendingClick = {
                  rasterIndex: next.slot, slotName: next.name, slotRole: undefined,
                  frozenTarget: { x: next.x, y: next.y },
                  button: "attack", shift: false, expectAfter: "should_fill",
                  phase: "servo", retries: 0, kind: "hover" as "click",
                  actionKind: "pickup" as "pickup",
                };
                plan.servoSteps = 0;     // critical: new servo starts fresh, not under prior cap
                plan.skipNextPark = true;
                plan.pendingTooltipRead = { slotIndex: next.slot, x: next.x, y: next.y, slotName: next.name };
                console.log(`[agentbeats] verify_slots OCR advance idx=${plan.pendingOcrBatch.idx}/${plan.pendingOcrBatch.slots.length} slot=${next.slot}`);
                return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
              }
              // All slots OCR'd. Move cursor back to park position so
              // the next probe sees a clean cursor (not lingering on a
              // real slot which would change tooltip / risk a click).
              const parkSpot = { x: Math.min(632, layout.windowX + layout.windowW + 16), y: layout.windowY + 8 };
              plan.pendingClick = {
                rasterIndex: -1, slotName: "park", slotRole: undefined,
                frozenTarget: parkSpot,
                button: "attack", shift: false, expectAfter: "should_fill",
                phase: "servo", retries: 0, kind: "hover" as "click",
                actionKind: "pickup" as "pickup",
              };
              plan.servoSteps = 0;
              plan.skipNextPark = true;
              plan.pendingOcrBatch.parking = true;
              console.log(`[agentbeats] verify_slots OCR done; servoing cursor to park (${parkSpot.x},${parkSpot.y})`);
              return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
            }
          }
        } else {
        // Park step cap. Adaptive servo (commit fbdf91b) uses smaller
        // bins near target — cursor takes ~8 frames to reach park
        // from screen-center vs ~5 frames at the old 2-deg bin. Bump
        // the cap so park reliably arrives instead of giving up early.
        const PARK_STEP_CAP = 16;
        // Park at the TOP-LEFT corner of the window. Cursor sprite
        // tip at (parkSpot) extends down-right ~10x14 px into the
        // window header area where no inventory slots live. The
        // previous park (windowX+8, windowH/2) put the cursor right
        // ON main_inv_0 in the player_inventory layout, which then
        // contaminated every pre-check sample of that slot
        // (cursor + held-item pixels read as "filled" stddev~137).
        // Park OUTSIDE the inventory window. MC does allow the cursor
        // to leave the GUI window region while a GUI is open. Right
        // of the window puts the cursor in the dimmed world-view
        // region with no slot icons, so the patch sample there is
        // a stable baseline.
        const parkSpot = {
          x: Math.min(632, layout.windowX + layout.windowW + 16),
          y: layout.windowY + 8,
        };
        const distFromPark = cursor ? Math.hypot(cursor.x - parkSpot.x, cursor.y - parkSpot.y) : Infinity;
        if (distFromPark > 12 && plan.parkSteps < PARK_STEP_CAP) {
          const stepResult = servoCursorStep({
            cursor,
            target: parkSpot,
            button: "attack",
            hitThresholdPx: 8,
          });
          if (stepResult && !stepResult.click) {
            plan.parkSteps += 1;
            console.log(`[agentbeats] park step=${plan.parkSteps}/${PARK_STEP_CAP}: cursor=(${cursor?.x},${cursor?.y}) -> (${parkSpot.x},${parkSpot.y}) ${stepResult.reason}`);
            return { kind: "act", action: stepResult.action, holdSteps: 1 };
          }
        }
        if (plan.parkSteps >= PARK_STEP_CAP) {
          console.warn(`[agentbeats] park step cap reached (${plan.parkSteps}); proceeding to probe with cursor at (${cursor?.x},${cursor?.y})`);
        }
        plan.parkSteps = 0;
        } // end skipNextPark gate
        // Layout is LOCKED at session_lock and reused throughout servo.
        // Re-detecting here used to overwrite sessionLayout with a
        // degraded bbox whenever the cursor was hovering an item
        // (tooltip overlay breaks findWindowBBox). The locked layout
        // captured at park spot is authoritative; the servo just reads
        // pixels through it. UI-mutating actions return control to the
        // Planner, which re-locks from a clean park frame.
        const layoutForProbe = layout;
        // CV cursor-holding detection. Sample the held-item region
        // (renders below-right of the cursor tip in MC), not the
        // cursor arrow itself, so cursor-sprite pixels aren't part
        // of the signal. Compare to a baseline captured the first
        // time we know the cursor is empty (initial park).
        // Must match the parkSpot computed in the park-step block below.
        const PARK_X = Math.min(632, layout.windowX + layout.windowW + 16);
        const PARK_Y = layout.windowY + 8;
        // Tolerance must match the park-step's own 12-px arrival
        // gate -- park rarely lands within 6 px because cam moves
        // are quantized.
        const cursorAtPark = !!cursor && Math.hypot(cursor.x - PARK_X, cursor.y - PARK_Y) < 14;
        // Park-empty baseline capture. The legacy CV cursorHolding
        // signal that used to live here was UNRELIABLE (false-positive
        // on grey items + animated dimmed bg) and has been removed.
        // Cursor state is now exclusively tracked via plan.cursorItemSignature
        // (set on confirmed pickup, cleared on confirmed place_all).
        // We still need to capture parkEmptyCursorPatch — the SnapshotDiff
        // verify path uses it as the baseline reference.
        if (plan.parkEmptyCursorPatch === null && cursorAtPark && cursor) {
          const HELD_OFF_X = 8, HELD_OFF_Y = 8;
          // Stability gate: cursor must have been at park for two
          // consecutive probes (within 2 px) — avoids capturing the
          // baseline mid-servo when the cursor sprite is still slewing.
          const last = plan.lastProbeCursor;
          const stable = last !== null && Math.abs(last.x - cursor.x) <= 2 && Math.abs(last.y - cursor.y) <= 2;
          plan.lastProbeCursor = { x: cursor.x, y: cursor.y };
          if (stable) {
            const SAMPLE_X = cursor.x + HELD_OFF_X;
            const SAMPLE_Y = cursor.y + HELD_OFF_Y;
            const livePatch = samplePatchPixels(payload.obs, SAMPLE_X, SAMPLE_Y, 14);
            if (livePatch) {
              plan.parkEmptyCursorPatch = { w: livePatch.w, h: livePatch.h, rgba: livePatch.rgba };
              console.log(`[agentbeats] park baseline captured: cursor=(${cursor.x},${cursor.y}) + 14x14 cursor patch`);
            }
          } else {
            console.log(`[agentbeats] park baseline deferred: cursor=(${cursor.x},${cursor.y}) ${last ? `prev=(${last.x},${last.y})` : "no prev"} — waiting for stable frame`);
          }
        } else if (cursor) {
          plan.lastProbeCursor = { x: cursor.x, y: cursor.y };
        }
        try {
          // Build slot-memory snapshot keyed to current raster indices so
          // the probe sees "slot 1 = cobblestone (read 4 iters ago)" etc.
          // Each detected slot's absolute pixel pos is looked up in
          // slotMemory; matched entries become the probe's known-contents
          // hint, freeing the agent from re-hovering identified slots.
          plan.slotMemory.pruneStale(plan.iteration);
          const knownSlots: Array<{ index: number; name?: string; item: string; ageIters: number }> = [];
          // CV item tracking from the CURRENT PROBE FRAME (cursor is
          // parked here, no hover highlight). Pass A: for each slot
          // in memory, lazily capture its natural fingerprint OR
          // detect it just emptied (item disappeared). Pass B: for
          // each disappeared item, scan all currently-occupied slots
          // not in memory to find where the item moved -- match by
          // RGB-mean distance to the disappeared item's fingerprint.
          // Pass A staging: items invalidated in this probe; Pass B
          // uses the saved fingerprints to find them at new slots.
          const disappearedItems: string[] = [];
          const disappearedFps: Array<{ item: string; fp: { meanR: number; meanG: number; meanB: number; stddev: number } }> = [];
          for (const s of layoutForProbe.slots) {
            const mem = plan.slotMemory.lookup(s.cx, s.cy);
            if (!mem || mem.item === "empty" || mem.item === "unknown") continue;
            const live = samplePatchFingerprint(payload.obs, s.cx, s.cy, 6);
            if (!live) {
              knownSlots.push({ index: s.index, name: s.name, item: mem.item, ageIters: plan.iteration - mem.step });
              continue;
            }
            if (!mem.fingerprint || !mem.patch) {
              // Lazy baseline capture from the probe frame (no hover).
              // Also capture pixel-level patch with BG masked — used
              // as the authoritative tie-breaker when fp/stddev alone
              // can't separate two items with similar mean RGB.
              const patch = samplePatchPixels(payload.obs, s.cx, s.cy, 14) ?? undefined;
              plan.slotMemory.record(s.cx, s.cy, mem.item, mem.step, mem.fingerprint ?? live, mem.patch ?? patch);
              console.log(`[agentbeats] baseline captured slot ${s.index}(${s.name ?? "?"}) item='${mem.item}' fp=(${live.meanR.toFixed(0)},${live.meanG.toFixed(0)},${live.meanB.toFixed(0)}) stddev=${live.stddev.toFixed(1)} patch=${patch ? `${patch.w}x${patch.h}` : "no"}`);
              knownSlots.push({ index: s.index, name: s.name, item: mem.item, ageIters: plan.iteration - mem.step });
              continue;
            }
            const dr = live.meanR - mem.fingerprint.meanR;
            const dg = live.meanG - mem.fingerprint.meanG;
            const db = live.meanB - mem.fingerprint.meanB;
            const distFromBaseline = Math.sqrt(dr * dr + dg * dg + db * db);
            const liveLum = (live.meanR + live.meanG + live.meanB) / 3;
            const liveLooksEmpty = live.stddev < 20 && liveLum > 120 && liveLum < 160;
            // Authoritative tie-breaker: pixel-level patch similarity.
            // When fp/stddev says "maybe drifted" but patch says "same
            // pixels", trust the patch — it's the only signal that
            // can discriminate items with near-identical mean RGB.
            const livePatch = samplePatchPixels(payload.obs, s.cx, s.cy, 14);
            const patchSim = livePatch && mem.patch ? patchSimilarity(mem.patch, livePatch) : null;
            // Pass A: probe-time disappearance scan (baseline 6398f3f
            // contract). The slot's CV-live patch drifted FAR from
            // its OCR-time fingerprint AND visually looks like the
            // empty-slot grey band → the item left this slot.
            // Invalidate the entry and stage the disappeared identity
            // for Pass B's appearance match. Runs ONLY at probe time
            // (cursor parked, no hover highlight contamination), so
            // a single-frame trigger is safe — Pass A doesn't fire
            // mid-chain. Disabling this scan was the regression vs
            // baseline: source slots stayed "filled" in slotMemory
            // long after the agent picked from them.
            // Pixel-level patch authority: when patch similarity is
            // HIGH (≥0.75), trust the slot still has the same item
            // even if mean RGB drifted (e.g. hover highlight, stack
            // count digits changed). When patch similarity is LOW
            // (<0.45), confirm the item identity changed.
            const patchSaysSame = patchSim !== null && patchSim >= 0.75;
            const patchSaysDifferent = patchSim !== null && patchSim < 0.45;
            if (distFromBaseline > 40 && liveLooksEmpty && !patchSaysSame) {
              disappearedItems.push(mem.item);
              if (mem.fingerprint) disappearedFps.push({ item: mem.item, fp: mem.fingerprint });
              plan.slotMemory.invalidate(s.cx, s.cy);
              if (!plan.cursorItemSignature && mem.fingerprint) {
                plan.cursorItemSignature = {
                  meanR: mem.fingerprint.meanR,
                  meanG: mem.fingerprint.meanG,
                  meanB: mem.fingerprint.meanB,
                  item: mem.item,
                };
                console.log(`[agentbeats] inferred cursor holding '${mem.item}' from disappearance at slot ${s.index}(${s.name ?? "?"})`);
              }
              console.log(`[agentbeats] item disappeared: '${mem.item}' was at slot ${s.index}(${s.name ?? "?"}) -- dist=${distFromBaseline.toFixed(1)} patchSim=${patchSim?.toFixed(2) ?? "n/a"} liveLum=${liveLum.toFixed(1)} live.stddev=${live.stddev.toFixed(1)}`);
              continue;
            }
            // SWAP DETECTION: slot still looks filled but pixel patch
            // says the contents are DIFFERENT (low patch similarity)
            // AND cursor was holding a different item. MC's click
            // semantics: clicking a filled slot with non-empty cursor
            // swaps contents. Patch-similarity beats fp-drift here —
            // mean RGB can drift for benign reasons (hover, stack
            // count) but the actual icon pixels only change on swap.
            if (
              patchSaysDifferent
              && !liveLooksEmpty
              && live.stddev > 35
              && plan.cursorItemSignature
              && plan.cursorItemSignature.item
              && plan.cursorItemSignature.item !== mem.item
            ) {
              const cursorItem = plan.cursorItemSignature.item;
              const slotItem = mem.item;
              // New slot identity = cursor's prior item; baselines
              // (fp + patch) refreshed from current observation so
              // future passes treat THIS as the new ground truth.
              plan.slotMemory.invalidate(s.cx, s.cy);
              plan.slotMemory.record(s.cx, s.cy, cursorItem, plan.iteration, live, livePatch ?? undefined);
              // New cursor identity = slot's prior item.
              if (mem.fingerprint) {
                plan.cursorItemSignature = {
                  meanR: mem.fingerprint.meanR,
                  meanG: mem.fingerprint.meanG,
                  meanB: mem.fingerprint.meanB,
                  item: slotItem,
                };
              } else {
                plan.cursorItemSignature.item = slotItem;
              }
              console.warn(`[agentbeats] SWAP DETECTED at slot ${s.index}(${s.name ?? "?"}): was '${slotItem}' now '${cursorItem}'; cursor was '${cursorItem}' now '${slotItem}' (dist=${distFromBaseline.toFixed(1)})`);
              knownSlots.push({ index: s.index, name: s.name, item: cursorItem, ageIters: 0 });
              continue;
            }
            knownSlots.push({ index: s.index, name: s.name, item: mem.item, ageIters: plan.iteration - mem.step });
          }
          // CURSOR-HOLDING IDENTIFICATION via pixel-patch matching.
          // The cursor's held-item icon renders at ~(cursor.x-8,
          // cursor.y-8). Sample that area as a patch, then run
          // patchSimilarity against EVERY known-item patch in
          // slotMemory. Best match (≥0.6 similarity) wins → that's
          // what the cursor holds. Authoritative ID even when:
          //   - prior cursorItemSignature is missing/wrong
          //   - the agent did a swap and our intent-tracking is stale
          //   - the cursor is over a slot containing a different item
          // The user described this as "must solve" for reliable UI
          // interaction.
          // (Cursor-pixel-id was tried and removed: the cursor's NW
          // patch area picked up random GUI pixels and misidentified
          // an empty cursor as crafting_table at sim≈0.72. The
          // pickup-verify path + Pass A disappearance inference
          // provide reliable cursor-identity signals without that
          // false-positive risk.)
          // Pass B: filled-slot identification. For every detected
          // slot that has no memory entry but visually contains
          // SOMETHING (not in the empty band), find the closest
          // fingerprint match across all currently-known items.
          // If close, record the item at this slot. Doesn't depend
          // on disappear detection -- handles place_one from a
          // 64-stack source (which leaves source visually identical).
          const knownItemFps: Array<{ item: string; fp: { meanR: number; meanG: number; meanB: number; stddev: number } }> = [];
          for (const e of plan.slotMemory.snapshot()) {
            if (e.fingerprint && e.item !== "empty" && e.item !== "unknown") {
              knownItemFps.push({ item: e.item, fp: e.fingerprint });
            }
          }
          // Capture per-slot initial baseline on first probe so we
          // can later detect "this slot moved away from its starting
          // state" -- the cleanest filter against false positives on
          // armor/offhand placeholder icons.
          if (plan.initialSlotBaselines.size === 0) {
            for (const s of layoutForProbe.slots) {
              const fp = samplePatchFingerprint(payload.obs, s.cx, s.cy, 6);
              if (fp) plan.initialSlotBaselines.set(`${Math.round(s.cx)},${Math.round(s.cy)}`, fp);
            }
            console.log(`[agentbeats] captured initial slot baselines for ${plan.initialSlotBaselines.size} slots`);
          }
          // Park-state snapshot: every slot's RGBA patch + cursor-area
          // patch, taken with cursor parked outside the GUI. Acts as
          // the pre-state for the next primitive click; the verify
          // phase replaces it with the post-snapshot. Refresh on
          // every park-frame WHEN no click is pending and the empty-
          // cursor baseline already exists — without the baseline the
          // cursor-state in the snapshot would be null, and the next
          // verify diff couldn't classify cursorChange.
          // Spec: docs/superpowers/specs/2026-05-07-park-snapshot-action-verify-design.md
          if (cursorAtPark && plan.parkEmptyCursorPatch && !plan.pendingClick) {
            const { takeLayoutSnapshot } = await import("../tools/SnapshotDiff");
            plan.lastParkSnapshot = takeLayoutSnapshot(payload.obs, layoutForProbe, cursor, plan.iteration, plan.parkEmptyCursorPatch, plan.lastProbeCursor);
            if (plan.iteration < 3) {
              console.log(`[agentbeats] park snapshot refreshed: ${plan.lastParkSnapshot.slots.size} slots, cursorHolding=${plan.lastParkSnapshot.cursorHolding}`);
            }
          }
          // Track transitions to notify the agent of slot updates.
          const slotUpdates: string[] = [];
          if (knownItemFps.length > 0) {
            for (const s of layoutForProbe.slots) {
              // Skip slots already known.
              if (plan.slotMemory.lookup(s.cx, s.cy)) continue;
              const live = samplePatchFingerprint(payload.obs, s.cx, s.cy, 6);
              if (!live) continue;
              // Skip slots that haven't drifted from their initial
              // baseline (still empty placeholder, or unchanged
              // initial item). dist < 12 = still in starting state.
              const baselineKey = `${Math.round(s.cx)},${Math.round(s.cy)}`;
              const initial = plan.initialSlotBaselines.get(baselineKey);
              if (initial) {
                const dr0 = live.meanR - initial.meanR, dg0 = live.meanG - initial.meanG, db0 = live.meanB - initial.meanB;
                const distFromInitial = Math.sqrt(dr0 * dr0 + dg0 * dg0 + db0 * db0);
                if (distFromInitial < 12) continue;  // unchanged from start
              }
              const lum = (live.meanR + live.meanG + live.meanB) / 3;
              const looksEmpty = live.stddev < 20 && lum > 120 && lum < 160;
              if (looksEmpty) continue;
              let bestItem: string | null = null;
              let bestDist = Infinity;
              for (const k of knownItemFps) {
                const dr = live.meanR - k.fp.meanR;
                const dg = live.meanG - k.fp.meanG;
                const db = live.meanB - k.fp.meanB;
                const dist = Math.sqrt(dr * dr + dg * dg + db * db);
                if (dist < bestDist) { bestDist = dist; bestItem = k.item; }
              }
              if (bestItem && bestDist < 30) {
                plan.slotMemory.record(s.cx, s.cy, bestItem, plan.iteration, live);
                knownSlots.push({ index: s.index, name: s.name, item: bestItem, ageIters: 0 });
                slotUpdates.push(`slot ${s.index}${s.name ? `(${s.name})` : ""} now has ${bestItem}`);
                console.log(`[agentbeats] slot ${s.index}(${s.name ?? "?"}) matched to known item '${bestItem}' by fingerprint (dist=${bestDist.toFixed(1)})`);
              } else if (bestItem) {
                // Drifted from baseline + visually filled but no
                // close match -- could be the crafted result item
                // (whose fingerprint we have not seen yet). Notify.
                slotUpdates.push(`slot ${s.index}${s.name ? `(${s.name})` : ""} now has an UNKNOWN item (use verify_slots to identify)`);
                console.log(`[agentbeats] slot ${s.index}(${s.name ?? "?"}) drifted from initial; closest known='${bestItem}' but dist=${bestDist.toFixed(1)} too high`);
              }
            }
          }
          // Action agent path: when Planner has built a checklist and
          // an active subtask is selected, dispatch ONE step via the
          // slim Action agent. The legacy probeNextCraftAction path
          // has been removed — it used a CraftAction schema whose
          // `put` primitive (= dump whole cursor stack) had no
          // place_one analogue, forcing the LLM to dump the rest of
          // a multi-cell ingredient stack into one cell whenever the
          // cursor was already holding mid-recipe. The FastUI Action
          // path's enum has both place_one and place_all, so it can
          // express the correct intent.
          const useActionAgent = plan.checklist.length > 0
            && plan.activeChecklistIdx >= 0
            && plan.activeChecklistIdx < plan.checklist.length
            && !plan.checklist[plan.activeChecklistIdx].done;
          if (!useActionAgent) {
            // No active subtask — the checklist is empty, exhausted,
            // or the active item is already done. Arm planner re-judge
            // so the next obs invokes the FastUI Planner to build /
            // refresh the checklist; emit a noop so the runtime
            // doesn't fall back to a probe of any kind.
            plan.judgeAfterChain = true;
            console.log(`[agentbeats] no active subtask (checklist=${plan.checklist.length}, idx=${plan.activeChecklistIdx}); armed planner re-judge for next obs`);
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }

          // Plan auto-fixer: before dispatching the active subtask,
          // check that the cursor state matches its precondition. If
          // not, INSERT a recovery step (pickup or place_all) before
          // the active item and adjust activeChecklistIdx so the
          // recovery runs first. This catches planner LLM errors
          // (e.g. emitted place_one when cursor is empty) without
          // bouncing to GoalPlanner via fallback_manual.
          if (useActionAgent) {
            type SubtaskT = { kind: string; sourceSlot?: number; destSlot?: number; expectedItem?: string };
            const active = plan.checklist[plan.activeChecklistIdx];
            const t = active.task as SubtaskT;
            const cursorItem = plan.cursorItemSignature?.item;
            // Find a free hotbar/main_inv slot to dump the cursor when needed.
            const findEmptyDump = (): number | null => {
              for (const s of layoutForProbe.slots) {
                if (s.role !== "hotbar" && s.role !== "main_inv") continue;
                const mem = plan.slotMemory.lookup(s.cx, s.cy);
                if (!mem || mem.item === "empty") return s.index;
              }
              return null;
            };
            // Find a slot in slotMemory holding an expected item.
            const findSourceHolding = (item: string): number | null => {
              for (const e of plan.slotMemory.snapshot()) {
                if (e.item !== item) continue;
                let bestIdx = -1, bestD = Infinity;
                for (const s of layoutForProbe.slots) {
                  const d = Math.hypot(s.cx - e.x, s.cy - e.y);
                  if (d < bestD) { bestD = d; bestIdx = s.index; }
                }
                if (bestIdx >= 0) return bestIdx;
              }
              return null;
            };
            const insertBefore = (newTask: SubtaskT, label: string) => {
              const id = `auto_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
              plan.checklist.splice(plan.activeChecklistIdx, 0, {
                id, text: label, task: newTask as any, done: false, attempts: 0,
              });
              console.log(`[plan-fix] inserted ${newTask.kind} (${label}) at idx=${plan.activeChecklistIdx} before ${active.id}`);
            };
            if ((t.kind === "place_one" || t.kind === "place_all") && t.expectedItem) {
              if (!cursorItem) {
                // Cursor empty but plan wants place — insert pickup.
                const src = findSourceHolding(t.expectedItem);
                if (src !== null) insertBefore({ kind: "pickup", sourceSlot: src, expectedItem: t.expectedItem }, `auto-pickup ${t.expectedItem}`);
                else console.warn(`[plan-fix] cursor empty + ${t.kind}(${t.expectedItem}) but no source slot known; will let Action emit fallback`);
              } else if (cursorItem !== t.expectedItem) {
                // Cursor holds wrong item — insert place_all to dump.
                const dump = findEmptyDump();
                if (dump !== null) insertBefore({ kind: "place_all", destSlot: dump, expectedItem: cursorItem }, `auto-dump ${cursorItem} to slot ${dump}`);
                else console.warn(`[plan-fix] cursor holds wrong item (${cursorItem} vs ${t.expectedItem}) but no empty dump slot; Action will fallback`);
              }
            } else if (t.kind === "pickup" && cursorItem) {
              // Cursor non-empty but plan wants pickup — dump first.
              const dump = findEmptyDump();
              if (dump !== null) insertBefore({ kind: "place_all", destSlot: dump, expectedItem: cursorItem }, `auto-dump ${cursorItem} to slot ${dump} (before pickup)`);
            }
          }

          let probed: import("../tools/InventoryProbe").CraftAction | null;
          {
            const { runAction } = await import("./subagents/fastUi/Action");
            // Cross-ref slotMemory entries (keyed by pixel pos) with the
            // current layout to surface concrete slot indices to Action.
            const knownForAction = plan.slotMemory.snapshot().map((e) => {
              const closest = layoutForProbe.slots.reduce<{ s: typeof layoutForProbe.slots[number] | null; d: number }>(
                (acc, s) => {
                  const d = Math.hypot(s.cx - e.x, s.cy - e.y);
                  return d < acc.d ? { s, d } : acc;
                },
                { s: null, d: Number.POSITIVE_INFINITY },
              );
              return { index: closest.s?.index ?? 0, name: closest.s?.name, item: e.item };
            });
            const layoutForAction = layoutForProbe.slots.map((s) => ({
              index: s.index, name: s.name, role: s.role,
            }));
            const cursorHoldingItem = plan.cursorItemSignature
              ? (plan.cursorItemSignature.item ? `(holding ${plan.cursorItemSignature.item})` : "(holding something)")
              : null;
            const activeItem = plan.checklist[plan.activeChecklistIdx];
            activeItem.attempts = (activeItem.attempts ?? 0) + 1;
            // Reuse the SoM-labeled image computed once at the top of body.
            const markedObs = markedObsForLLMs ?? payload.obs ?? "";
            probed = await runAction({ client: deps.client, model: deps.model, recordDebug: deps.recordDebug }, {
              subtask: activeItem.task,
              knownSlots: knownForAction,
              layoutSlots: layoutForAction,
              recipeInfo: plan.recipeOverride,
              cursorHolding: cursorHoldingItem,
              obsBase64: markedObs,
            });
          }
          plan.iteration += 1;
          if (!probed) {
            // Probe failed to return an action — invalidate the SoM
            // session so the next frame redetects (some slots may have
            // been occluded the first time) and re-probes. Don't set
            // done: manual LLM cursor control runs at ~3% success.
            console.log(`[agentbeats] closed-loop probe returned no action; invalidating SoM session and reprobing next frame`);
            plan.sessionLayout = null;
            plan.layoutHint = null;
          } else if (probed.action === "wait") {
            // Async-output GUIs (smelt/brew): hold a noop for N steps
            // so the simulator timers can tick. Capped at maxHoldSteps.
            const N = Math.max(1, Math.min(deps.maxHoldSteps, probed.holdSteps ?? 8));
            console.log(`[agentbeats] wait action holdSteps=${N} reason=${probed.reason ?? ""}`);
            state.closedLoopHistory.unshift(`wait holdSteps=${N}`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            return { kind: "act", action: defaultMcuAction(), holdSteps: N };
          } else if (probed.action === "done") {
            // Action's "done" means "I finished THIS subtask" — NOT
            // "the whole craft is done". Mark the active checklist
            // item complete and arm a Planner re-judge so the next
            // subtask gets dispatched. The session only ends when
            // Planner returns all_done (handled at the post_action
            // re-judge call site at body top). Without this, a
            // verify_items_visible "done" was prematurely setting
            // plan.done=true → closed-loop exits → parent VLM presses
            // 'inventory' and the GUI closes mid-craft.
            const activeItem = plan.checklist[plan.activeChecklistIdx];
            if (activeItem) {
              activeItem.done = true;
              console.log(`[agentbeats] subtask done: '${activeItem.id}' (${(activeItem.task as any)?.kind}); arming Planner re-judge`);
            }
            plan.judgeAfterChain = true;
            state.closedLoopHistory.unshift(`subtask_done ${activeItem?.id ?? "?"}`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            // Return a noop frame so the inventory stays open and
            // the next obs enters with judgeAfterChain set; the
            // Planner re-judge at the top of the body will tick the
            // checklist and dispatch the next subtask.
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          } else if (probed.action === "fallback_manual") {
            const blockedReason = probed.reason ?? "fallback_manual";
            console.log(`[agentbeats] closed-loop probe says fallback_manual reason=${blockedReason} -- escalating to GoalPlanner`);
            plan.done = true;
            // GoalPlanner escalation: when MCU_USE_PLANNER is on,
            // re-plan immediately using the structured BLOCKED reason
            // the sub-agent emitted. The planner is expected to
            // insert prerequisite subgoals (e.g. obtain/place a
            // crafting_table) at the head of the queue and requeue
            // the original task at the tail.
            if (process.env.MCU_USE_PLANNER === "1") {
              const ep = input.episode;
              ep.completedSummaries.push(`SUBGOAL_FAILED: ${blockedReason}`);
              try {
                const { planGoals } = await import("./GoalPlanner");
                const out = await planGoals(
                  { client: deps.client, model: deps.model },
                  ep.taskText,
                  ep.completedSummaries,
                );
                if (!out.overall_done && out.subgoals.length > 0) {
                  ep.subgoals = out.subgoals;
                  ep.idx = 0;
                  // singleTask dropped in planner-first refactor
                  console.log(`[agentbeats] GoalPlanner re-plan after fallback_manual: ${out.subgoals.length} subgoals -> ${out.subgoals.map((s) => `${s.kind}:${s.description}`).join(" | ")}`);
                } else {
                  console.warn(`[agentbeats] GoalPlanner re-plan returned empty/overall_done=true; giving up`);
                }
              } catch (e) {
                console.warn(`[agentbeats] GoalPlanner re-plan failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            return { kind: "subgoal_failed", reason: `BLOCKED: ${blockedReason}` };
          } else if (probed.action === "recipe_lookup") {
            // Sub-agent recipe query: look up via minecraft-data,
            // store on the plan for use in subsequent probes' RECIPE
            // / Placement plan blocks. No clicks; just a state update
            // and a noop frame so the agent re-probes with the new
            // RECIPE context.
            const r = lookupRecipe(probed.item);
            if (r) {
              plan.recipeOverride = r;
              const ingStr = r.ingredients.map((it: { name: string; count: number }) => `${it.count}x ${it.name}`).join(" + ");
              state.closedLoopHistory.unshift(`recipe_lookup '${probed.item}' -> ${r.target} (${ingStr})`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.log(`[agentbeats] recipe_lookup '${probed.item}' resolved: ingredients=${ingStr} inShape=${r.inShape ? "yes" : "no"}`);
              // Hard prerequisite check: a 3x3-shaped recipe (or
              // shapeless with > 4 unique cells needed) cannot be
              // crafted in the player_inventory's 2x2 grid. Report
              // BLOCKED so the GoalPlanner places a crafting_table
              // and re-dispatches inventory after.
              const craftCells = layoutForProbe.slots.filter((s) => s.role === "craft_2x2" || s.role === "craft_3x3").length;
              const need3x3 = (r.inShape && (r.inShape.length > 2 || r.inShape.some((row) => row.length > 2)))
                || (!r.inShape && r.ingredients.reduce((sum, it) => sum + it.count, 0) > 4);
              // Only fire when the open GUI has a 2x2 craft area (4 cells)
              // — that's the player_inventory case where a 3x3 recipe
              // can't fit. Other GUIs (chest=0, furnace=0, etc.) leave
              // craftCells at 0 and we don't gate them with this check.
              if (need3x3 && craftCells === 4) {
                console.warn(`[agentbeats] ${r.target} needs a 3x3 grid but the open GUI is player_inventory (2x2). Reporting BLOCKED.`);
                return { kind: "subgoal_failed", reason: `BLOCKED: need a crafting_table 3x3 GUI to craft ${r.target}` };
              }
              try {
                const knownSlotsForPlanner = plan.slotMemory.snapshot()
                  .filter((e) => e.item && e.item !== "empty")
                  .map((e) => {
                    const closest = layoutForProbe.slots.reduce<{ s: typeof layoutForProbe.slots[number] | null; d: number }>(
                      (acc, s) => {
                        const d = Math.hypot(s.cx - e.x, s.cy - e.y);
                        return d < acc.d ? { s, d } : acc;
                      },
                      { s: null, d: Number.POSITIVE_INFINITY },
                    );
                    return { index: closest.s?.index ?? 0, name: closest.s?.name, item: e.item };
                  });
                const cursorHoldingItem = plan.cursorItemSignature
              ? (plan.cursorItemSignature.item ? `(holding ${plan.cursorItemSignature.item})` : "(holding something)")
              : null;
                const { runPlanner } = await import("./subagents/fastUi/Planner");
                const markedObs = markedObsForLLMs ?? payload.obs ?? "";
                const layoutSlotsForPlanner = (plan.sessionLayout as { slots: Array<{ index: number; name?: string; role?: string }> } | null)?.slots ?? [];
                const r0 = await runPlanner({ client: deps.client, model: deps.model, recordDebug: deps.recordDebug }, {
                  taskText: state.taskText,
                  subgoalDescription: currentSubgoalDescription,
                  recipeInfo: r,
                  knownSlots: knownSlotsForPlanner,
                  layoutSlots: layoutSlotsForPlanner,
                  cursorHolding: cursorHoldingItem,
                  currentChecklist: [],
                  trigger: "first",
                  recentHistory: state.closedLoopHistory.slice(0, 3),
                  obsBase64: markedObs,
                });
                plan.checklist = r0.checklist;
                plan.activeChecklistIdx = r0.kind === "continue" ? r0.nextIdx : -1;
              } catch (e) {
                console.warn(`[fastui-planner] initial seed failed: ${e instanceof Error ? e.message : String(e)}`);
              }
              // Return a noop frame so the inventory stays open and the
              // next observation enters with the freshly seeded checklist.
              // Without this the body falls through to the VLM model
              // decision path which would press 'inventory' (closing the
              // GUI) and ruin the session.
              return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
            } else {
              state.closedLoopHistory.unshift(`recipe_lookup '${probed.item}' -> NOT FOUND in minecraft-data`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.warn(`[agentbeats] recipe_lookup '${probed.item}' not found; agent should retry with corrected id`);
            }
          } else if (probed.action === "move") {
            // High-level atomic move: pickup `from` -> place at `to`
            // -> auto-return remainder to `from` (when count=one).
            // Build the click chain; first click goes to pendingClick,
            // rest queue in plan.pendingChain and promote on verify.
            const fromSlot = layoutForProbe.slots[probed.from];
            const toSlot = layoutForProbe.slots[probed.to];
            // No-swap invariant. ANY move (count=one or count=all)
            // into a non-empty destination of a DIFFERENT item is a
            // destructive swap that wrecks slotMemory tracking. Refuse
            // unconditionally unless the destination is empty OR
            // holds the same item as what the cursor would deposit.
            // Source of truth in priority order:
            //   (1) slotMemory at toSlot — if it names a known item,
            //       trust it absolutely (OCR-confirmed or click-
            //       verified placement).
            //   (2) cursorItemSignature RGB vs destPatch RGB — fall-
            //       back when slotMemory has no entry at toSlot but
            //       the slot still looks filled.
            //   (3) destPatch.stddev > 35 — last-resort "looks
            //       filled" indicator.
            // Skip the guard entirely for from==to (legit auto-return).
            const fromMem = fromSlot ? plan.slotMemory.lookup(fromSlot.cx, fromSlot.cy) : null;
            const toMem = toSlot ? plan.slotMemory.lookup(toSlot.cx, toSlot.cy) : null;
            const cursorItemName = fromMem?.item; // what we'd deposit
            const destPatch = (toSlot && fromSlot && fromSlot.name !== toSlot.name)
              ? samplePatchFingerprint(payload.obs, toSlot.cx, toSlot.cy, 12)
              : null;
            const sigDist = (destPatch && plan.cursorItemSignature)
              ? Math.hypot(
                  destPatch.meanR - plan.cursorItemSignature.meanR,
                  destPatch.meanG - plan.cursorItemSignature.meanG,
                  destPatch.meanB - plan.cursorItemSignature.meanB,
                )
              : null;
            const destKnownDifferent = !!(toMem && toMem.item !== "empty" && toMem.item !== "unknown" && cursorItemName && toMem.item !== cursorItemName);
            // CV fallback fires only when slotMemory has NO entry at
            // the destination AND we have an active cursor signature
            // to compare against. Without a cursor signature the
            // stddev test alone has way too many false positives
            // (shadow borders between craft cells read as filled).
            // If neither slotMemory nor cursor signature gives a
            // definitive signal, PROCEED — the click verifier will
            // catch any real post-place mismatch.
            const destPatchSameItem = sigDist !== null && sigDist < 30;
            const destPatchFilledDifferent = !!destPatch && destPatch.stddev > 35 && plan.cursorItemSignature !== null && !destPatchSameItem;
            const destLooksFilled = destKnownDifferent || (!toMem && destPatchFilledDifferent);
            if (deps.debugDir && destPatch && toSlot) {
              void deps.recordDebug("pre_check_move", {
                type: "pre_check_move",
                iteration: plan.iteration,
                step,
                data: {
                  from: { index: probed.from, name: fromSlot?.name },
                  to: { index: probed.to, name: toSlot.name, cx: toSlot.cx, cy: toSlot.cy },
                  count: probed.count,
                  destPatch: { meanR: destPatch.meanR, meanG: destPatch.meanG, meanB: destPatch.meanB, stddev: destPatch.stddev },
                  decision: destLooksFilled ? "REFUSE_FILLED" : "PROCEED",
                },
              });
            }
            if (!fromSlot || !toSlot) {
              console.warn(`[agentbeats] move from=${probed.from} to=${probed.to}: slot(s) not in layout (have ${layoutForProbe.slots.length}); skipping`);
            } else if (destLooksFilled) {
              const reason = destKnownDifferent
                ? `slotMemory says toSlot has ${toMem!.item} (cursor would deposit ${cursorItemName})`
                : `CV says destination filled (stddev=${destPatch!.stddev.toFixed(1)})`;
              console.warn(`[agentbeats] move to=${probed.to}(${toSlot.name ?? "?"}) refused: ${reason}; would trigger item swap. Re-judging.`);
              state.closedLoopHistory.unshift(`refused move to=${probed.to}(${toSlot.name ?? "?"}) (${reason}; pick a visually empty slot)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              // Mark active subtask attempts++ and arm Planner re-
              // judge so the next iter dispatches a different target
              // slot. Returning a noop frame keeps the inventory
              // open — falling through to the parent VLM here would
              // press 'inventory' and close the GUI mid-craft.
              const activeItem = plan.checklist[plan.activeChecklistIdx];
              if (activeItem) activeItem.attempts = (activeItem.attempts ?? 0) + 1;
              plan.judgeAfterChain = true;
              return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
            } else if (
              plan.pickupSourceSlot
              && plan.pickupSourceSlot.name
              && toSlot.name === plan.pickupSourceSlot.name
              && fromSlot.name !== plan.pickupSourceSlot.name
            ) {
              // Hard guard: VLM is asking to dump cursor contents into
              // the slot we just refilled with the original ingredient
              // via auto-return. This always triggers an item swap
              // (e.g. crafted planks <-> log stack). Refuse and force
              // the VLM to pick a different empty slot. Exception:
              // a self-move (from==to) is the legit auto-return itself.
              console.warn(`[agentbeats] move to=${probed.to}(${toSlot.name}) refused: that's the recorded pickup source slot which still holds the original ingredient -- placing here would swap items. Reprobe`);
              state.closedLoopHistory.unshift(`refused move to=${probed.to}(${toSlot.name}) (would swap with returned ingredient stack)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            } else {
              // Capture source slot's item name so we can record it
              // at the destination on a CV-matched place verify --
              // place_one from a 64-stack leaves source visually
              // unchanged, so the pure-CV disappear scan can't tell
              // the item moved. The matched-click verify is the CV
              // evidence; the source memory entry is the identity.
              const fromMem = plan.slotMemory.lookup(fromSlot.cx, fromSlot.cy);
              // If the source is the recipe result slot, the recipe defines
              // what's being taken — even though no OCR ever ran on the
              // result slot. This lets the take destination get a correct
              // slotMemory write on matched verify, which in turn makes
              // Known show the target item and lets the next probe judge
              // the task complete instead of looping take->take forever.
              const placedItemName =
                fromMem?.item
                ?? (fromSlot.role === "result" && plan.recipeOverride ? plan.recipeOverride.target : undefined);
              // Capture source's RGB fingerprint for CV-based placement
              // tracking. Prefer slotMemory baseline (set at OCR-confirm
              // time / first probe Pass A). Fallback to a fresh sample
              // of the source slot at chain-build time. The destination
              // verify will compare its post-fill fp against this.
              const sourceFp = fromMem?.fingerprint
                ?? samplePatchFingerprint(payload.obs, fromSlot.cx, fromSlot.cy, 6) ?? undefined;
              const mkClick = (s: { index: number; name?: string; role?: string; cx: number; cy: number }, button: "attack" | "use", expectAfter: "should_empty" | "should_fill", actionKind: "pickup" | "place_one" | "place_all" | "take", kind: "click" | "auto_return", placedItemName?: string, sourceFp?: { meanR: number; meanG: number; meanB: number; stddev: number }): import("../tools/UiFastControl").PendingClick => ({
                rasterIndex: s.index, slotName: s.name, slotRole: s.role,
                frozenTarget: { x: s.cx, y: s.cy },
                button, shift: false, expectAfter,
                phase: "servo", retries: 0, kind, actionKind,
                ...(placedItemName ? { placedItemName } : {}),
                ...(sourceFp ? { sourceFp } : {}),
              });
              const chain: import("../tools/UiFastControl").PendingClick[] = [];
              chain.push(mkClick(fromSlot, "attack", "should_empty", "pickup", "click", undefined, sourceFp));
              if (probed.count === "all") {
                chain.push(mkClick(toSlot, "attack", "should_fill", "place_all", "click", placedItemName, sourceFp));
              } else {
                chain.push(mkClick(toSlot, "use", "should_fill", "place_one", "click", placedItemName, sourceFp));
                chain.push(mkClick(fromSlot, "attack", "should_fill", "place_all", "auto_return", undefined, sourceFp));
              }
              // Only record pickupSourceSlot when picking from a real
              // ingredient source (hotbar/main_inv). Moves whose source
              // is the result slot or a craft grid slot must NOT
              // overwrite the recorded source -- that source is the
              // slot we need to AVOID dumping crafted output into.
              const fromIsIngredientSource =
                fromSlot.role === "hotbar" || fromSlot.role === "main_inv";
              if (fromIsIngredientSource) {
                plan.pickupSourceSlot = { index: fromSlot.index, name: fromSlot.name };
                console.log(`[agentbeats] recorded pickupSourceSlot=${fromSlot.index} (${fromSlot.name ?? "?"}) for move`);
              }
              plan.pendingClick = chain.shift()!;
              plan.pendingChain = chain;
              plan.servoSteps = 0;
              state.closedLoopHistory.unshift(`move ${fromSlot.name ?? probed.from} -> ${toSlot.name ?? probed.to} (count=${probed.count ?? "one"})`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.log(`[agentbeats] closed-loop probe iter=${plan.iteration}: move from=${probed.from}(${fromSlot.name ?? "?"}) to=${probed.to}(${toSlot.name ?? "?"}) count=${probed.count ?? "one"} reason=${probed.reason ?? ""}; chain=${chain.length + 1} clicks`);
            }
          } else if (probed.action === "put") {
            const dest = layoutForProbe.slots[probed.slot];
            // Same swap guard as for move count=all: refuse if dest looks filled.
            if (dest) {
              const putPatch = samplePatchFingerprint(payload.obs, dest.cx, dest.cy, 12);
              if (putPatch && putPatch.stddev > 35) {
                console.warn(`[agentbeats] put slot=${probed.slot}(${dest.name ?? "?"}) refused: destination looks FILLED (stddev=${putPatch.stddev.toFixed(1)} > 35); would trigger an item swap. Reprobe`);
                state.closedLoopHistory.unshift(`refused put slot=${probed.slot}(${dest.name ?? "?"}) (destination already has an item; pick a visually empty slot)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                // Skip building the click; fall through to next obs which reprobes.
                return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
              }
            }
            if (!dest) {
              console.warn(`[agentbeats] put slot=${probed.slot}: not in layout; skipping`);
            } else {
              plan.pendingClick = {
                rasterIndex: dest.index, slotName: dest.name, slotRole: dest.role,
                frozenTarget: { x: dest.cx, y: dest.cy },
                button: "attack", shift: false, expectAfter: "should_fill",
                phase: "servo", retries: 0, kind: "click", actionKind: "place_all",
              };
              plan.pendingChain = [];
              plan.servoSteps = 0;
              state.closedLoopHistory.unshift(`put -> ${dest.name ?? probed.slot}`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.log(`[agentbeats] closed-loop probe iter=${plan.iteration}: put slot=${probed.slot}(${dest.name ?? "?"}) reason=${probed.reason ?? ""}`);
            }
          } else if (probed.action === "verify_slots") {
            // Guard: MC suppresses slot tooltips while the cursor
            // holds an item. Trust the runtime-tracked
            // cursorItemSignature (set on confirmed pickup, cleared
            // on confirmed place_all) — NOT the legacy CV cursorHolding
            // IIFE, which false-positives on grey items / animated bg.
            if (plan.cursorItemSignature?.item) {
              // Before refusing, sanity-check the cursor state via OCR.
              // The signature can go stale when the LLM consumed the last
              // unit on a previous click and the runtime never observed
              // the consume (the place_all hit a same-item slot and got
              // no_op'd, OR the place was skipped). Held items suppress
              // slot tooltips, so a readable tooltip on a known slot
              // proves the cursor is actually empty.
              const knownEntries = plan.slotMemory.snapshot().filter(e => e.item && e.item !== "unknown");
              if (!plan.cursorVerifyJob && knownEntries.length > 0 && layoutForProbe) {
                const candidate = knownEntries[0];
                let knownSlotIdx = -1;
                for (let i = 0; i < layoutForProbe.slots.length; i++) {
                  const s = layoutForProbe.slots[i];
                  if (s && Math.hypot(s.cx - candidate.x, s.cy - candidate.y) < 8) { knownSlotIdx = i; break; }
                }
                if (knownSlotIdx >= 0) {
                  plan.cursorVerifyJob = {
                    knownSlotIdx,
                    target: { x: candidate.x, y: candidate.y },
                    slotName: layoutForProbe.slots[knownSlotIdx]?.name,
                    expectedItem: candidate.item,
                    phase: "servo",
                    servoSteps: 0,
                    hoverFrames: 0,
                  };
                  console.warn(`[agentbeats] verify_slots: cursor tracked as holding ${plan.cursorItemSignature.item} — running cursor-empty OCR verify on ${candidate.item} @ (${Math.round(candidate.x)},${Math.round(candidate.y)}) before refusing`);
                  return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
                }
              }
              state.closedLoopHistory.unshift(`verify_slots refused: cursor holding ${plan.cursorItemSignature.item}; clear cursor first`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.warn(`[agentbeats] verify_slots refused: cursor holding ${plan.cursorItemSignature.item} (per tracked state)`);
              return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
            }
            // verify_slots: hover cursor on each requested slot in
            // sequence, OCR the rendered tooltip, write SlotMemory,
            // then park the cursor before returning to the probe.
            // CV stddev fast-path lets visually-empty slots short-
            // circuit with zero cursor movement and zero LLM cost.
            const queue = probed.slots
              .map((s) => {
                const d = layoutForProbe.slots[s];
                return d ? { slot: s, x: d.cx, y: d.cy, name: d.name } : null;
              })
              .filter((e): e is NonNullable<typeof e> => e !== null);
            if (queue.length === 0) {
              console.warn(`[agentbeats] verify_slots: no resolvable slots in [${probed.slots.join(",")}]; skipping`);
            } else {
              const cvEmpty: typeof queue = [];
              const needOcr: typeof queue = [];
              for (const q of queue) {
                const patch = samplePatchFingerprint(payload.obs, q.x, q.y, 6);
                // Stricter CV-empty: low stddev AND mid-gray
                // luminance. A pale item (e.g. nether quartz) has
                // low stddev but luminance ~190 -- without the band
                // check the fast-path falsely marks it empty and
                // skips OCR.
                const lum = patch ? (patch.meanR + patch.meanG + patch.meanB) / 3 : 0;
                const inEmptyBand = lum > 120 && lum < 160;
                if (patch && patch.stddev < 25 && inEmptyBand) cvEmpty.push(q);
                else needOcr.push(q);
              }
              // Record CV-empty results immediately; no servo needed.
              for (const q of cvEmpty) {
                plan.slotMemory.record(q.x, q.y, "empty", plan.iteration);
              }
              console.log(`[agentbeats] verify_slots batch=${queue.length} cv_empty=${cvEmpty.length} ocr=${needOcr.length} slots=${queue.map((q) => `${q.slot}(${q.name ?? "?"})`).join(",")}`);
              if (needOcr.length === 0) {
                // Everything was CV-empty; nothing to OCR. Just return
                // and let the probe see the updated slotMemory.
                state.closedLoopHistory.unshift(`verify_slots[${queue.length}] cv_empty=${cvEmpty.length}`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
              }
              // Arm the OCR batch state machine: queue the non-empty
              // slots and start servoing cursor toward the first one.
              plan.pendingOcrBatch = { slots: needOcr, idx: 0, parking: false };
              const first = needOcr[0];
              plan.pendingClick = {
                rasterIndex: first.slot, slotName: first.name, slotRole: undefined,
                frozenTarget: { x: first.x, y: first.y },
                button: "attack", shift: false, expectAfter: "should_fill",
                phase: "servo", retries: 0, kind: "hover" as "click",
                actionKind: "pickup" as "pickup",
              };
              plan.pendingChain = [];
              plan.servoSteps = 0;
              plan.skipNextPark = true;
              plan.pendingTooltipRead = { slotIndex: first.slot, x: first.x, y: first.y, slotName: first.name };
              state.closedLoopHistory.unshift(`verify_slots[${queue.length}] cv_empty=${cvEmpty.length} ocr=${needOcr.length}`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.log(`[agentbeats] verify_slots OCR batch start: first slot=${first.slot}(${first.name ?? "?"})`);
            }
          } else {
            // Legacy low-level actions: pickup / place_one / place_all / take.
            const button: "attack" | "use" = probed.action === "place_one" ? "use" : "attack";
            const shift = false;
            const probedSlot = layoutForProbe.slots[probed.slot];
            if (!probedSlot) {
              console.warn(`[agentbeats] probe returned slot ${probed.slot} but layout only has ${layout.slots.length}; skipping`);
            } else if (probed.action === "pickup" && plan.cursorItemSignature?.item) {
              // Hard guard: cursor is already carrying an item per the
              // RUNTIME-TRACKED state (set on confirmed pickup, cleared
              // on confirmed place_all). Use this instead of the legacy
              // CV cursorHolding IIFE which false-positives on grey
              // items + animated bg.
              console.warn(`[agentbeats] probe asked for pickup at slot ${probed.slot} but cursor holds ${plan.cursorItemSignature.item} (per tracked state); refusing -- will reprobe`);
              state.closedLoopHistory.unshift(`refused pickup slot=${probed.slot} (cursor holding ${plan.cursorItemSignature.item})`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            } else if (probed.action === "take" && plan.cursorItemSignature?.item) {
              console.warn(`[agentbeats] probe asked for take at slot ${probed.slot} but cursor holds ${plan.cursorItemSignature.item} (per tracked state); refusing -- will reprobe`);
              state.closedLoopHistory.unshift(`refused take slot=${probed.slot} (cursor holding ${plan.cursorItemSignature.item})`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            } else {
              if (probed.action === "pickup"
                  && (probedSlot.role === "hotbar" || probedSlot.role === "main_inv")) {
                plan.pickupSourceSlot = { index: probed.slot, name: probedSlot.name };
                console.log(`[agentbeats] recorded pickupSourceSlot=${probed.slot} (${probedSlot.name ?? "?"}) for legacy pickup`);
              }
              // Pre-take auto-return: "take" requires an empty cursor
              // (otherwise it does nothing in MC). If we have a
              // recorded pickup source, schedule a place_all back to
              // it FIRST. Next probe will re-issue take when result
              // slot is still filled and cursor is now empty.
              // Putting auto-return here (just in front of crafting)
              // instead of after every place_one keeps multi-slot
              // recipes working: leftover stays in the cursor across
              // multiple place_one calls until the recipe is ready.
              if (probed.action === "take"
                  && plan.pickupSourceSlot
                  && plan.pickupSourceSlot.name
                  && plan.cursorItemSignature?.item) {
                const ret = layoutForProbe.slots.find((s) => s.name === plan.pickupSourceSlot!.name);
                if (ret) {
                  console.log(`[agentbeats] PRE-TAKE AUTO_RETURN: scheduling place_all back to ${ret.name} (raster=${ret.index}) before take`);
                  plan.pendingClick = {
                    rasterIndex: ret.index,
                    slotName: ret.name,
                    slotRole: ret.role,
                    frozenTarget: { x: ret.cx, y: ret.cy },
                    button: "attack",
                    shift: false,
                    expectAfter: "should_fill",
                    phase: "servo",
                    retries: 0,
                    kind: "auto_return",
                    actionKind: "place_all",
                  };
                  plan.servoSteps = 0;
                  state.closedLoopHistory.unshift(`auto_return -> ${ret.name} (before take)`);
                  state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                  return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
                }
                // Original pickup slot is no longer in the layout
                // (e.g. layout reset, slot rearranged). Skip the take
                // and surface to the LLM so it picks a fallback dump
                // slot for the leftover via the next probe.
                console.warn(`[agentbeats] PRE-TAKE AUTO_RETURN: original source slot "${plan.pickupSourceSlot.name}" not in current layout; skipping take so next probe can choose a fallback dump slot`);
                state.closedLoopHistory.unshift(`auto_return blocked: source ${plan.pickupSourceSlot.name} not in layout; please place_all leftover into any empty main_inv slot before take`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
                return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
              }
              // Click-mode sentinel: place_all with empty expectedItem
              // is a button click (e.g. enchant offer, trade offer,
              // recipe-book toggle) — no slot transition expected, no
              // cursor-state requirement. Verify by patch fingerprint
              // change at the destSlot (e.g. enchant offer level text
              // disappears after click).
              const activeTask = plan.checklist[plan.activeChecklistIdx]?.task as { kind?: string; expectedItem?: string } | undefined;
              const isButtonClick = probed.action === "place_all"
                && activeTask?.kind === "place_all"
                && activeTask.expectedItem === "";
              const expectAfter: "should_empty" | "should_fill" | "should_change" =
                isButtonClick ? "should_change"
                : (probed.action === "place_one" || probed.action === "place_all") ? "should_fill"
                : "should_empty";
              // Record what item the cursor is about to drop. Verify
              // uses this to write slotMemory[dest] = item on confirmed
              // placement — without it, the place verify can't identify
              // the placed item and slotMemory loses the destination
              // entry, leaving the next planner call blind to a slot
              // we just deterministically filled. Skip for button clicks.
              const placedItemName = isButtonClick
                ? undefined
                : (probed.action === "place_one" || probed.action === "place_all")
                  ? plan.cursorItemSignature?.item
                  : undefined;
              plan.pendingClick = {
                rasterIndex: probed.slot,
                slotName: probedSlot.name,
                slotRole: probedSlot.role,
                frozenTarget: { x: probedSlot.cx, y: probedSlot.cy },
                button,
                shift,
                expectAfter,
                phase: "servo",
                retries: 0,
                kind: "click",
                actionKind: probed.action as "pickup" | "place_one" | "place_all" | "take",
                ...(placedItemName ? { placedItemName } : {}),
              };
              plan.servoSteps = 0;
              state.closedLoopHistory.unshift(`${probed.action} slot=${probed.slot}${probedSlot.name ? `(${probedSlot.name})` : ""}`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.log(
                `[agentbeats] closed-loop probe iter=${plan.iteration}: ${probed.action} slot=${probed.slot} name=${probedSlot.name ?? "?"} reason=${probed.reason ?? ""}`,
              );
            }
          }
        } catch (error) {
          // Don't surrender to manual LLM control on a transient probe
          // failure -- closed-loop is enforced. Reset the session and
          // try again on the next obs frame.
          console.warn(`[agentbeats] closed-loop probe failed: ${String(error instanceof Error ? error.message : error)} -- resetting SoM session and reprobing next frame (closed-loop enforced)`);
          plan.sessionLayout = null;
          plan.layoutHint = null;
          plan.pendingClick = null;
        }
      }

      // Click state machine: servo -> fired -> moveAway -> verify ->
      // (success: clear & next probe | fail: retry up to MAX_RETRIES).
      if (plan.pendingClick !== null && !plan.done) {
        const pc = plan.pendingClick;
        // Resolve current target slot pixel. Prefer the FROZEN pixel
        // position recorded at click setup — it doesn't drift across
        // observations the way per-frame template matches can (e.g.
        // when the cursor sprite passes over a template anchor and
        // momentarily occludes its match). Fall back to layout
        // re-resolution by semantic name/role/index if frozen target
        // wasn't set.
        const resolveSlot = (): { cx: number; cy: number } => {
          if (pc.frozenTarget) {
            return { cx: pc.frozenTarget.x, cy: pc.frozenTarget.y };
          }
          if (pc.slotName) {
            const f = layout!.slots.find((s) => s.name === pc.slotName);
            if (f) return { cx: f.cx, cy: f.cy };
          }
          if (pc.slotRole) {
            const f = layout!.slots.find((s) => s.role === pc.slotRole);
            if (f) return { cx: f.cx, cy: f.cy };
          }
          const f = layout!.slots[pc.rasterIndex];
          if (f) return { cx: f.cx, cy: f.cy };
          return { cx: 0, cy: 0 };
        };
        const slotCenter = resolveSlot();
        // Note: drift handling now derives "actual clicked slot" from
        // the snapshot diff in the verify phase (outcome.actualSlot
        // when kind === "drifted"). No need to compute it here from
        // pc.clickedAt + layout proximity.
        // Verify-park spot: route the cursor to the SAME park spot
        // used for held-icon detection (outside the GUI, top-right of
        // the window). Reasons:
        //   1. Cursor sprite is fully off the slot pixels we'll
        //      sample — no sprite contamination of post-patch.
        //   2. Forces a real cursor motion after the click: if the
        //      cursor was already at the slot when click fired (bad
        //      starting position, servo never landed), the move-to-
        //      park step will run and the verify will see the true
        //      slot state instead of a frame still showing cursor
        //      over the slot.
        const safeSpot = {
          x: Math.min(632, layout!.windowX + layout!.windowW + 16),
          y: layout!.windowY + 8,
        };

        // Strict thresholds: looser values caused clicks to land 13-17
        // px off slot center (servo cap firing during overshoot
        // approach), missing MC's effective hit region. Strict 5 px
        // threshold + 10-frame stuck cap matches the run that
        // achieved sim_score=1.0.
        // Servo step cap. Was 10 with the 2-deg uniform bin (~17 px
        // per step). Adaptive servo uses 0.25-deg final bins (~2 px
        // per step) for precision landing — needs more frames to
        // traverse the same distance. Bump to 20 so the click servo
        // doesn't time out before reaching the slot's hit-region.
        const SERVO_STEP_CAP = 20;
        const MAX_RETRIES = 4;
        const HIT_THRESHOLD_PX = 5;

        // Helper: emit a closed-loop action and remember the cam delta
        // so the next frame's stale-cursor check has ground truth.
        // hold_steps: 1 by default (servo / click need fresh obs each
        // env step). For pure noop frames (no buttons, no cam) bump
        // to 2 so the env runs a couple of steps without us paying
        // the obs round-trip cost on every one.
        const emit = (action: import("../McuPrompt").McuEnvAction, holdSteps: number = 1): SubAgentStep => {
          plan.lastEmittedCam = [action.camera[0], action.camera[1]];
          return { kind: "act", action, holdSteps };
        };

        // We need cursor from the outer scope. It's defined above within the layout block.
        // Since pendingClick is set only after entering the layout block, cursor is always
        // available here via the outer closure reference. TypeScript will track this.
        // Dead-reckoning: when CV cursor detection fails (cursor sprite is occluded
        // by an item icon under it), predict cursor position from the prior detected
        // cursor + the last emitted camera delta. Without this fallback, the servo
        // sees "no cursor" for 3-4 frames in a row, can't iterate the control law,
        // and the stuck guard aborts. With it, the controller keeps issuing
        // corrections through the blind window — which is exactly the closed-loop
        // robustness the deadzone-compensation papers stress.
        let cursor = plan.cursor ?? null;
        if (!cursor && plan.lastCursorRead && plan.lastEmittedCam) {
          // Dead-reckoning: predict cursor from prior detected pos + last
          // emitted camera delta. ~6.7 px/deg empirically (logs show
          // cam=10 → ~67 px). Coarse but enough to keep the controller
          // iterating through CV-failed frames so it doesn't hit the
          // stuck guard; next successful detection re-anchors.
          const PX_PER_DEG = 6.7;
          cursor = {
            x: Math.round(plan.lastCursorRead.x - plan.lastEmittedCam[1] * PX_PER_DEG),
            y: Math.round(plan.lastCursorRead.y - plan.lastEmittedCam[0] * PX_PER_DEG),
          };
          console.log(`[agentbeats] cursor undetected; dead-reckoning predicted=(${cursor.x},${cursor.y}) from prior (${plan.lastCursorRead.x},${plan.lastCursorRead.y}) + cam=[${plan.lastEmittedCam[0]},${plan.lastEmittedCam[1]}]`);
        }

        // === Phase: servo === move cursor to slot, then click
        if (pc.phase === "servo") {
          // Per-pendingClick delta-sigma pitch integrator. Lives on
          // pc so it persists across frames while the servo
          // converges; reset on a fresh click target.
          if (!(pc as any).servoIntegrator) {
            (pc as any).servoIntegrator = makeServoIntegrator();
          }
          // Capture the slot's pre-state ONCE at servo start, when
          // the cursor is still at its previous position (park or
          // prior slot) — far from this target slot. Sampling at
          // click-time pollutes the patch with cursor-sprite pixels
          // (cursor is over the slot at that moment), which makes
          // post.stddev ≈ pre.stddev and breaks the rise/drop gate.
          if (!pc.prePatch && plan.servoSteps === 0) {
            pc.prePatch = samplePatchFingerprint(payload.obs, slotCenter.cx, slotCenter.cy) ?? undefined;
          }
          const stepResult = servoCursorStep({
            cursor,
            target: { x: slotCenter.cx, y: slotCenter.cy },
            button: pc.button,
            shift: pc.shift,
            hitThresholdPx: HIT_THRESHOLD_PX,
            integrator: (pc as any).servoIntegrator,
          });
          plan.servoSteps += 1;
          // Trajectory log: capture EVERY servo frame regardless of
          // hover/click branch. Provides ground truth for offline
          // system identification (px-per-deg, deadzone, CV-failure).
          const tDir = process.env.AGENTBEATS_DEBUG_DIR;
          if (tDir) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const fs = require("node:fs") as typeof import("node:fs");
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const pathMod = require("node:path") as typeof import("node:path");
              const camY = stepResult ? stepResult.action.camera[1] : 0;
              const camP = stepResult ? stepResult.action.camera[0] : 0;
              const row = JSON.stringify({
                ts: Date.now(),
                step,
                iter: plan.iteration,
                target: { x: slotCenter.cx, y: slotCenter.cy, slot: pc.rasterIndex, name: pc.slotName },
                cursor: cursor ? { x: cursor.x, y: cursor.y } : null,
                cursor_observed: !!plan.cursor,
                cam: { pitch: camP, yaw: camY },
                kind: pc.kind,
                phase: pc.phase,
                errMag: cursor ? Math.hypot(cursor.x - slotCenter.cx, cursor.y - slotCenter.cy) : null,
                reason: stepResult?.reason ?? "no-cursor",
              });
              fs.appendFileSync(pathMod.join(tDir, "servo_trajectory.jsonl"), row + "\n");
            } catch { /* swallow */ }
          }
          // Hover: servo to slot, then exit WITHOUT clicking. Cursor
          // is left on the slot for MC to render its tooltip in the
          // next probe image.
          if ((pc.kind as string) === "hover") {
            // Slots are ~18 px apart on screen; a 12 px arrival
            // tolerance let the cursor settle on the EDGE of the
            // target slot, where MC would render the NEIGHBOR slot's
            // tooltip and OCR would correctly read the wrong slot's
            // item -- corrupting slotMemory. 3 px keeps the cursor
            // pixel inside the intended slot.
            // Hover-arrival threshold tuned to the quadratic model's
            // achievable precision. Smallest effective cam (yaw 2°)
            // produces ~2.7 px displacement; smallest pitch (4°) gives
            // ~10.7 px. So in the err=[3, 6] band, the controller
            // bounces because every emit overshoots back across.
            // Accept arrival at ≤5 px — the cursor IS inside the
            // intended slot's interior (slot is 16×16 px) for tooltip
            // rendering, and this avoids deadband oscillation.
            const arrived = !!cursor && Math.hypot(cursor.x - slotCenter.cx, cursor.y - slotCenter.cy) <= 5;
            if (arrived || plan.servoSteps > SERVO_STEP_CAP) {
              console.log(`[agentbeats] hover arrived at ${pc.slotName ?? pc.rasterIndex} cursor=(${cursor?.x},${cursor?.y}); leaving cursor for tooltip; clearing pendingClick`);
              state.closedLoopHistory.unshift(`hover slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} done`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              plan.pendingClick = null;
              // Brief settle frame; if MC hasn't rendered the tooltip
              // yet, the OCR retry loop in the next handleObservation
              // tick will re-fire the OCR up to 3 times before giving
              // up.
              return emit(defaultMcuAction(), 4);
            }
            if (stepResult) {
              // servoCursorStep can return click=true with the button
              // pressed once cursor is within its hit threshold (~5 px),
              // but for hover we must NEVER click -- a click would
              // pickup/place the item and corrupt slot state. Strip
              // any attack/use buttons before emitting.
              const cameraOnly = { ...stepResult.action, attack: 0 as 0 | 1, use: 0 as 0 | 1 };
              return emit(cameraOnly);
            }
            return emit(defaultMcuAction());
          }
          // Click hit-region. The sim's deadzones limit the cursor's
          // best-case landing precision to ±yawDeadzone/2 (~8.5 px
          // x) / ±pitchDeadzone/2 (~10 px y). Tightening below that
          // leaves the cursor permanently outside the click region.
          // Click bbox = MC's actual slot hit-region with a safety
          // margin INWARD from the edge. Cursor tip at the slot's
          // top edge (dy = -slotH/2) renders the cursor body inside
          // the slot visually but MC's click point is the TIP —
          // outside its hit region — and the click misses. Require
          // tip well inside the slot interior to guarantee a hit.
          const slotForBox = layout!.slots[pc.rasterIndex];
          const slotHalfW = Math.max(4, Math.round((slotForBox?.w ?? 16) / 2) - 2);
          const slotHalfH = Math.max(4, Math.round((slotForBox?.h ?? 16) / 2) - 2);
          const cursorInsideSlot = !!cursor
            && Math.abs(cursor.x - slotCenter.cx) <= slotHalfW
            && Math.abs(cursor.y - slotCenter.cy) <= slotHalfH;
          const errMagNow = cursor
            ? Math.hypot(cursor.x - slotCenter.cx, cursor.y - slotCenter.cy)
            : Infinity;
          const STUCK_DELTA = 1.0;       // <1 px improvement counts as stuck
          const STUCK_THRESHOLD = 4;     // bail after 4 consecutive stalls
          const lastErr = (pc as any).lastErrMag ?? Infinity;
          if (errMagNow >= lastErr - STUCK_DELTA) {
            (pc as any).stuckCount = ((pc as any).stuckCount ?? 0) + 1;
          } else {
            (pc as any).stuckCount = 0;
          }
          (pc as any).lastErrMag = errMagNow;
          const isStuck = ((pc as any).stuckCount ?? 0) >= STUCK_THRESHOLD;
          if (isStuck && !cursorInsideSlot) {
            console.warn(`[agentbeats] servo stuck: cursor (${cursor?.x},${cursor?.y}) target (${slotCenter.cx},${slotCenter.cy}) err=${errMagNow.toFixed(1)}px no improvement for ${STUCK_THRESHOLD} steps; aborting`);
            state.closedLoopHistory.unshift(`abort ${pc.slotName ?? pc.rasterIndex} (servo stuck off-slot)`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            plan.pendingClick = null;
            return emit(defaultMcuAction());
          }
          const shouldClickNow = cursorInsideSlot && plan.servoSteps >= 1;
          if (shouldClickNow) {
            // Safety: clicking outside the inventory window drops the
            // held stack to the world ("throw"). Refuse to fire if the
            // detected cursor is outside the window bbox.
            const cursorInsideWindow = !!cursor
              && cursor.x >= layout!.windowX
              && cursor.x <= layout!.windowX + layout!.windowW
              && cursor.y >= layout!.windowY
              && cursor.y <= layout!.windowY + layout!.windowH;
            if (!cursorInsideWindow) {
              console.warn(`[agentbeats] click suppressed: cursor (${cursor?.x},${cursor?.y}) outside inventory window [${layout!.windowX},${layout!.windowY},${layout!.windowW}x${layout!.windowH}]; aborting to avoid throwing held item`);
              state.closedLoopHistory.unshift(`abort ${pc.slotName ?? pc.rasterIndex} (cursor outside window; would throw item)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              plan.pendingClick = null;
              plan.sessionLayout = null;
              plan.layoutHint = null;
              return emit(defaultMcuAction());
            }
            // prePatch was captured at servo-start (cursor far from
            // slot, no sprite contamination); keep it for verify.
            // Fallback only if it was somehow missed.
            if (!pc.prePatch) {
              pc.prePatch = samplePatchFingerprint(payload.obs, slotCenter.cx, slotCenter.cy) ?? undefined;
            }
            // Pre-condition for "should_empty" actions (pickup/take):
            // source slot MUST currently have an item. Use the same
            // stricter fingerprint -- low stddev AND mean in the
            // empty band (~120-160). A bright item (e.g. nether
            // quartz, mean ~190) has low stddev but is NOT empty.
            const preLum = pc.prePatch
              ? (pc.prePatch.meanR + pc.prePatch.meanG + pc.prePatch.meanB) / 3
              : 0;
            const preInEmptyBand = preLum > 120 && preLum < 160;
            if (pc.expectAfter === "should_empty"
                && pc.prePatch
                && pc.prePatch.stddev < 25
                && preInEmptyBand) {
              console.warn(`[agentbeats] pickup/take aborted: slot=${pc.rasterIndex}(${pc.slotName ?? "?"}) looks already empty (pre.stddev=${pc.prePatch.stddev.toFixed(1)} lum=${preLum.toFixed(0)})`);
              state.closedLoopHistory.unshift(`abort ${pc.kind ?? "click"} slot=${pc.rasterIndex} (source slot empty; nothing to grab)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              plan.pendingClick = null;
              return emit(defaultMcuAction());
            }
            const action = defaultMcuAction();
            action[pc.button] = 1;
            if (pc.shift) action.sneak = 1;
            pc.phase = "fired";
            plan.servoSteps = 0;
            // Record the cursor's ACTUAL pixel position at the moment
            // the click fired — MC interprets the click at this pixel,
            // not at the intended slot center. The verify path uses
            // this to find which layout slot CONTAINS that pixel
            // (the slot MC actually clicked). All slotMemory and
            // cursor-state updates downstream key off the actual slot,
            // so context reflects reality even when servo lands a few
            // pixels off and clicks a NEIGHBOR slot instead.
            if (cursor) {
              pc.clickedAt = { x: cursor.x, y: cursor.y };
              const intendedSlot = layout!.slots[pc.rasterIndex];
              if (intendedSlot) {
                const drift = Math.hypot(cursor.x - intendedSlot.cx, cursor.y - intendedSlot.cy);
                if (drift > 6) {
                  console.warn(`[agentbeats] click landed off intended slot ${pc.rasterIndex}(${pc.slotName ?? "?"}) by ${drift.toFixed(1)}px — actual click pixel (${cursor.x},${cursor.y}); verify will resolve to actual slot from layout`);
                }
              }
            }
            console.log(`[agentbeats] click ${pc.slotName ?? pc.rasterIndex} (${pc.button}${pc.shift ? "+sneak" : ""}) at cursor=(${cursor?.x},${cursor?.y}) prePatch.stddev=${pc.prePatch?.stddev.toFixed(1) ?? "?"}`);
            return emit(action);
          }
          if (stepResult) {
            console.log(
              `[agentbeats] servo step=${step} cursor=(${cursor?.x},${cursor?.y}) target=(${slotCenter.cx},${slotCenter.cy}) name=${pc.slotName ?? "?"} ${stepResult.reason}`,
            );
            // Trajectory log already fired earlier (universal post-
            // servoCursorStep hook covering both hover and click paths).
            return emit(stepResult.action);
          }
          console.log(`[agentbeats] servo step=${step}: no cursor detected; noop`);
          return emit(defaultMcuAction());
        }

        // === Phase: fired === one settle frame to let the click apply
        if (pc.phase === "fired") {
          pc.phase = "moveAway";
          plan.servoSteps = 0;
          console.log(`[agentbeats] click settled; moving cursor away from ${pc.slotName ?? pc.rasterIndex} for verify`);
          // Pure settle frame, no input. Run 2 env steps so MC has time to apply the click.
          return emit(defaultMcuAction(), 2);
        }

        // === Phase: moveAway === servo cursor to safe spot
        if (pc.phase === "moveAway") {
          const stepResult = servoCursorStep({
            cursor,
            target: safeSpot,
            button: "attack",
            hitThresholdPx: HIT_THRESHOLD_PX,
          });
          plan.servoSteps += 1;
          const distFromSafe = cursor ? Math.hypot(cursor.x - safeSpot.x, cursor.y - safeSpot.y) : 999;
          const arrived = distFromSafe < 12 || plan.servoSteps > SERVO_STEP_CAP;
          if (arrived) {
            pc.phase = "verify";
            console.log(`[agentbeats] cursor at safe spot (${cursor?.x},${cursor?.y}); next frame will verify`);
            // Pure noop wait-for-verify frame: bump hold_steps.
            return emit(defaultMcuAction(), 2);
          }
          if (stepResult && !stepResult.click) {
            return emit(stepResult.action);
          }
          return emit(defaultMcuAction());
        }

        // === Phase: verify === park-state snapshot diff
        // Cursor is already at park (moveAway target = park spot).
        // Take a fresh snapshot of every slot + cursor area, diff
        // against plan.lastParkSnapshot, classify the outcome.
        // Spec: docs/superpowers/specs/2026-05-07-park-snapshot-action-verify-design.md
        if (pc.phase === "verify") {
          const { takeLayoutSnapshot, diffSnapshots, classifyOutcome, identifyChangedSlot } = await import("../tools/SnapshotDiff");
          const postSnap = takeLayoutSnapshot(payload.obs, layout!, cursor, plan.iteration, plan.parkEmptyCursorPatch, plan.lastProbeCursor);
          const preSnap = plan.lastParkSnapshot;
          // Button-click verify (place_all with expectedItem=""): no
          // slot transition is expected. Confirm by sampling the
          // destSlot's patch fingerprint and comparing to prePatch —
          // a successful click visibly changes the button (e.g.
          // enchant offer level text disappears).
          if (pc.expectAfter === "should_change") {
            const postPatch = samplePatchFingerprint(payload.obs, pc.frozenTarget.x, pc.frozenTarget.y, 6);
            const dr = postPatch && pc.prePatch ? Math.abs(postPatch.meanR - pc.prePatch.meanR) : 0;
            const dg = postPatch && pc.prePatch ? Math.abs(postPatch.meanG - pc.prePatch.meanG) : 0;
            const db = postPatch && pc.prePatch ? Math.abs(postPatch.meanB - pc.prePatch.meanB) : 0;
            const dStd = postPatch && pc.prePatch ? Math.abs(postPatch.stddev - pc.prePatch.stddev) : 0;
            const meanDelta = (dr + dg + db) / 3;
            const changed = postPatch !== null && pc.prePatch !== undefined && (meanDelta > 12 || dStd > 8);
            console.log(`[agentbeats] verify ${pc.slotName ?? pc.rasterIndex} click: meanDelta=${meanDelta.toFixed(1)} dStd=${dStd.toFixed(1)} -> ${changed ? "CHANGED" : "no_op"}`);
            plan.lastParkSnapshot = postSnap;
            if (changed) {
              state.closedLoopHistory.unshift(`click slot=${pc.rasterIndex}(${pc.slotName ?? "?"}) OK (visual change)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              if (plan.activeChecklistIdx >= 0
                  && plan.activeChecklistIdx < plan.checklist.length
                  && !plan.checklist[plan.activeChecklistIdx].done) {
                const active = plan.checklist[plan.activeChecklistIdx];
                if ((active.task as { kind?: string })?.kind === "place_all") {
                  active.done = true;
                  console.log(`[agentbeats] auto-tick checklist[${plan.activeChecklistIdx}] (${active.id}, click) done`);
                }
              }
              if (plan.pendingChain.length === 0) plan.judgeAfterChain = true;
              const next = plan.pendingChain.shift();
              if (next) {
                next.phase = "servo";
                next.retries = 0;
                plan.pendingClick = next;
                plan.servoSteps = 0;
              } else {
                plan.pendingClick = null;
              }
              return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
            }
            // No change detected. Retry up to 2 times before giving up.
            pc.retries += 1;
            if (pc.retries >= 3) {
              state.closedLoopHistory.unshift(`click slot=${pc.rasterIndex}(${pc.slotName ?? "?"}) failed (no visual change after 3 tries)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              plan.pendingClick = null;
              plan.judgeAfterChain = true;
              return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
            }
            pc.phase = "servo";
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          if (!preSnap) {
            console.warn(`[agentbeats] verify: no pre-snapshot available — accepting click and capturing post as new baseline`);
            plan.lastParkSnapshot = postSnap;
            plan.pendingClick = null;
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          const intentKind: "pickup" | "place_one" | "place_all" =
            pc.actionKind === "place_one" ? "place_one"
            : pc.actionKind === "place_all" ? "place_all"
            : "pickup"; // "take" treated as pickup
          const diff = diffSnapshots(preSnap, postSnap);
          const outcome = classifyOutcome({ kind: intentKind, targetSlot: pc.rasterIndex }, diff);
          const slotChangesStr = Array.from(diff.slotChanges.entries()).map(([i, c]) => `${i}:${c}`).join(",") || "(none)";
          console.log(`[agentbeats] verify ${pc.slotName ?? pc.rasterIndex} ${intentKind}: outcome=${outcome.kind} slotChanges=[${slotChangesStr}] cursor=${diff.cursorChange}`);
          if (deps.debugDir) {
            void deps.recordDebug("verify", {
              type: "verify",
              step,
              data: {
                slotName: pc.slotName, slotIndex: pc.rasterIndex,
                intent: intentKind,
                outcome: outcome.kind,
                slotChanges: Array.from(diff.slotChanges.entries()),
                cursorChange: diff.cursorChange,
                retries: pc.retries,
                cursor: plan.cursor,
              },
            });
          }
          const matched = outcome.kind === "confirmed" || outcome.kind === "drifted";
          if (matched) {
            // Identity propagation from snapshot diff. The outcome
            // tells us which slot actually changed (target or drifted
            // neighbour); update slotMemory + cursorItemSignature
            // accordingly.
            //   1. Cursor was holding X, slot newly filled → that
            //      slot is X (logical certainty, no pixel match).
            //   2. Slot newly filled with no held context → match
            //      against known item patches (sim ≥ 0.85), else
            //      mark unknown.
            //   3. Slot newly emptied → drop slotMemory entry; if
            //      pickup intent, that item is now on the cursor.
            const changedSlotIdx = outcome.kind === "drifted" ? outcome.actualSlot : pc.rasterIndex;
            const changedSlotLayout = layout!.slots[changedSlotIdx];
            const drifted = outcome.kind === "drifted";
            const slotLabel = drifted
              ? `slot=${changedSlotIdx}(${changedSlotLayout?.name ?? "?"}) [intended ${pc.rasterIndex}(${pc.slotName ?? "?"}) — DRIFTED]`
              : `slot=${pc.rasterIndex}(${pc.slotName ?? "?"})`;
            state.closedLoopHistory.unshift(`${pc.actionKind ?? pc.kind ?? "click"} ${slotLabel} OK${drifted ? "" : ""}`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            const change = outcome.kind === "drifted" ? outcome.change : (outcome as { change: typeof outcome extends { change: infer C } ? C : never }).change;
            if (change === "filled→empty") {
              // Slot emptied. Drop its slotMemory entry. Pickup intent
              // → cursor now carries that slot's item.
              if (changedSlotLayout) {
                const sourceMem = plan.slotMemory.lookup(changedSlotLayout.cx, changedSlotLayout.cy);
                plan.slotMemory.invalidate(changedSlotLayout.cx, changedSlotLayout.cy);
                if (intentKind === "pickup") {
                  plan.cursorItemSignature = sourceMem?.item && sourceMem.item !== "empty" && sourceMem.item !== "unknown"
                    ? { meanR: 0, meanG: 0, meanB: 0, item: sourceMem.item }
                    : { meanR: 0, meanG: 0, meanB: 0 };
                  console.log(`[agentbeats] pickup confirmed: ${slotLabel} cursor now holds '${plan.cursorItemSignature.item ?? "?"}'`);
                }
              }
            } else if (change === "empty→filled" || change === "swapped") {
              // Slot filled. Identity from cursor first, else pixel match.
              const newPatch = postSnap.slots.get(changedSlotIdx);
              let placedItem: string | undefined = undefined;
              if (intentKind === "place_one" || intentKind === "place_all") {
                placedItem = plan.cursorItemSignature?.item ?? pc.placedItemName ?? undefined;
              }
              if (!placedItem && newPatch) {
                const known: Array<{ item: string; patch?: typeof newPatch }> = [];
                for (const e of plan.slotMemory.snapshot()) if (e.patch) known.push({ item: e.item, patch: e.patch });
                const id = identifyChangedSlot(newPatch, known);
                if (id) placedItem = id.item;
              }
              if (changedSlotLayout) {
                // ALWAYS record — the slot is deterministically filled
                // per the verify outcome. If we don't know the item,
                // fall back to "unknown"; the next planner call sees
                // the slot is occupied and won't re-place there.
                const itemToRecord = placedItem ?? "unknown";
                const fp = samplePatchFingerprint(payload.obs, changedSlotLayout.cx, changedSlotLayout.cy, 6) ?? undefined;
                plan.slotMemory.record(changedSlotLayout.cx, changedSlotLayout.cy, itemToRecord, plan.iteration, fp, newPatch ?? undefined);
                console.log(`[agentbeats] place confirmed: ${slotLabel} item=${itemToRecord}`);
              }
              // place_all deterministically empties the cursor (drops
              // the whole stack). Don't gate on cursorChange detection —
              // the BG-masked diff is too fragile to be load-bearing.
              if (intentKind === "place_all") {
                plan.cursorItemSignature = null;
                console.log(`[agentbeats] place_all confirmed → cursor cleared`);
              } else if (diff.cursorChange === "holding→empty") {
                plan.cursorItemSignature = null;
                console.log(`[agentbeats] cursor empty after place`);
              }
            }
            // Bonus side-effect changes (e.g. result slot auto-fills
            // when the last ingredient is placed and the recipe
            // completes). Write them to slotMemory too so the planner
            // sees the result item appear in Known.
            for (const [idx, ch] of diff.slotChanges) {
              if (idx === changedSlotIdx) continue; // already handled
              const sl = layout!.slots[idx];
              if (!sl) continue;
              if (ch === "filled→empty") {
                plan.slotMemory.record(sl.cx, sl.cy, "empty", plan.iteration);
                console.log(`[agentbeats] side-effect: slot ${idx}(${sl.name ?? "?"}) emptied`);
              } else {
                const newPatch = postSnap.slots.get(idx);
                // For result slot specifically, identify item via recipe.target.
                let item: string | undefined =
                  sl.role === "result" && plan.recipeOverride
                    ? plan.recipeOverride.target
                    : undefined;
                if (!item && newPatch) {
                  const known: Array<{ item: string; patch?: typeof newPatch }> = [];
                  for (const e of plan.slotMemory.snapshot()) if (e.patch) known.push({ item: e.item, patch: e.patch });
                  const id = identifyChangedSlot(newPatch, known);
                  if (id) item = id.item;
                }
                const fp = samplePatchFingerprint(payload.obs, sl.cx, sl.cy, 6) ?? undefined;
                plan.slotMemory.record(sl.cx, sl.cy, item ?? "unknown", plan.iteration, fp, newPatch ?? undefined);
                console.log(`[agentbeats] side-effect: slot ${idx}(${sl.name ?? "?"}) filled with ${item ?? "unknown"}`);
              }
            }
            // Update lastParkSnapshot to the new post-snapshot so the
            // next click's diff has the correct pre-state.
            plan.lastParkSnapshot = postSnap;
            // Auto-tick the active FastUI checklist item when verify
            // confirms the action it dispatched. The Planner LLM is
            // unreliable at marking primitive-click subtasks done from
            // recent_history alone — runtime has authoritative info
            // (intent + slot delta), so resolve the bookkeeping here
            // rather than ask the LLM to infer it.
            if (plan.activeChecklistIdx >= 0
                && plan.activeChecklistIdx < plan.checklist.length
                && !plan.checklist[plan.activeChecklistIdx].done) {
              const active = plan.checklist[plan.activeChecklistIdx];
              const taskKind = (active.task as { kind?: string })?.kind;
              // Primitive subtasks map 1:1 to verify outcomes.
              const matched =
                (taskKind === "pickup" && intentKind === "pickup" && change === "filled→empty")
                || (taskKind === "place_one" && intentKind === "place_one" && (change === "empty→filled" || change === "swapped"))
                || (taskKind === "place_all" && intentKind === "place_all" && (change === "empty→filled" || change === "swapped"))
                || (taskKind === "take_result" && intentKind === "pickup" && change === "filled→empty");
              if (matched) {
                active.done = true;
                console.log(`[agentbeats] auto-tick checklist[${plan.activeChecklistIdx}] (${active.id}, ${taskKind}) done — verify confirmed`);
              }
            }
            // Arm Planner re-judge after the LAST click in a chain
            // (i.e. when no more clicks queued). The runtime fires
            // Planner on the next entry to this function.
            if (plan.pendingChain.length === 0) {
              plan.judgeAfterChain = true;
            }
            // Advance the chain: if there's a queued follow-up click
            // (e.g. the place_one or auto_return inside a "move" op),
            // promote it into pendingClick. Otherwise return to VLM.
            const next = plan.pendingChain.shift();
            if (next) {
              next.phase = "servo";
              next.retries = 0;
              next.prePatch = undefined;
              plan.pendingClick = next;
              plan.servoSteps = 0;
              console.log(`[agentbeats] chain advance -> ${next.actionKind ?? next.kind} slot=${next.rasterIndex}(${next.slotName ?? "?"}) (${plan.pendingChain.length} more queued)`);
            } else {
              plan.pendingClick = null;
            }
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          // Mismatch path: outcome was no_op or anomaly.
          //  - no_op: nothing changed → click missed → retry up to MAX_RETRIES.
          //  - anomaly: unexpected pattern → log, accept observed
          //    changes (so context reflects reality), advance.
          if (outcome.kind === "anomaly") {
            console.warn(`[agentbeats] anomaly: ${outcome.reason} — accepting observed changes and advancing`);
            // Accept all observed slot changes into slotMemory.
            for (const [idx, ch] of diff.slotChanges) {
              const sl = layout!.slots[idx];
              if (!sl) continue;
              if (ch === "filled→empty") {
                plan.slotMemory.invalidate(sl.cx, sl.cy);
              } else {
                const newPatch = postSnap.slots.get(idx);
                let item: string | undefined = plan.cursorItemSignature?.item;
                if (!item && newPatch) {
                  const known: Array<{ item: string; patch?: typeof newPatch }> = [];
                  for (const e of plan.slotMemory.snapshot()) if (e.patch) known.push({ item: e.item, patch: e.patch });
                  const id = identifyChangedSlot(newPatch, known);
                  if (id) item = id.item;
                }
                if (item) {
                  const fp = samplePatchFingerprint(payload.obs, sl.cx, sl.cy, 6) ?? undefined;
                  plan.slotMemory.record(sl.cx, sl.cy, item, plan.iteration, fp, newPatch ?? undefined);
                }
              }
            }
            if (diff.cursorChange === "holding→empty") plan.cursorItemSignature = null;
            plan.lastParkSnapshot = postSnap;
            plan.pendingClick = null;
            plan.pendingChain = [];
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          // no_op: BEFORE retrying, sanity-check the cursor. The most common
          // cause of place_one/place_all → no_op when cursorItemSignature
          // says we're holding something is that the Action LLM consumed
          // the last item on a previous click and the runtime never cleared
          // the signature (place_all on the SAME pickup slot returns no_op
          // because the slot can't change). Held items suppress slot
          // tooltips, so an OCR-readable tooltip on a known slot proves
          // the cursor is empty.
          const isPlace = pc.actionKind === "place_one" || pc.actionKind === "place_all";
          if (
            isPlace
            && plan.cursorItemSignature?.item
            && !plan.cursorVerifyJob
            && plan.slotMemory.snapshot().some(e => e.item && e.item !== "unknown")
          ) {
            const known = plan.slotMemory.snapshot().filter(e => e.item && e.item !== "unknown");
            // Prefer a slot DIFFERENT from the failed click's destination so
            // we're not OCR'ing a stale/mid-flight slot.
            const candidate = known.find(e => Math.hypot(e.x - pc.frozenTarget.x, e.y - pc.frozenTarget.y) > 8) ?? known[0];
            // Find the candidate's raster index in the current layout (so the
            // servo step can target a valid slot index).
            let knownSlotIdx = -1;
            for (let i = 0; i < layout!.slots.length; i++) {
              const s = layout!.slots[i];
              if (s && Math.hypot(s.cx - candidate.x, s.cy - candidate.y) < 8) { knownSlotIdx = i; break; }
            }
            if (knownSlotIdx >= 0) {
              plan.cursorVerifyJob = {
                knownSlotIdx,
                target: { x: candidate.x, y: candidate.y },
                slotName: layout!.slots[knownSlotIdx]?.name,
                expectedItem: candidate.item,
                phase: "servo",
                servoSteps: 0,
                hoverFrames: 0,
              };
              // Suspend the failed click chain — we'll either drop it
              // (cursor confirmed empty) or escalate (genuine anomaly)
              // when the OCR result is in. Don't retry yet.
              const savedFailureLabel = `${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} no_op pending cursor-empty OCR verify`;
              console.log(`[agentbeats] ${savedFailureLabel} — servoing to ${candidate.item} @ (${Math.round(candidate.x)},${Math.round(candidate.y)}) for tooltip OCR`);
              plan.lastParkSnapshot = postSnap;
              plan.pendingClick = null;
              plan.pendingChain = [];
              return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
            }
          }
          // no_op: retry up to MAX_RETRIES, then abort.
          const inActionAgentMode = plan.checklist.length > 0 && plan.activeChecklistIdx >= 0;
          if (!inActionAgentMode && pc.retries < MAX_RETRIES) {
            pc.retries += 1;
            pc.phase = "servo";
            plan.servoSteps = 0;
            console.log(`[agentbeats] RETRY click on ${pc.slotName ?? pc.rasterIndex} (attempt ${pc.retries + 1}/${MAX_RETRIES + 1}) — no observable change`);
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          const failureLabel = `${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} FAILED (no observable change)`;
          state.closedLoopHistory.unshift(`${failureLabel} (chain aborted; ${plan.pendingChain.length} dropped)`);
          state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
          console.warn(`[agentbeats] ${failureLabel}; retries exhausted; clearing chain (${plan.pendingChain.length} dropped) and returning to VLM`);
          plan.lastParkSnapshot = postSnap;
          plan.pendingClick = null;
          plan.pendingChain = [];
          return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
        }

      }
    }
  }

  if (!deps.apiKey) {
    throw new Error("OPENAI_API_KEY or API_KEY is required for AgentBeats observations; heuristic fallback actions are disabled.");
  }
  if (state.recentObservationImages.length === 0) {
    throw new Error("AgentBeats observation image is required; heuristic fallback actions are disabled.");
  }

  if (step <= state.holdUntilStep && !shouldUseModelOnStep(step, deps.modelEveryNSteps)) {
    return { kind: "act", action: state.lastAction, holdSteps: 1 };
  }

  let decision = await deps.modelDecision(state, step);
  if ((decision as McuPolicyDecision & { task_done?: boolean }).task_done) {
    console.log(`[agentbeats] VLM declared task_done=true at step=${step}; entering early-stop noop loop for the rest of the episode`);
    state.earlyStop = true;
    return { kind: "subgoal_done", summary: "VLM declared task_done=true" };
  }
  decision = repairDecisionForTask(decision, state.taskText, step);

  const holdSteps = Math.max(
    1,
    Math.min(deps.maxHoldSteps, decision.hold_steps ?? deps.defaultHoldSteps),
  );
  state.lastAction = decision.action;
  state.holdUntilStep = step + holdSteps - 1;
  state.recentActions.push(decision.action);
  state.recentActions = state.recentActions.slice(-16);

  console.log(
    `[agentbeats] step=${step} hold=${holdSteps} action=${JSON.stringify({
      pressed: MCU_BUTTON_KEYS.filter((key) => decision?.action[key] === 1),
      camera: decision.action.camera,
    })}`,
  );
  return { kind: "act", action: decision.action, holdSteps };
}
