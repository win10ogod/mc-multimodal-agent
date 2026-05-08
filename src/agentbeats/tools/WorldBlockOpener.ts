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

type Direction = "left" | "right" | "up" | "down" | "centered" | "not_visible";

type InnerPhase = "align" | "settle" | "done";

const ALIGN_ITERATIONS = 16;
const NOT_VISIBLE_LIMIT = 4;
const CAMERA_STEP_DEG = 10;
const SCAN_YAW_DEG = 20;

const SYSTEM_PROMPT = `You are a Minecraft world-camera alignment helper.

You are shown a Minecraft first-person frame at 640x360. The crosshair is at the centre of the image. The user gives you a TARGET block id (snake_case, e.g. "crafting_table").

Decide where the named block sits relative to the crosshair and return ONE direction:
  "centered"     — the crosshair is on the target block face (or within ~1 block tolerance)
  "left"         — the target is in view but to the left of the crosshair
  "right"        — the target is in view but to the right of the crosshair
  "up"           — the target is in view but above the crosshair
  "down"         — the target is in view but below the crosshair
  "not_visible"  — the target block is not visible anywhere on screen

Output ONLY JSON: {"direction": "<one of the values above>"}.

NEVER guess based on inventory icons or HUD. Only the in-world block matters.`;

/** Focused "attention" agent: answers a single question — "what block is Steve
 *  facing right now (the block at the crosshair)?". Used as the AUTHORITY for
 *  whether the opener should emit use=1. The direction agent is for movement
 *  hints; the attention agent decides task completion. Splitting these two
 *  questions across separate VLM calls (each with a tighter prompt) cuts
 *  hallucination — when run together as one direction call, the model
 *  conflates "where is the block" with "is anything at the crosshair" and
 *  reports not_visible / wrong direction even when the block sits clearly
 *  under the crosshair. */
const ATTENTION_PROMPT = `You are a Minecraft block identifier.

Look at the first-person frame (640x360). A bold red+yellow CROSSHAIR (+) has been drawn at the EXACT image centre — that is what Steve is currently aiming at.

Your only job: identify the block whose face the crosshair sits on right now — i.e. the block Steve would interact with on a right-click.

Output ONLY JSON: {"facing_block": "<snake_case_id>"} or {"facing_block": "none"} if the crosshair points at sky / cloud / open air / inside the player's own body / a HUD element.

Rules:
- Be precise: "crafting_table", "cobblestone", "grass_block", "oak_log", "dirt", "obsidian" — exact MC ids in snake_case.
- If the crosshair is on a block but you genuinely cannot tell which kind: {"facing_block": "unknown"}.
- Ignore HUD overlays (achievement banners, advancement notifications, hotbar, chat). Look at the world geometry under the crosshair only.
- Do NOT report a block that's NEAR the crosshair if the crosshair is actually pointing somewhere else (e.g. above it at sky).`;

async function vlmAttention(
  deps: WorldBlockOpenerDeps,
  frameB64: string,
  frameExt: "png" | "jpg",
): Promise<string> {
  const mime = frameExt === "png" ? "image/png" : "image/jpeg";
  const url = `data:${mime};base64,${frameB64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  let raw = "";
  try {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      temperature: 0,
      max_completion_tokens: 32,
      messages: [
        { role: "system", content: ATTENTION_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "What block is Steve facing? Reply JSON only." },
            { type: "image_url", image_url: { url, detail: "high" } },
          ] as never,
        },
      ],
    });
    raw = resp.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    console.warn(`[world-block-opener] attention VLM call failed: ${e instanceof Error ? e.message : String(e)}`);
    return "unknown";
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const v = String(obj.facing_block ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    return v || "unknown";
  } catch {
    return "unknown";
  }
}

async function vlmDirection(
  deps: WorldBlockOpenerDeps,
  frameB64: string,
  frameExt: "png" | "jpg",
  target: string,
): Promise<Direction> {
  const mime = frameExt === "png" ? "image/png" : "image/jpeg";
  const url = `data:${mime};base64,${frameB64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  const userText = `Target block: ${target}. Where is it relative to the crosshair? Reply JSON only.`;
  let raw = "";
  try {
    const resp = await deps.client.chat.completions.create({
      model: deps.model,
      temperature: 0,
      max_completion_tokens: 32,
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
    return "not_visible";
  }
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const d = String(obj.direction ?? "").toLowerCase();
    if (d === "left" || d === "right" || d === "up" || d === "down" || d === "centered" || d === "not_visible") {
      return d as Direction;
    }
  } catch { /* fall through */ }
  return "not_visible";
}

function camAct(yaw: number, pitch: number): McuEnvAction {
  const a = defaultMcuAction();
  a.camera = [yaw, pitch];
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

    // Compute the augmented (with-crosshair) frame ONCE per step so:
    //   (a) the AttentionAgent and DirectionAgent see the SAME pixels;
    //   (b) the saved debug PNG is the EXACT image the model received.
    const augmented = (() => {
      try { return drawCrosshair(obsBase64); } catch { return null; }
    })();
    const frameB64 = augmented ?? obsBase64;
    const frameExt: "png" | "jpg" = augmented ? "png" : "jpg";

    // Two-tier VLM:
    //   1. AttentionAgent — focused: "what block is Steve facing?". This is
    //      the AUTHORITY for emitting use=1.
    //   2. DirectionAgent — for camera movement only when attention says
    //      it's not the target.
    const facingBlock = await vlmAttention(this.deps, frameB64, frameExt);
    this.alignIter += 1;
    console.log(
      `[world-block-opener] align iter=${this.alignIter} target=${this.target} facing=${facingBlock}`,
    );
    recordDebug(this.target, { phase: "attention", iter: this.alignIter, facingBlock }, frameB64, frameExt);

    if (facingBlock === this.target) {
      this.innerPhase = "settle";
      this.consecutiveNotVisible = 0;
      console.log(`[world-block-opener] FACING ${this.target} → use=1 (attention-confirmed)`);
      return { kind: "act", action: useAct(), holdSteps: 2 };
    }

    // Not facing the target yet — call direction agent for the next move.
    const direction = await vlmDirection(this.deps, frameB64, frameExt, this.target);
    console.log(
      `[world-block-opener] iter=${this.alignIter} direction=${direction} (facing was ${facingBlock}) not_visible_streak=${this.consecutiveNotVisible}`,
    );
    recordDebug(this.target, { phase: "direction", iter: this.alignIter, direction, facingBlock, consecutiveNotVisible: this.consecutiveNotVisible });

    if (direction === "not_visible") {
      this.consecutiveNotVisible += 1;
      if (this.consecutiveNotVisible >= NOT_VISIBLE_LIMIT) {
        console.log(`[world-block-opener] FAIL target_ui_not_in_view target=${this.target}`);
        return this.fail("target_ui_not_in_view");
      }
      return { kind: "act", action: camAct(SCAN_YAW_DEG, 0), holdSteps: 2 };
    }

    // direction in {left, right, up, down, centered} — reset streak.
    // If "centered" came back here, attention disagreed (block wasn't
    // recognized at the crosshair). Treat as a small re-aim — nudge down
    // since placed blocks usually sit slightly below the natural look.
    this.consecutiveNotVisible = 0;
    let yaw = 0;
    let pitch = 0;
    if (direction === "left") yaw = -CAMERA_STEP_DEG;
    else if (direction === "right") yaw = CAMERA_STEP_DEG;
    else if (direction === "up") pitch = -CAMERA_STEP_DEG;
    else if (direction === "down") pitch = CAMERA_STEP_DEG;
    else if (direction === "centered") pitch = CAMERA_STEP_DEG;
    return { kind: "act", action: camAct(yaw, pitch), holdSteps: 2 };
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
