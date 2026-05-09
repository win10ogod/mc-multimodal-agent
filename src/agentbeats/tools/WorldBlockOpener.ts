/**
 * VLM-guided alignment + right-click for world-block GUIs.
 *
 * Used when the GoalPlanner dispatches ui_inventory with gui_target=<block>
 * (e.g. "crafting_table") and the agent is currently in world view.
 * Expectation: the block has just been placed in front of the agent (by
 * the placing macro) and is visible somewhere on screen, but may not be
 * exactly under the crosshair.
 *
 * Per-step protocol (one MCU action returned per call):
 *
 *   align: send the current frame to a VLM with the target name. VLM
 *          returns {direction: left|right|up|down|centered|not_visible}.
 *          - centered     → emit use=1 to right-click the block
 *          - left/right   → emit yaw camera delta (negative=left)
 *          - up/down      → emit pitch camera delta (negative=up)
 *          - not_visible  → bump consecutiveNotVisible. If >= NOT_VISIBLE_LIMIT,
 *                           return FAIL(target_ui_not_in_view). Otherwise emit
 *                           a wide scan step (yaw +20°) to look around.
 *   use_emit: emit use=1 (returned in same step that VLM said centered).
 *   settle: 1 frame noop so the GUI render lands.
 *   done: caller takes over from here (frame should now show GUI open).
 *
 * Bounded loops: max ALIGN_ITERATIONS calls before failing. Camera step
 * is small enough (10°) to converge in a few iterations from typical
 * "block slightly off-centre" starting positions.
 */
import type OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultMcuAction, type McuEnvAction } from "../McuPrompt";
import { getDebugRecorder } from "./DebugRecorder";
import { drawCrosshair } from "./CrosshairOverlay";

export type WorldBlockOpenerDeps = {
  client: OpenAI;
  model: string;
};

export type WorldBlockOpenerAct = {
  kind: "act";
  action: McuEnvAction;
  holdSteps: number;
};

export type WorldBlockOpenerDone = { kind: "done" };

export type WorldBlockOpenerFail = {
  kind: "fail";
  reason: string;
  reportFields: Record<string, unknown>;
};

export type WorldBlockOpenerResult =
  | WorldBlockOpenerAct
  | WorldBlockOpenerDone
  | WorldBlockOpenerFail;

// (Legacy "Direction" type removed — alignment is now bbox-based via
// vlmBbox; see BboxResult below.)

type InnerPhase = "align" | "settle" | "done";

// Frame is 640x360; centre (crosshair) is at (320, 180).
const FRAME_W = 640;
const FRAME_H = 360;
const CROSSHAIR_X = 320;
const CROSSHAIR_Y = 180;
// Default MC FOV is ~70 deg horizontal at 16:9. Pixels per degree both
// axes when the rendered FOV is square-pixel-correct.
const DEG_PER_PX = 70 / FRAME_W;
// Per-tick camera delta is clipped to ±10 deg by the encoder. Anything
// larger gets truncated, so we deliberately cap requested deltas here
// to match that ceiling and emit successive frames if more rotation
// is needed.
const MAX_DELTA_PER_TICK_DEG = 10;
// Tolerance for "centred" — pixel offset from crosshair below which we
// assume use=1 will hit the target. ~60 px covers a 1-block face at
// ~3-block reach.
const CENTERED_TOLERANCE_PX = 60;
// Total alignment budget. With 320-px max offset and 10 deg/tick cap
// (~92 px/tick), worst-case alignment is ~4 ticks; budget of 12 gives
// headroom for VLM lag + scan-then-align.
const ALIGN_ITERATIONS = 16;
// Scan pattern when VLM reports not_visible.
//
// Fishbone scan: yaw is the "spine" (8 stops every 45 deg around
// the player), each stop emits a wide pitch sweep ("bone") covering
// ±50 deg from horizon and back, then yaw rotates to the next stop.
//
// Per-direction cycle (25 ticks):
//   ticks  0..4   pitch -10/tick  (up   — cumulative   0 → -50, look up 50 deg)
//   ticks  5..9   pitch +10/tick  (down — cumulative -50 →   0, back to horizon)
//   ticks 10..14  pitch +10/tick  (down — cumulative   0 → +50, look down 50 deg)
//   ticks 15..19  pitch -10/tick  (up   — cumulative +50 →   0, back to horizon)
//   ticks 20..24  yaw   +10/tick  (rotate +50 deg toward next direction)
//
// 25 ticks/direction × 8 directions = 200 ticks budget. Covers full
// 360 deg yaw × ±50 deg pitch with the camera always returning to
// horizon AT THE SAME yaw orientation (ticks 19) before rotating
// yaw, so each yaw stop gets a complete vertical sweep.
const CYCLE_LEN = 25;
const NUM_DIRECTIONS = 8;
const NOT_VISIBLE_LIMIT = CYCLE_LEN * NUM_DIRECTIONS;
const SCAN_DELTA_DEG = 10;

const SYSTEM_PROMPT = `You are a Minecraft block-localiser.

You are shown a Minecraft first-person frame at 640x360. A black "+" crosshair is drawn at the centre (pixel 320, 180). The user gives you a TARGET block id (snake_case, e.g. "crafting_table").

Find the named block IN THE WORLD (not on the hotbar / HUD / inventory icons). Pick the FIRST applicable response shape from the list below:

  1. {"bbox": [x, y, w, h]}    — pixel rectangle of the target block face. x ∈ [0, 639], y ∈ [0, 359]; w and h are the block face's width/height in pixels. Use this when you can clearly see the block AND can place a tight rectangle around it (precision is helpful but does not need to be exact — a rough bbox is much better than refusing).
  2. {"direction": "<side>"}    — when you can see the block but bbox coordinates would be a guess. <side> is one of: "centered" (on or very near the crosshair), "left", "right", "up", "down". Pick the direction the block sits relative to the crosshair.
  3. {"found": false}           — ONLY if the target is genuinely absent from the entire frame after careful scanning.

PREFER bbox over direction (more useful to the runtime), and PREFER direction over found:false. found:false is the LAST resort — almost-visible / corner-of-eye / partially-occluded counts as visible (return direction).

NEVER infer from icons in the hotbar/HUD; the player's inventory is irrelevant. Only the rendered 3D world matters.

Output strict JSON only — one of the three shapes above, no markdown fences.`;

type BboxResult =
  | { kind: "bbox"; cx: number; cy: number; w: number; h: number }
  | { kind: "not_visible" };

async function vlmBbox(
  deps: WorldBlockOpenerDeps,
  frameB64: string,
  frameExt: "png" | "jpg",
  target: string,
): Promise<BboxResult> {
  const mime = frameExt === "png" ? "image/png" : "image/jpeg";
  const url = `data:${mime};base64,${frameB64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  const userText = `Target block: ${target}. Find it in the rendered world (ignore the hotbar/HUD). Reply JSON only.`;
  let raw = "";
  try {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      temperature: 0,
      max_completion_tokens: 80,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url, detail: "high" } },
          ] as never,
        },
      ],
    });
    raw = resp.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    console.warn(`[world-block-opener] VLM call failed: ${e instanceof Error ? e.message : String(e)}`);
    return { kind: "not_visible" };
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    if (Array.isArray(obj.bbox) && obj.bbox.length >= 4) {
      const [x, y, w, h] = obj.bbox.map((v) => Number(v));
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        // Clamp + compute centre. The VLM occasionally over-shoots the
        // frame bounds; clamping keeps downstream pixel-offset math safe.
        const clampedX = Math.max(0, Math.min(FRAME_W - 1, x));
        const clampedY = Math.max(0, Math.min(FRAME_H - 1, y));
        const clampedW = Math.max(1, Math.min(FRAME_W - clampedX, w));
        const clampedH = Math.max(1, Math.min(FRAME_H - clampedY, h));
        return {
          kind: "bbox",
          cx: clampedX + clampedW / 2,
          cy: clampedY + clampedH / 2,
          w: clampedW,
          h: clampedH,
        };
      }
    }
    if (obj.found === false) return { kind: "not_visible" };
    // Direction fallback: when the model picks the coarse-direction
    // shape ({"direction":"<left|right|up|down|centered>"}), synthesise
    // a bbox at the canonical edge centre for that direction. The
    // alignment math then derives a camera delta from it like any
    // bbox — yields the same nudge per tick, just with less precision.
    // Better than refusing alignment when the model can see the
    // target but is unsure about exact pixels.
    const d = String(obj.direction ?? "").toLowerCase();
    const W = 32, H = 32; // synthetic block-face size for the offset math
    if (d === "centered") return { kind: "bbox", cx: CROSSHAIR_X, cy: CROSSHAIR_Y, w: W, h: H };
    if (d === "left")     return { kind: "bbox", cx: 50,  cy: CROSSHAIR_Y, w: W, h: H };
    if (d === "right")    return { kind: "bbox", cx: FRAME_W - 50, cy: CROSSHAIR_Y, w: W, h: H };
    if (d === "up")       return { kind: "bbox", cx: CROSSHAIR_X, cy: 30, w: W, h: H };
    if (d === "down")     return { kind: "bbox", cx: CROSSHAIR_X, cy: FRAME_H - 30, w: W, h: H };
    if (d === "not_visible") return { kind: "not_visible" };
  } catch {
    /* fall through */
  }
  // Unparseable response — treat as not_visible to escalate to scan.
  return { kind: "not_visible" };
}

// McuEnvAction.camera is [delta_pitch, delta_yaw] per the system prompt
// and the cameraX/cameraY split in toCompactMcuAgentActionPayload —
// camera[0] is pitch (positive = look DOWN), camera[1] is yaw (positive
// = turn RIGHT). Earlier this helper stored [yaw, pitch], which made
// every "yaw right" alignment emit as "pitch down" — the camera
// progressively tilted at the floor while the VLM kept reporting
// the target was still to the right (because the table was now
// off-screen above-right of the crosshair). Same bug pattern as the
// historical Placing.camAction defect.
function camAct(pitch: number, yaw: number): McuEnvAction {
  const a = defaultMcuAction();
  a.camera = [pitch, yaw];
  return a;
}

function useAct(): McuEnvAction {
  const a = defaultMcuAction();
  a.use = 1;
  return a;
}

function noop(): McuEnvAction {
  return defaultMcuAction();
}

function recordDebug(target: string, payload: Record<string, unknown>, frameB64?: string, frameExt: "png" | "jpg" = "jpg"): void {
  const dbg = getDebugRecorder();
  if (!dbg.isEnabled()) return;
  if (frameB64) {
    dbg.record(
      { type: "world_block_opener", data: { target, ...payload } },
      frameB64,
      frameExt,
    );
    return;
  }
  // Phase log without an image still goes through the recorder so seq is
  // globally monotonic with all other events.
  dbg.record({ type: "world_block_opener_step", data: { target, ...payload } });
}

export class WorldBlockOpener {
  private readonly target: string;
  private readonly deps: WorldBlockOpenerDeps;
  private innerPhase: InnerPhase = "align";
  private alignIter = 0;
  private consecutiveNotVisible = 0;

  constructor(opts: { target: string; deps: WorldBlockOpenerDeps }) {
    this.target = opts.target;
    this.deps = opts.deps;
  }

  async nextAction(obsBase64: string): Promise<WorldBlockOpenerResult> {
    if (this.innerPhase === "settle") {
      this.innerPhase = "done";
      console.log(`[world-block-opener] settle → done target=${this.target}`);
      return { kind: "done" };
    }

    if (this.innerPhase === "done") {
      return { kind: "done" };
    }

    // align phase
    if (this.alignIter >= ALIGN_ITERATIONS) {
      console.log(`[world-block-opener] FAIL exhausted align iterations target=${this.target}`);
      return this.fail("align_exhausted");
    }

    // Compute the augmented (with-crosshair) frame ONCE per step so the VLM
    // and the saved debug PNG share the EXACT pixels the model received.
    const augmented = (() => {
      try { return drawCrosshair(obsBase64); } catch { return null; }
    })();
    const frameB64 = augmented ?? obsBase64;
    const frameExt: "png" | "jpg" = augmented ? "png" : "jpg";

    const result = await vlmBbox(this.deps, frameB64, frameExt, this.target);
    this.alignIter += 1;

    if (result.kind === "not_visible") {
      this.consecutiveNotVisible += 1;
      console.log(
        `[world-block-opener] align iter=${this.alignIter} target=${this.target} not_visible_streak=${this.consecutiveNotVisible}`,
      );
      recordDebug(
        this.target,
        { phase: "align", iter: this.alignIter, direction: "not_visible", consecutiveNotVisible: this.consecutiveNotVisible },
        frameB64,
        frameExt,
      );
      if (this.consecutiveNotVisible >= NOT_VISIBLE_LIMIT) {
        console.log(`[world-block-opener] FAIL target_ui_not_in_view target=${this.target}`);
        return this.fail("target_ui_not_in_view");
      }
      // Fishbone scan: yaw is the spine (8 stops every 45 deg around
      // the player). At each yaw stop, do a full ±50 deg pitch sweep
      // (4 legs of 5 ticks each: up, down, down, up — net 0) so the
      // camera returns to horizon at the same yaw orientation before
      // rotating to the next direction. Counter increments BEFORE
      // phase compute, so subtract 1 to make the first call land on
      // phase 0 (the first up-tick).
      const phase = (this.consecutiveNotVisible - 1) % CYCLE_LEN;
      let pitchDelta = 0;
      let yawDelta = 0;
      if      (phase < 5)        pitchDelta = -SCAN_DELTA_DEG; // up:    0 → -50
      else if (phase < 10)       pitchDelta = +SCAN_DELTA_DEG; // down: -50 →   0
      else if (phase < 15)       pitchDelta = +SCAN_DELTA_DEG; // down:   0 → +50
      else if (phase < 20)       pitchDelta = -SCAN_DELTA_DEG; // up:   +50 →   0
      else                       yawDelta   = +SCAN_DELTA_DEG; // yaw: rotate +50 deg next dir
      return { kind: "act", action: camAct(pitchDelta, yawDelta), holdSteps: 2 };
    }

    // Bbox returned — compute pixel offset from crosshair, convert to
    // camera deltas. Target visible: reset the not_visible streak.
    this.consecutiveNotVisible = 0;
    const dx = result.cx - CROSSHAIR_X;
    const dy = result.cy - CROSSHAIR_Y;
    const offsetPx = Math.hypot(dx, dy);
    console.log(
      `[world-block-opener] align iter=${this.alignIter} target=${this.target} bbox_centre=(${Math.round(result.cx)},${Math.round(result.cy)}) offset=${Math.round(offsetPx)}px`,
    );
    recordDebug(
      this.target,
      {
        phase: "align",
        iter: this.alignIter,
        direction: "bbox",
        bbox: { cx: result.cx, cy: result.cy, w: result.w, h: result.h },
        offsetPx,
      },
      frameB64,
      frameExt,
    );

    if (offsetPx <= CENTERED_TOLERANCE_PX) {
      this.innerPhase = "settle";
      console.log(`[world-block-opener] CENTERED (offset=${Math.round(offsetPx)}px) → use=1 target=${this.target}`);
      return { kind: "act", action: useAct(), holdSteps: 2 };
    }

    // Convert pixel offsets to per-tick camera deltas, clipped to the
    // encoder's ±10 deg/tick budget. Sign convention: positive dx
    // (target right of crosshair) → positive yaw (turn right);
    // positive dy (target below crosshair) → positive pitch (look
    // down). Both match the engine's [delta_pitch, delta_yaw]
    // convention enforced by camAct.
    const yawRaw = dx * DEG_PER_PX;
    const pitchRaw = dy * DEG_PER_PX;
    const yaw = Math.max(-MAX_DELTA_PER_TICK_DEG, Math.min(MAX_DELTA_PER_TICK_DEG, yawRaw));
    const pitch = Math.max(-MAX_DELTA_PER_TICK_DEG, Math.min(MAX_DELTA_PER_TICK_DEG, pitchRaw));
    return { kind: "act", action: camAct(pitch, yaw), holdSteps: 2 };
  }

  private fail(code: "target_ui_not_in_view" | "align_exhausted"): WorldBlockOpenerFail {
    return {
      kind: "fail",
      reason: `${code}: ${this.target}`,
      reportFields: {
        code,
        target: this.target,
        alignIter: this.alignIter,
        consecutiveNotVisible: this.consecutiveNotVisible,
      },
    };
  }
}

// Tiny module-internal noop helper used by future settle phases that emit a
// noop action (currently inlined in nextAction; exported here so the helper
// can be reused if we add a multi-frame settle later).
export function _noop(): McuEnvAction {
  return noop();
}
