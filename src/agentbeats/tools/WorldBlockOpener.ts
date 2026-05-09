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
// Scan budget when the VLM reports the target is not visible.
//
// Per-tick camera delta is clipped to ±10 deg by the encoder. The
// world-subagent path does NOT honour SubAgentStep.holdSteps for
// caching either — each obs calls subagent.step() afresh, so even
// requesting yaw=20 with holdSteps=2 effectively yields ONE +10 deg
// tick per WBO call. To cover a full 360 deg sweep we need 36 calls.
//
// (Earlier bound of 4 only covered ~40 deg, guaranteed miss for any
// target outside the front-right cone of the player's spawn
// orientation. The enchant_diamond_sword task spawns the table at
// +X = east of a south-facing spawn, ~90 deg to the player's left,
// completely outside that cone.)
const NOT_VISIBLE_LIMIT = 36;
const SCAN_YAW_DEG = 10;

const SYSTEM_PROMPT = `You are a Minecraft block-localiser.

You are shown a Minecraft first-person frame at 640x360. A black "+" crosshair is drawn at the centre (pixel 320, 180). The user gives you a TARGET block id (snake_case, e.g. "crafting_table").

Find the named block IN THE WORLD (not on the hotbar / HUD / inventory icons). Return either its pixel-space bounding box, or "not_visible" if you genuinely cannot find it after a careful look at the entire frame (including edges).

Output strict JSON, ONE of these two shapes only:
  {"bbox": [x, y, w, h]}    — pixel rectangle of the target block face. x ∈ [0, 639], y ∈ [0, 359]; w and h are the block face's width/height in pixels.
  {"found": false}          — target is genuinely not in the frame.

NEVER infer from icons in the hotbar/HUD; the player's inventory is irrelevant. Only the rendered 3D world matters.`;

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
    // Backwards-compat: if the model returns the old direction-only
    // shape (e.g. {"direction":"centered"}), treat anything but
    // not_visible as a centred no-op nudge — caller will re-check next
    // tick. Better than failing the whole alignment over a stale
    // schema slip.
    const d = String(obj.direction ?? "").toLowerCase();
    if (d === "centered") return { kind: "bbox", cx: CROSSHAIR_X, cy: CROSSHAIR_Y, w: 32, h: 32 };
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
      // Monotonic rightward scan. With SCAN_YAW_DEG=20 and a budget
      // of NOT_VISIBLE_LIMIT=18, this sweeps a full 360 deg before
      // bailing. An earlier "alternating" version (+20, -20, +20…) had
      // net rotation ≈ 0 per pair — agent oscillated between two
      // neighbouring orientations and never explored further. The
      // monotonic sweep is guaranteed to face every direction at some
      // point during the budget, regardless of where the target sits
      // relative to spawn orientation.
      return { kind: "act", action: camAct(0, SCAN_YAW_DEG), holdSteps: 2 };
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
