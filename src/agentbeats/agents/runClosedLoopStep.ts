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
} from "../tools/UiFastControl";
import { probeNextCraftAction, vlmVerifySlotState } from "../tools/InventoryProbe";
import { detectCursorWithExpectation, detectGuiLayout, samplePatchFingerprint } from "../tools/SlotDetector";
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
  recordDebug: (kind: string, payload: unknown) => Promise<void>;
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

  // Drain any queued macro frames first.
  if (state.pendingMacroFrames.length > 0) {
    const frame = state.pendingMacroFrames.shift()!;
    return emitMacroFrame(frame);
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
        const PARK_STEP_CAP = 6;
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
        // Re-SOM only NOW, just before calling the VLM. Within an
        // in-flight click sequence the layout stays stable (we keep
        // using the locked session); fresh detection only matters at
        // the moment the VLM is about to make a new decision.
        let layoutForProbe = layout;
        {
          const fresh = detectGuiLayout(payload.obs, plan.layoutHint ?? undefined);
          if (fresh) {
            plan.sessionLayout = fresh;
            plan.layoutHint = fresh.matchedLayoutId;
            layoutForProbe = fresh;
            console.log(`[agentbeats] re-detected SoM for fresh probe: ${fresh.matchedLayoutId ?? "unknown"} slots=${fresh.slots.length}`);
          }
        }
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
        const cursorHolding: boolean | null = (() => {
          // Detection happens ONLY when cursor is at park (outside
          // the GUI). Anywhere else we cannot tell whether a high-
          // stddev patch is the held-item icon or an underlying slot.
          if (!cursorAtPark) return null;
          // Held-item icon renders ~8 px NW of cursor tip; at park
          // that is in the dimmed world-view region (no slot icons).
          const HELD_NW_X = -8, HELD_NW_Y = -8;
          const live = samplePatchFingerprint(payload.obs, PARK_X + HELD_NW_X, PARK_Y + HELD_NW_Y, 4);
          if (!live) return null;
          // Baseline capture: first time cursor is at park, cursor is
          // empty by construction (session start, no prior pickup).
          if (plan.parkEmptyBaseline === null) {
            plan.parkEmptyBaseline = live;
            console.log(`[agentbeats] park baseline captured: meanR=${live.meanR.toFixed(0)} G=${live.meanG.toFixed(0)} B=${live.meanB.toFixed(0)} stddev=${live.stddev.toFixed(1)}`);
            return false;
          }
          const bl = plan.parkEmptyBaseline;
          const dr = live.meanR - bl.meanR, dg = live.meanG - bl.meanG, db = live.meanB - bl.meanB;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist > 15) {
            console.log(`[agentbeats] cursorHolding=true (park dist=${dist.toFixed(1)})`);
            return true;
          }
          if (dist < 8) return false;
          return null;
        })();
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
            if (!mem.fingerprint) {
              // Lazy baseline capture from the probe frame (no hover).
              plan.slotMemory.record(s.cx, s.cy, mem.item, mem.step, live);
              console.log(`[agentbeats] fp baseline captured for slot ${s.index}(${s.name ?? "?"}) item='${mem.item}' meanRGB=(${live.meanR.toFixed(0)},${live.meanG.toFixed(0)},${live.meanB.toFixed(0)}) stddev=${live.stddev.toFixed(1)}`);
              knownSlots.push({ index: s.index, name: s.name, item: mem.item, ageIters: plan.iteration - mem.step });
              continue;
            }
            const dr = live.meanR - mem.fingerprint.meanR;
            const dg = live.meanG - mem.fingerprint.meanG;
            const db = live.meanB - mem.fingerprint.meanB;
            const distFromBaseline = Math.sqrt(dr * dr + dg * dg + db * db);
            const liveLum = (live.meanR + live.meanG + live.meanB) / 3;
            const liveLooksEmpty = live.stddev < 20 && liveLum > 120 && liveLum < 160;
            if (distFromBaseline > 40 && liveLooksEmpty) {
              disappearedItems.push(mem.item);
              disappearedFps.push({ item: mem.item, fp: mem.fingerprint });
              plan.slotMemory.invalidate(s.cx, s.cy);
              console.log(`[agentbeats] item disappeared: '${mem.item}' was at slot ${s.index}(${s.name ?? "?"}) -- dist=${distFromBaseline.toFixed(1)} liveLum=${liveLum.toFixed(1)} live.stddev=${live.stddev.toFixed(1)}`);
              continue;
            }
            knownSlots.push({ index: s.index, name: s.name, item: mem.item, ageIters: plan.iteration - mem.step });
          }
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
          const result = await probeNextCraftAction({
            client: deps.client,
            model: deps.model,
            obsBase64: payload.obs,
            taskText: plan.taskText,
            iteration: plan.iteration,
            sessionLayout: layoutForProbe, // freshly redetected for each probe
            recentActions: state.closedLoopHistory,
            cursorHolding,
            pickupSourceSlot: plan.pickupSourceSlot ?? null,
            disappearedItems,
            slotUpdates,
            recipeInfo: plan.recipeOverride,
            knownSlots,
          });
          plan.iteration += 1;
          const probed = result.action;
          if (!probed) {
            // Probe failed to return an action — invalidate the SoM
            // session so the next frame redetects (some slots may have
            // been occluded the first time) and re-probes. Don't set
            // done: manual LLM cursor control runs at ~3% success.
            console.log(`[agentbeats] closed-loop probe returned no action; invalidating SoM session and reprobing next frame`);
            plan.sessionLayout = null;
            plan.layoutHint = null;
          } else if (probed.action === "done") {
            // CV-verify the probe's "done" claim: the result slot
            // must actually be empty AND the cursor must be empty
            // (we use cursorItemSignature == null as proxy). If
            // accepted, set plan.done so control falls through to
            // the regular VLM which can then set task_done.
            const resultSlot = layoutForProbe.slots.find((s) => s.role === "result");
            const resultPatch = resultSlot ? samplePatchFingerprint(payload.obs, resultSlot.cx, resultSlot.cy, 12) : null;
            const resultEmpty = !!resultPatch && resultPatch.stddev < 25;
            const cursorEmpty = plan.cursorItemSignature === null;
            if (resultEmpty && cursorEmpty) {
              console.log(`[agentbeats] closed-loop probe says done; CV-verified (result empty, cursor empty); accepting`);
              plan.done = true;
            } else {
              console.warn(`[agentbeats] closed-loop probe said done but CV-verify failed (resultEmpty=${resultEmpty}, cursorEmpty=${cursorEmpty}); ignoring`);
              state.closedLoopHistory.unshift(`done IGNORED (resultEmpty=${resultEmpty}, cursorEmpty=${cursorEmpty})`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            }
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
            const movingWholeStack = (probed.count ?? "one") === "all";
            // Refuse swap: when count=all (whole-stack place into to=B)
            // and B is CV-detected as already filled (stddev > 35),
            // refuse the move. Placing on a filled slot triggers a
            // destructive item swap. Skip this guard for from==to
            // (legit auto-return to a slot we just emptied).
            const destPatch = (toSlot && fromSlot && fromSlot.name !== toSlot.name && movingWholeStack)
              ? samplePatchFingerprint(payload.obs, toSlot.cx, toSlot.cy, 12)
              : null;
            // Same-item stacking allowance: if the destination is
            // filled BUT its color signature matches what the cursor
            // is currently carrying (cursorItemSignature recorded at
            // last pickup), the click will STACK same-item piles in
            // MC -- not swap. Allow it.
            const sigDist = (destPatch && plan.cursorItemSignature)
              ? Math.hypot(
                  destPatch.meanR - plan.cursorItemSignature.meanR,
                  destPatch.meanG - plan.cursorItemSignature.meanG,
                  destPatch.meanB - plan.cursorItemSignature.meanB,
                )
              : null;
            const destSameItem = sigDist !== null && sigDist < 30;
            const destLooksFilled = !!destPatch && destPatch.stddev > 35 && !destSameItem;
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
              console.warn(`[agentbeats] move to=${probed.to}(${toSlot.name ?? "?"}) refused: destination looks FILLED (stddev=${destPatch!.stddev.toFixed(1)} > 35); place_all here would trigger an item swap. Reprobe`);
              state.closedLoopHistory.unshift(`refused move to=${probed.to}(${toSlot.name ?? "?"}) (destination already has an item; pick a visually empty slot)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
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
              const placedItemName = fromMem?.item;
              const mkClick = (s: { index: number; name?: string; role?: string; cx: number; cy: number }, button: "attack" | "use", expectAfter: "should_empty" | "should_fill", actionKind: "pickup" | "place_one" | "place_all" | "take", kind: "click" | "auto_return", placedItemName?: string): import("../tools/UiFastControl").PendingClick => ({
                rasterIndex: s.index, slotName: s.name, slotRole: s.role,
                frozenTarget: { x: s.cx, y: s.cy },
                button, shift: false, expectAfter,
                phase: "servo", retries: 0, kind, actionKind,
                ...(placedItemName ? { placedItemName } : {}),
              });
              const chain: import("../tools/UiFastControl").PendingClick[] = [];
              chain.push(mkClick(fromSlot, "attack", "should_empty", "pickup", "click"));
              if (probed.count === "all") {
                chain.push(mkClick(toSlot, "attack", "should_fill", "place_all", "click", placedItemName));
              } else {
                chain.push(mkClick(toSlot, "use", "should_fill", "place_one", "click", placedItemName));
                chain.push(mkClick(fromSlot, "attack", "should_fill", "place_all", "auto_return"));
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
            // holds an item (the held-item label is shown instead),
            // so OCR would return "empty" for every slot. Refuse the
            // batch and tell the agent to clear the cursor first.
            if (cursorHolding === true) {
              state.closedLoopHistory.unshift(`verify_slots refused: cursor is holding an item; clear cursor first`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
              console.warn(`[agentbeats] verify_slots refused: cursor is holding an item (CV); tooltips are suppressed`);
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
            } else if (probed.action === "pickup" && cursorHolding === true) {
              // Hard guard: cursor is already carrying an item, so a
              // "pickup" would actually swap stacks and corrupt state.
              // Skip this probe; next iteration the VLM will see the
              // updated cursor_holding=yes hint and choose place_all.
              console.warn(`[agentbeats] probe asked for pickup at slot ${probed.slot} but CV says cursor is HOLDING; refusing -- will reprobe`);
              state.closedLoopHistory.unshift(`refused pickup slot=${probed.slot} (cursor not empty)`);
              state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            } else if (probed.action === "take" && cursorHolding === true) {
              console.warn(`[agentbeats] probe asked for take at slot ${probed.slot} but CV says cursor is HOLDING; refusing -- will reprobe`);
              state.closedLoopHistory.unshift(`refused take slot=${probed.slot} (cursor not empty)`);
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
                  && cursorHolding !== false) {
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
              const expectAfter: "should_empty" | "should_fill" =
                (probed.action === "place_one" || probed.action === "place_all") ? "should_fill" : "should_empty";
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
        // Resolve current target slot pixel by semantic name (stable
        // across frames even when raster indices shift).
        const resolveSlot = (): { cx: number; cy: number } => {
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
          return { cx: pc.frozenTarget.x, cy: pc.frozenTarget.y };
        };
        const slotCenter = resolveSlot();

        // Safe spot to move cursor to for verification: somewhere
        // inside the inventory window away from the just-clicked slot.
        // Use a corner of the window opposite to the slot.
        const safeSpot = {
          x: slotCenter.cx > layout!.windowX + layout!.windowW / 2
            ? layout!.windowX + 8
            : layout!.windowX + layout!.windowW - 8,
          y: layout!.windowY + layout!.windowH - 8,
        };

        // Strict thresholds: looser values caused clicks to land 13-17
        // px off slot center (servo cap firing during overshoot
        // approach), missing MC's effective hit region. Strict 5 px
        // threshold + 10-frame stuck cap matches the run that
        // achieved sim_score=1.0.
        const SERVO_STEP_CAP = 10;
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
        const cursor = plan.cursor ?? null;

        // === Phase: servo === move cursor to slot, then click
        if (pc.phase === "servo") {
          const stepResult = servoCursorStep({
            cursor,
            target: { x: slotCenter.cx, y: slotCenter.cy },
            button: pc.button,
            shift: pc.shift,
            hitThresholdPx: HIT_THRESHOLD_PX,
          });
          plan.servoSteps += 1;
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
            const arrived = !!cursor && Math.hypot(cursor.x - slotCenter.cx, cursor.y - slotCenter.cy) < 3;
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
          // Require at least one servo step before allowing a click.
          // Inventory slots are ~18 px apart, and HIT_THRESHOLD_PX is
          // a few px. If the prior chain step left the cursor already
          // within hit threshold of the NEW target, servoCursorStep
          // would return click=true on the very first tick and fire
          // a click before the cursor was actually re-aimed for the
          // new slot -- which can land on a neighbor or fail to
          // register. Forcing a servo step ensures the cursor settles
          // freshly on the intended slot center.
          const shouldClickNow = plan.servoSteps > SERVO_STEP_CAP
            || (stepResult && stepResult.click && plan.servoSteps >= 1);
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
            pc.prePatch = samplePatchFingerprint(payload.obs, slotCenter.cx, slotCenter.cy) ?? undefined;
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
            console.log(`[agentbeats] click ${pc.slotName ?? pc.rasterIndex} (${pc.button}${pc.shift ? "+sneak" : ""}) prePatch.stddev=${pc.prePatch?.stddev.toFixed(1) ?? "?"}`);
            return emit(action);
          }
          if (stepResult) {
            console.log(
              `[agentbeats] servo step=${step} cursor=(${cursor?.x},${cursor?.y}) target=(${slotCenter.cx},${slotCenter.cy}) name=${pc.slotName ?? "?"} ${stepResult.reason}`,
            );
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

        // === Phase: verify === sample target slot patch, decide
        if (pc.phase === "verify") {
          const post = samplePatchFingerprint(payload.obs, slotCenter.cx, slotCenter.cy);
          if (!post) {
            console.warn(`[agentbeats] verify: could not sample patch; assuming success`);
            plan.pendingClick = null;
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          // Empty/filled determination using a stricter fingerprint:
          //   - Empty slot has mid-gray RGB mean (band ~120-160)
          //     AND low stddev (uniform). A pale item like nether
          //     quartz has stddev close to empty BUT its mean is
          //     much brighter (~190+) so the brightness check
          //     keeps it from being misclassified as empty.
          //   - Filled = high stddev OR mean outside the empty
          //     band (very bright OR very dark).
          //   - Cross-check against pre-click patch: a meaningful
          //     RGB-mean shift (>20) in the expected direction
          //     also confirms the transition.
          const lum = (post.meanR + post.meanG + post.meanB) / 3;
          const inEmptyBand = lum > 120 && lum < 160;
          const meanShift = pc.prePatch
            ? Math.sqrt(
                (post.meanR - pc.prePatch.meanR) ** 2
                + (post.meanG - pc.prePatch.meanG) ** 2
                + (post.meanB - pc.prePatch.meanB) ** 2,
              )
            : 0;
          const isEmpty = (post.stddev < 25 && inEmptyBand)
            || (pc.expectAfter === "should_empty" && meanShift > 20);
          const isFilled = post.stddev > 35
            || !inEmptyBand
            || (pc.expectAfter === "should_fill" && meanShift > 20);
          const matched = pc.expectAfter === "should_empty" ? isEmpty : isFilled;
          // A successful click mutated the slot's contents — the slot
          // memory entry (if any) for this absolute pos is now stale.
          // Forget it; the agent will re-discover via hover if needed.
          // A successful click mutated the slot. Invalidate the slot's
          // memory entry; subsequent perception will re-OCR if the
          // agent decides to verify_slots that slot. We do NOT
          // speculatively write the cursor's item into the
          // destination -- per the user's "perception only" rule,
          // memory only contains entries confirmed by OCR.
          // Do NOT invalidate slotMemory on matched click. The
          // per-probe disappear/appear scan handles state changes
          // from CV evidence -- if we invalidate here, the scan
          // never sees the "had item X, slot now empty" transition
          // and the appeared-item match (which depends on knowing
          // what disappeared) loses its identity link.
          console.log(
            `[agentbeats] verify ${pc.slotName ?? pc.rasterIndex}: post.stddev=${post.stddev.toFixed(1)} expect=${pc.expectAfter} -> ${matched ? "OK" : "MISMATCH"} (retry ${pc.retries}/${MAX_RETRIES})`,
          );
          if (deps.debugDir) {
            void deps.recordDebug("verify", {
              type: "verify",
              step,
              data: {
                slotName: pc.slotName, slotIndex: pc.rasterIndex,
                slotCenter: { cx: slotCenter.cx, cy: slotCenter.cy },
                expectAfter: pc.expectAfter,
                prePatch: pc.prePatch ? { meanR: pc.prePatch.meanR, meanG: pc.prePatch.meanG, meanB: pc.prePatch.meanB, stddev: pc.prePatch.stddev } : null,
                postPatch: { meanR: post.meanR, meanG: post.meanG, meanB: post.meanB, stddev: post.stddev },
                matched, retries: pc.retries,
                cursor: plan.cursor,
                actionKind: pc.actionKind, kind: pc.kind,
              },
            });
          }
          if (matched) {
            state.closedLoopHistory.unshift(`${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} OK`);
            state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
            // Record / clear cursorItemSignature based on this click:
            //   pickup OK  -> cursor now carries the item from the source slot.
            //                Capture the source's prePatch RGB as the signature.
            //   place_all OK (kind=click) -> cursor is now empty.
            //                Clear the signature.
            //   place_one OK -> cursor still carries (count-1) of same item.
            //                Keep signature.
            //   auto_return OK -> cursor empty. Clear.
            if (pc.actionKind === "pickup" && pc.prePatch) {
              plan.cursorItemSignature = {
                meanR: pc.prePatch.meanR,
                meanG: pc.prePatch.meanG,
                meanB: pc.prePatch.meanB,
              };
              console.log(`[agentbeats] cursorItemSignature set from pickup ${pc.slotName ?? pc.rasterIndex}: rgb=(${pc.prePatch.meanR.toFixed(0)},${pc.prePatch.meanG.toFixed(0)},${pc.prePatch.meanB.toFixed(0)})`);
            } else if (pc.actionKind === "place_all" || pc.kind === "auto_return") {
              plan.cursorItemSignature = null;
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
          // Mismatch path: CV said the click did not produce the
          // expected slot state. CV is fooled by rendering noise
          // around freshly-emptied slots and ambiguous icon variance.
          // On the FIRST mismatch only, ask the VLM for a second
          // opinion before burning a retry. If the VLM agrees the
          // expected state holds, accept as success and advance the
          // chain. (Cheap: at most one extra VLM call per click.)
          if (pc.retries === 0 && deps.apiKey) {
            try {
              const vlmOk = await vlmVerifySlotState({
                client: deps.client,
                model: deps.model,
                obsBase64: payload.obs,
                slot: { cx: slotCenter.cx, cy: slotCenter.cy, name: pc.slotName },
                expectAfter: pc.expectAfter,
                taskTarget: plan.taskText,
              });
              if (vlmOk === true) {
                console.log(`[agentbeats] VLM sub-verify says ${pc.expectAfter} HOLDS for ${pc.slotName ?? pc.rasterIndex} (CV was fooled, post.stddev=${post.stddev.toFixed(1)}); accepting as success`);
                state.closedLoopHistory.unshift(`${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} OK (VLM-verified)`);
                state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
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
            } catch (e) {
              console.warn(`[agentbeats] VLM sub-verify call failed: ${e instanceof Error ? e.message : String(e)}; falling through to retry`);
            }
          }
          if (pc.retries < MAX_RETRIES) {
            pc.retries += 1;
            pc.phase = "servo";
            plan.servoSteps = 0;
            console.log(`[agentbeats] RETRY click on ${pc.slotName ?? pc.rasterIndex} (attempt ${pc.retries + 1}/${MAX_RETRIES + 1})`);
            return { kind: "act", action: defaultMcuAction(), holdSteps: 1 };
          }
          // Retries exhausted (5 attempts total). Surface back to VLM
          // reasoning -- drop the rest of the chain too so the LLM
          // can replan from current observed state.
          const failureLabel = `${pc.actionKind ?? pc.kind ?? "click"} slot=${pc.rasterIndex}${pc.slotName ? `(${pc.slotName})` : ""} FAILED post.stddev=${post.stddev.toFixed(0)}`;
          state.closedLoopHistory.unshift(`${failureLabel} (chain aborted; ${plan.pendingChain.length} dropped)`);
          state.closedLoopHistory = state.closedLoopHistory.slice(0, 5);
          console.warn(`[agentbeats] ${failureLabel}; retries exhausted; clearing chain (${plan.pendingChain.length} dropped) and returning to VLM`);
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
