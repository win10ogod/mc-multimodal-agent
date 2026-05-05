/**
 * Inline crafting macro for the LLM-direct McuPolicy path.
 *
 * The MCU benchmark gives crafting tasks pre-given ingredients in inventory
 * (via /give in the YAML's custom_init_commands). The LLM-only path can move
 * the cursor with camera deltas but lacks reliable spatial grounding to land
 * on specific slots, so it usually grabs the wrong item.
 *
 * This macro pre-empts the LLM for the first ~N obs steps of a crafting task
 * and emits a deterministic sequence of MCU env actions:
 *   open inventory -> cursor to ingredient slot -> attack (pick up)
 *   -> cursor to craft grid -> use (place) -> cursor to result -> attack (take)
 *
 * It is recipe-driven via minecraft-data (works for any vanilla 2x2 recipe),
 * and the slot pixel positions are derived from a fixed table for the
 * benchmark's 640x360 obs resolution. No task-name-based hardcoding.
 */
import minecraftData from "minecraft-data";
import { SlotMemory } from "./SlotMemory";
import { defaultMcuAction, type McuEnvAction } from "../McuPrompt";
import type { ChecklistItem } from "../agents/subagents/fastUi/types";
import type { GuiLayout } from "./SlotDetector";

export type UiFastControlFrame = {
  action: McuEnvAction;
  holdSteps: number;
  label: string;
  /** When set, this frame is a sentinel that asks the policy to run a probe
   *  before continuing. The action emitted is a noop; the policy uses the
   *  probe result to build the next macro phase and append it to the queue. */
  probe?: ProbeRequest;
};

export type ProbeRequest = {
  kind: "hotbar";
  /** Item names to look for; the VLM returns slot indices for those it sees. */
  candidates: string[];
  /** Recipe context passed back to buildPostProbeMacro after the probe. */
  recipeTarget: string;
};

// --- Calibration constants (640x360 obs, MC GUI scale auto) ---------------

// Empirical K is non-linear with magnitude in GUI mode. Tested K=6 (som8)
// and it regressed to 1.50 because cursor undershoots on short moves. K=4
// (som7) scored 4.00 with very high criterion scores -- best so far. Until
// we add CV cursor verification, stick with K=4.
// MC sim's cam->cursor response is HIGHLY non-linear: at large cmds (cam=10)
// K_pitch ~= 6.7, K_yaw ~= 3.7; at small cmds (cam=2-4) K drops to ~2.0-2.75.
// Tuning a single linear K is a compromise. som7/som11 ran K_yaw=8.5,
// K_pitch=5.0 with deadzone=4 and converged stably at "stuck err ~5-8 px".
// Earlier this session I tried K_yaw=3.5, K_pitch=6.5 hoping to fix the
// stall but it didn't help (same floor) and regressed elsewhere. Reverting.
const PX_PER_CAM_YAW = 8.5;
const PX_PER_CAM_PITCH = 5.0;
const PITCH_DEADZONE_MIN = 4;        // smallest pitch cmd that still produces visible cursor motion in the sim
const CAM_BIN_DEG = 2;
const MAX_CAM_DEG = 10;

// Slot pixel centers when inventory GUI is open at 640x360 obs.
// Measured from recorded eval frame_006 where the visible hotbar items
// (oak_log + crafting_table + apple) sit at y~215, not y~250.
const CURSOR_OPEN_CENTER = { x: 320, y: 180 };

// Slot pixel centers measured from a real 640x360 obs frame using a CV
// analyzer (local_tests/measure_slots.py). Inventory window top-left at
// (232, 97) at GUI scale 1; slots are 16x16 with 18px stride. These match
// vanilla Minecraft inventory logical layout exactly:
//   2x2 craft TL logical (98,18) -> screen (338, 123)
//   result    logical (154,28) -> screen (394, 133)
//   main inv  logical (8, 84/102/120) -> screen rows 189/207/225
//   hotbar    logical (8, 142) -> screen row 247
//   slot 0 X  logical 8 -> screen 247 (i.e. window_left + 8 + 8/2 = 232+16)
// Fallback static layout used only when CV detection (SlotDetector) cannot
// find the inventory window. Values measured for a 640x360 obs frame at
// vanilla GUI scale 1, window top-left (232, 97), 18px slot stride.
const SLOT = {
  craft2x2: [
    { x: 338, y: 123 },
    { x: 356, y: 123 },
    { x: 338, y: 141 },
    { x: 356, y: 141 },
  ],
  craft2x2Result: { x: 394, y: 133 },
  hotbarY: 247,
  hotbarX0: 250,
  hotbarDx: 18,
  mainInvRows: [189, 207, 225],
  mainInvX0: 250,
  mainInvDx: 18,
};

function hotbarSlot(idx: number): { x: number; y: number } {
  return { x: SLOT.hotbarX0 + idx * SLOT.hotbarDx, y: SLOT.hotbarY };
}

function mainInventorySlot(idx: number): { x: number; y: number } {
  // 27 slots in 3 rows of 9. idx 0..8 = row 1, 9..17 = row 2, 18..26 = row 3.
  const row = Math.floor(idx / 9);
  const col = idx % 9;
  return { x: SLOT.mainInvX0 + col * SLOT.mainInvDx, y: SLOT.mainInvRows[row] };
}

/** Resolve a slot index to its on-screen pixel center.
 *  When a `GuiLayout` from the unified detector is supplied, indices are
 *  the raster order from that detection (0..N-1) — this is the canonical
 *  path. Without a layout we fall back to the static 0..40 mapping for
 *  the common player-inventory GUI (legacy / smoke-test usage). */
export function slotIndexToPixel(slotIndex: number, layout?: GuiLayout | null): { x: number; y: number } | null {
  if (layout) {
    const s = layout.slots[slotIndex];
    return s ? { x: s.cx, y: s.cy } : null;
  }
  if (slotIndex >= 0 && slotIndex <= 8) return hotbarSlot(slotIndex);
  if (slotIndex >= 9 && slotIndex <= 35) return mainInventorySlot(slotIndex - 9);
  if (slotIndex >= 36 && slotIndex <= 39) return SLOT.craft2x2[slotIndex - 36];
  if (slotIndex === 40) return SLOT.craft2x2Result;
  return null;
}

function quantizeCam(deg: number): number {
  const clamped = Math.max(-MAX_CAM_DEG, Math.min(MAX_CAM_DEG, deg));
  return Math.round(clamped / CAM_BIN_DEG) * CAM_BIN_DEG;
}

/**
 * Decompose a pixel cursor move into a sequence of camera-only frames,
 * each within +-MAX_CAM_DEG and snapped to the 2-deg bin grid.
 */
function compileCursorMove(
  from: { x: number; y: number },
  to: { x: number; y: number },
): McuEnvAction[] {
  const dxPx = to.x - from.x;
  const dyPx = to.y - from.y;
  let yawLeft = dxPx / PX_PER_CAM_YAW;
  let pitchLeft = dyPx / PX_PER_CAM_PITCH;
  const frames: McuEnvAction[] = [];
  for (let safety = 0; safety < 12; safety += 1) {
    let dy = 0;
    let dp = 0;

    // Yaw: emit MAX while far, then quantize once when close.
    if (Math.abs(yawLeft) >= MAX_CAM_DEG) {
      dy = Math.sign(yawLeft) * MAX_CAM_DEG;
    } else if (Math.abs(yawLeft) >= 1) {
      dy = quantizeCam(yawLeft);
    }

    // Pitch: emit MAX while far. When close, only emit if remaining error
    // exceeds half the deadzone threshold; in that case, boost to the full
    // deadzone (smallest pitch magnitude that actually moves cursor in GUI
    // mode). After a boost-step we accept the residual error to avoid
    // oscillation around the target.
    if (Math.abs(pitchLeft) >= MAX_CAM_DEG) {
      dp = Math.sign(pitchLeft) * MAX_CAM_DEG;
    } else if (Math.abs(pitchLeft) >= PITCH_DEADZONE_MIN / 2) {
      const quant = quantizeCam(pitchLeft);
      dp = Math.abs(quant) < PITCH_DEADZONE_MIN
        ? Math.sign(quant || pitchLeft) * PITCH_DEADZONE_MIN
        : quant;
    }

    if (dy === 0 && dp === 0) break;
    const action = defaultMcuAction();
    action.camera = [dp, dy];
    frames.push(action);
    yawLeft -= dy;
    pitchLeft -= dp;

    // If the boost-step left us inside the deadzone with opposite sign,
    // accept the residual rather than oscillating.
    if (Math.abs(pitchLeft) < PITCH_DEADZONE_MIN / 2) pitchLeft = 0;
    if (Math.abs(yawLeft) < 1) yawLeft = 0;
  }
  return frames;
}

// --- Task-text -> recipe lookup ------------------------------------------

const TARGET_PATTERNS: RegExp[] = [
  /craft(?:\s+(?:a|the|to|some|an))?\s+([a-z][a-z_\s]+?)(?:\s+(?:from|using|with|for)\b|\.|$)/i,
  /craft\s+([a-z][a-z_\s]+)/i,
];

function normalizeItemName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\bplanks\b/g, "planks")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export function parseTargetItem(taskText: string): string | null {
  for (const re of TARGET_PATTERNS) {
    const m = taskText.match(re);
    if (m && m[1]) {
      const candidate = normalizeItemName(m[1]);
      if (candidate.length > 0) return candidate;
    }
  }
  return null;
}

type RecipeIngredient = { name: string; count: number };
export type RecipeInfo = {
  target: string;
  ingredients: RecipeIngredient[];
  requiresTable: boolean;
  /** When non-null, the recipe is SHAPED -- each cell is identified by
   *  ingredient name (or null for empty). Row-major. Caller can map this
   *  to the craft grid's raster slots to emit a position-correct plan.
   *  When null, the recipe is shapeless and any cell arrangement works. */
  inShape: Array<Array<string | null>> | null;
};

export function lookupRecipe(target: string, version = "1.20.4"): RecipeInfo | null {
  let data: ReturnType<typeof minecraftData>;
  try {
    data = minecraftData(version);
  } catch {
    return null;
  }
  // Try direct, then with common item-name aliases for tasks like "oak planks"
  const candidates = [target];
  if (target === "the_crafting_table") candidates.push("crafting_table");
  if (target.endsWith("s") && !target.endsWith("ss")) candidates.push(target.slice(0, -1));
  let item: (typeof data.itemsByName)[string] | undefined;
  let resolvedName = target;
  for (const cand of candidates) {
    const found = data.itemsByName[cand];
    if (found) {
      item = found;
      resolvedName = cand;
      break;
    }
  }
  if (!item) return null;
  // minecraft-data exposes recipes as { [itemId]: Recipe[] | undefined }
  const recipesByItem = (data as unknown as { recipes: Record<string, unknown[]> }).recipes;
  const list = recipesByItem?.[String(item.id)] as
    | Array<{
        result?: { id: number; count?: number };
        ingredients?: Array<number | null>;
        inShape?: Array<Array<number | null>>;
        requiresTable?: boolean;
      }>
    | undefined;
  if (!list || list.length === 0) return null;
  const recipe = list[0];
  // Flatten ingredients
  const flat: number[] = [];
  if (recipe.ingredients) {
    for (const id of recipe.ingredients) {
      if (typeof id === "number" && id > 0) flat.push(id);
    }
  } else if (recipe.inShape) {
    for (const row of recipe.inShape) {
      for (const id of row) {
        if (typeof id === "number" && id > 0) flat.push(id);
      }
    }
  }
  const counts = new Map<number, number>();
  for (const id of flat) counts.set(id, (counts.get(id) ?? 0) + 1);
  const ingredients: RecipeIngredient[] = [];
  for (const [id, count] of counts) {
    const def = data.items[id];
    if (def) ingredients.push({ name: def.name, count });
  }
  // Build inShape with item-name strings for shaped recipes; null for
  // shapeless. Caller maps row/col to raster craft-grid cells.
  let inShape: Array<Array<string | null>> | null = null;
  if (recipe.inShape) {
    inShape = recipe.inShape.map((row) => row.map((id) => {
      if (typeof id !== "number" || id <= 0) return null;
      const def = data.items[id];
      return def ? def.name : null;
    }));
  }
  return {
    target: resolvedName,
    ingredients,
    requiresTable: !!recipe.requiresTable,
    inShape,
  };
}

// --- Macro builders ------------------------------------------------------

/**
 * 2x2 player-grid macro: one ingredient placed in the top-left of the 2x2,
 * then take the result. Works for vanilla 4-output recipes like
 * oak_planks, birch_planks, diorite (via stonecutter is different but the
 * shapeless 2x2 recipes that use 1 ingredient also work).
 *
 * For recipes that need multiple slots filled, this only places one item
 * which won't form the recipe -- that case requires the multi-ingredient
 * macro (TODO).
 */
function buildSingleSlot2x2Macro(
  ingredientHotbarSlot: number,
  label: string,
  options: { assumeInventoryOpen?: boolean } = {},
): UiFastControlFrame[] {
  const frames: UiFastControlFrame[] = [];
  const push = (action: McuEnvAction, holdSteps: number, frameLabel: string) =>
    frames.push({ action, holdSteps, label: `${label}:${frameLabel}` });

  if (!options.assumeInventoryOpen) {
    // 1. Open inventory
    const openAct = defaultMcuAction();
    openAct.inventory = 1;
    push(openAct, 1, "open_inv");

    // 2. Settle so the GUI fully renders before issuing camera deltas
    push(defaultMcuAction(), 4, "settle_after_open");
  }

  // 3. Cursor: center -> ingredient slot
  let cursor = CURSOR_OPEN_CENTER;
  const ingTarget = hotbarSlot(ingredientHotbarSlot);
  for (const cam of compileCursorMove(cursor, ingTarget)) {
    push(cam, 1, "move_to_ingredient");
  }
  cursor = ingTarget;
  push(defaultMcuAction(), 1, "settle");

  // 4. Pick up the entire stack with attack (left click)
  const pickAct = defaultMcuAction();
  pickAct.attack = 1;
  push(pickAct, 1, "pickup_stack");
  push(defaultMcuAction(), 2, "settle_after_pickup");

  // 5. Cursor: ingredient slot -> 2x2 craft top-left
  for (const cam of compileCursorMove(cursor, SLOT.craft2x2[0])) {
    push(cam, 1, "move_to_craft_tl");
  }
  cursor = SLOT.craft2x2[0];
  push(defaultMcuAction(), 1, "settle");

  // 6. Place one item with use (right click)
  const placeAct = defaultMcuAction();
  placeAct.use = 1;
  push(placeAct, 1, "place_one");
  push(defaultMcuAction(), 3, "settle_after_place");

  // 7. Put the rest of the stack back on the ingredient slot so we don't
  //    drop it when closing inventory (closing with a held stack throws it).
  for (const cam of compileCursorMove(cursor, ingTarget)) {
    push(cam, 1, "move_back_to_ingredient");
  }
  cursor = ingTarget;
  push(defaultMcuAction(), 1, "settle");
  const dropBackAct = defaultMcuAction();
  dropBackAct.attack = 1;
  push(dropBackAct, 1, "drop_back_stack");
  push(defaultMcuAction(), 2, "settle");

  // 8. Cursor: ingredient -> result slot
  for (const cam of compileCursorMove(cursor, SLOT.craft2x2Result)) {
    push(cam, 1, "move_to_result");
  }
  cursor = SLOT.craft2x2Result;
  push(defaultMcuAction(), 1, "settle");

  // 9. Take result with attack
  const takeAct = defaultMcuAction();
  takeAct.attack = 1;
  push(takeAct, 1, "take_result");
  push(defaultMcuAction(), 4, "settle_after_take");

  return frames;
}

/**
 * Closed-loop helper: build the cursor-move + click frames to perform one
 * VLM-probed action against the inventory. Caller tracks current cursor
 * position and updates it after this returns.
 *
 * `mouseButton`: "attack" for left-click (pickup whole stack / take),
 *                "use"    for right-click (place ONE item).
 */
export function buildClosedLoopActionFrames(opts: {
  fromCursor: { x: number; y: number };
  toSlot: number;
  mouseButton: "attack" | "use";
  label: string;
  layout?: GuiLayout | null;
}): { frames: UiFastControlFrame[]; newCursor: { x: number; y: number } } {
  const target = slotIndexToPixel(opts.toSlot, opts.layout ?? null);
  if (!target) return { frames: [], newCursor: opts.fromCursor };
  const out: UiFastControlFrame[] = [];
  const baseLabel = opts.label;

  // Cursor moves
  for (const cam of compileCursorMove(opts.fromCursor, target)) {
    out.push({ action: cam, holdSteps: 1, label: `${baseLabel}:move` });
  }
  // Settle one frame so the GUI registers the cursor position
  out.push({ action: defaultMcuAction(), holdSteps: 1, label: `${baseLabel}:settle` });
  // The click
  const clickAct = defaultMcuAction();
  clickAct[opts.mouseButton] = 1;
  out.push({ action: clickAct, holdSteps: 1, label: `${baseLabel}:${opts.mouseButton}` });
  // Settle a few frames so the next probe sees a stable post-click state
  out.push({ action: defaultMcuAction(), holdSteps: 3, label: `${baseLabel}:settle_post` });

  return { frames: out, newCursor: target };
}

/** Minimal start frames for closed-loop crafting: just open inventory + settle.
 *  The McuPolicy then drives a probe-action-probe loop until "done". */
export function buildCraftOpenInventoryFrames(target: string): UiFastControlFrame[] {
  const label = `craft_${target}`;
  const frames: UiFastControlFrame[] = [];
  const push = (action: McuEnvAction, holdSteps: number, frameLabel: string) =>
    frames.push({ action, holdSteps, label: `${label}:${frameLabel}` });
  const openAct = defaultMcuAction();
  openAct.inventory = 1;
  push(openAct, 1, "open_inv");
  push(defaultMcuAction(), 4, "settle_after_open");
  return frames;
}

/** Plan for the closed-loop driver living in McuPolicy state. */
/** A single low-level click step the closed-loop state machine drives. */
export type PendingClick = {
  rasterIndex: number;
  slotName?: string;
  slotRole?: string;
  frozenTarget: { x: number; y: number };
  button: "attack" | "use";
  shift?: boolean;
  /** Verification post-click. */
  expectAfter: "should_empty" | "should_fill";
  /** State machine phase for this click:
   *   "servo"      — moving cursor toward target slot
   *   "fired"      — click was just emitted, waiting one frame to settle
   *   "moveAway"   — moving cursor off the slot to a safe spot
   *   "verify"     — at safe spot; sample patch and decide
   *   (cleared on success/abort) */
  phase: "servo" | "fired" | "moveAway" | "verify";
  /** Pre-click patch fingerprint of the target slot. */
  prePatch?: { meanR: number; meanG: number; meanB: number; stddev: number };
  /** How many times this click has been retried after verification failure. */
  retries: number;
  /** Kind of click for logging + cleanup-loop guard. */
  kind?: "click" | "cleanup" | "auto_return";
  /** Probe action this click was derived from. */
  actionKind?: "pickup" | "place_one" | "place_all" | "take";
  /** Item name to record at this click's slot on a CV-matched verify
   *  for place_one/place_all clicks. Set at chain-build time from the
   *  source slot's SlotMemory entry. The CV-matched verify is the
   *  evidence the slot really got the item; the source-slot lookup
   *  supplies the identity. */
  placedItemName?: string;
};

export type ClosedLoopCraftPlan = {
  /** Raw task text. Passed straight to the probe so it can reason over
   *  any UI for any task without us teaching the tool what crafting /
   *  smelting / chest / villager / etc. mean. */
  taskText: string;
  cursor: { x: number; y: number };
  iteration: number;
  done: boolean;
  /** Cap the number of probe iterations so a confused VLM can't loop forever. */
  maxIterations: number;
  /** Layout id locked at first successful detection in this UI session.
   *  Reset when the inventory window is no longer visible. */
  layoutHint: string | null;
  /** Full GuiLayout snapshot captured at session start. Reused for slot
   *  lookups so raster indices and slot positions stay stable for the
   *  duration of one UI session. Reset on window-not-detected. Stored
   *  as `unknown` to avoid a circular import; cast at use site. */
  sessionLayout: unknown | null;
  /** Pending click target — when set, the policy is servoing the cursor to
   *  this slot. Cleared once the click fires. */
  pendingClick: PendingClick | null;
  /** Awaiting click verification: when set, the click was JUST emitted on
   *  the previous frame and we're checking whether the slot state changed
   *  in the expected direction. Cleared after one verification pass. */
  awaitingVerify: {
    slotName?: string;
    slotRole?: string;
    rasterIndex: number;
    frozenTarget: { x: number; y: number };
    expectAfter: "should_empty" | "should_fill";
    prePatch: { meanR: number; meanG: number; meanB: number; stddev: number };
  } | null;
  /** How many servo steps we've spent on the current pendingClick. Capped
   *  so a misbehaving cursor (or detection failure) doesn't deadlock. */
  servoSteps: number;
  /** Slot from which the agent first picked up the ingredient stack. Used
   *  to instruct the VLM to return leftover items here after place_one. */
  pickupSourceSlot: { index: number; name?: string } | null;
  /** RGB signature of the item currently being carried by the cursor.
   *  Captured from the prePatch of the most recent successful pickup
   *  (when the source slot was filled, before the click emptied it).
   *  Used by the swap guard so place_all onto a slot containing the
   *  SAME item is allowed (will stack in MC) instead of refused. */
  cursorItemSignature: { meanR: number; meanG: number; meanB: number } | null;
  /** Queued follow-up clicks that should fire after the current pendingClick
   *  verifies successfully. Used to expand a single high-level VLM action
   *  (move, put) into a sequence of low-level clicks the existing state
   *  machine can execute. Each entry is a PendingClick value (sans phase
   *  and retries -- those are reset when promoted to current). */
  pendingChain: PendingClick[];
  /** Cursor reading from the previous obs frame, used to detect stale
   *  cursor detections (the white-blob detector sometimes latches onto a
   *  static GUI feature like a slot highlight or item icon). */
  lastCursorRead: { x: number; y: number } | null;
  /** Cam delta we emitted on the previous obs frame. If this was non-zero
   *  and the new cursor reading is identical, the detector is stale. */
  lastEmittedCam: [number, number];
  /** How many consecutive frames the cursor reading has looked stale. */
  staleCursorFrames: number;
  /** How many frames we've spent trying to park the cursor before the
   *  current probe. Capped to avoid dead-loop when cursor can't move. */
  parkSteps: number;
  /** When true, the next probe round skips the park step. Set after a
   *  "hover" action so the cursor stays on the slot the VLM asked to
   *  inspect (so MC renders the tooltip in the next probe image). */
  skipNextPark: boolean;
  /** Per-UI-session memory of "what is at absolute pixel position X,Y"
   *  populated by tooltip OCR after each hover. Surfaced to the probe in
   *  the next prompt so the VLM doesn't re-hover the same slot. */
  slotMemory: SlotMemory;
  /** RGB-mean fingerprint of the park-position patch when the cursor
   *  is known empty (captured the first time cursor parks at session
   *  start). On every subsequent probe, comparing the live park-patch
   *  to this baseline is the most reliable cursor-holding signal: a
   *  significant L2 distance means an item icon is overlaid on the
   *  cursor sprite at park, so the cursor is holding. */
  parkEmptyBaseline: { meanR: number; meanG: number; meanB: number; stddev: number } | null;
  /** Per-slot pixel fingerprint captured at the FIRST probe of the
   *  session (cursor at park, slots in their natural starting state).
   *  Pass B uses this as the per-slot "is this slot at its initial
   *  state?" reference -- a slot whose live patch closely matches its
   *  initial baseline is unchanged (still empty / still its starting
   *  item) and won't be misidentified as a freshly placed item. Keyed
   *  by absolute pixel position rounded to ints to survive minor
   *  detection jitter. */
  initialSlotBaselines: Map<string, { meanR: number; meanG: number; meanB: number; stddev: number }>;
  /** True for one probe cycle right after a CV-matched pickup verify
   *  (slot's pixels confirmed transition filled->empty). The
   *  cursor-holding signal AND-gates this with a park-baseline pixel
   *  diff: only when BOTH are true do we report cursorHolding=true.
   *  Cleared on the next matched place. */
  recentMatchedPickup: boolean;
  /** Recipe metadata cached when the sub-agent queries via the
   *  recipe_lookup action. Surfaced to the probe in subsequent
   *  iterations as the RECIPE / Placement plan blocks. */
  recipeOverride: RecipeInfo | null;
  /** When non-null, an OCR-on-settle is expected for the next obs frame
   *  (cursor was just hovered onto a slot; tooltip should be rendered). */
  pendingTooltipRead: { slotIndex: number; x: number; y: number; slotName?: string; retries?: number } | null;
  /** Active verify_slots batch: queue of non-empty slots to hover + OCR
   *  in sequence. After the last slot, the runtime servos cursor back to
   *  a park position before falling through to the next probe call so
   *  the cursor never lingers on a real item across iterations. */
  pendingOcrBatch: {
    slots: Array<{ slot: number; x: number; y: number; name?: string }>;
    idx: number;
    /** Set when we've finished all slots and are now servoing back to
     *  the park position; OCR is suppressed in this phase. */
    parking: boolean;
  } | null;
  /** Probe-graph step list owned by the Planner agent. Empty until
   *  recipe_lookup resolves and the rule-based seed builds the initial
   *  list. The Planner ticks `done` after each chain-end based on
   *  observation; the Action agent receives one item at a time. */
  checklist: ChecklistItem[];
  /** Index of the [ ] item the Action agent is currently executing.
   *  Cleared after a successful chain-end so the Planner can pick
   *  the next [ ] on its next turn. */
  activeChecklistIdx: number;
  /** Set true on a chain-end where source slot was role==="result".
   *  The runtime fires the Planner agent on the next entry to update
   *  the checklist + judge completion. */
  judgeAfterChain: boolean;
};

/** Servo control law: given current cursor + target slot pixel center,
 *  emit a single MCU env action — either a camera correction (if cursor
 *  not yet on target) or a click (if within tolerance). Caller passes the
 *  click button ("attack" for left-click, "use" for right-click).
 *  Set `shift` to add the sneak modifier — shift+attack on a result slot
 *  transfers crafted items to inventory regardless of what cursor holds.
 *  Returns null if the cursor wasn't detected and we should noop this
 *  frame and re-observe. */
export function servoCursorStep(opts: {
  cursor: { x: number; y: number } | null;
  target: { x: number; y: number };
  button: "attack" | "use";
  shift?: boolean;
  hitThresholdPx?: number;
}): { action: McuEnvAction; click: boolean; reason: string } | null {
  if (!opts.cursor) return null;
  const ex = opts.target.x - opts.cursor.x;
  const ey = opts.target.y - opts.cursor.y;
  const errMag = Math.hypot(ex, ey);
  const hit = opts.hitThresholdPx ?? 5;
  if (errMag <= hit) {
    const action = defaultMcuAction();
    action[opts.button] = 1;
    if (opts.shift) action.sneak = 1;
    return { action, click: true, reason: `${opts.shift ? "shift+" : ""}click err=${errMag.toFixed(1)}px` };
  }
  // Camera-delta proportional to pixel error. Clamp + quantize per frame.
  let yawDeg = ex / PX_PER_CAM_YAW;
  let pitchDeg = ey / PX_PER_CAM_PITCH;
  // Clamp + bin
  yawDeg = Math.max(-MAX_CAM_DEG, Math.min(MAX_CAM_DEG, yawDeg));
  pitchDeg = Math.max(-MAX_CAM_DEG, Math.min(MAX_CAM_DEG, pitchDeg));
  let dy = quantizeCam(yawDeg);
  let dp = quantizeCam(pitchDeg);
  // Pitch deadzone: if remaining error is below half the deadzone, drop
  // it so we don't oscillate.
  if (dp !== 0 && Math.abs(dp) < PITCH_DEADZONE_MIN) {
    dp = Math.sign(dp) * PITCH_DEADZONE_MIN;
  }
  if (Math.abs(pitchDeg) * PX_PER_CAM_PITCH < PITCH_DEADZONE_MIN / 2) dp = 0;
  if (dy === 0 && dp === 0) {
    // Sub-quantum stuck: cursor is within ~half a cam-bin of the
    // target but neither axis can compute a non-zero correction.
    // Force the smallest cam (2 deg = ~17 px) in the dominant
    // error axis so the cursor at least moves to a different sub-
    // pixel position before the click cap fires. This breaks the
    // deterministic stuck-then-click-the-same-pixel loop where the
    // click consistently lands at the slot edge and MC's effective
    // hit region rejects it.
    const action = defaultMcuAction();
    if (Math.abs(ex) >= Math.abs(ey)) {
      action.camera = [0, Math.sign(ex) * 2];
    } else {
      action.camera = [Math.sign(ey) * 2, 0];
    }
    return {
      action,
      click: false,
      reason: `kick err=${errMag.toFixed(1)}px cam=[${action.camera[0]},${action.camera[1]}] (sub-quantum stuck nudge)`,
    };
  }
  const action = defaultMcuAction();
  action.camera = [dp, dy];
  return {
    action,
    click: false,
    reason: `servo err=(${ex},${ey})px cam=[${dp},${dy}]`,
  };
}

/** Always returns a plan. The closed-loop is gated purely at RUNTIME
 *  by whether the SoM detector finds a multi-slot inventory layout in
 *  the current obs frame -- no text-keyword filtering, no recipe-name
 *  matching. If the agent never opens a UI, the closed-loop block
 *  noops and the regular VLM handles world actions (mining, fighting,
 *  exploring, killing the ender dragon, etc.). The moment any GUI
 *  appears -- crafting grid, furnace, chest, anvil, villager, brewing
 *  stand, enchanting table, modded container -- the probe + servo +
 *  click + verify machinery takes over generically. The probe sees
 *  the raw taskText so it can reason about whatever the goal is. */
export function planClosedLoopCraft(taskText: string): ClosedLoopCraftPlan {
  return {
    taskText,
    cursor: CURSOR_OPEN_CENTER,
    iteration: 0,
    done: false,
    maxIterations: 32,
    pendingClick: null,
    awaitingVerify: null,
    servoSteps: 0,
    layoutHint: null,
    sessionLayout: null,
    pickupSourceSlot: null,
    cursorItemSignature: null,
    pendingChain: [],
    lastCursorRead: null,
    lastEmittedCam: [0, 0],
    staleCursorFrames: 0,
    parkSteps: 0,
    skipNextPark: false,
    slotMemory: new SlotMemory(),
    pendingTooltipRead: null,
    pendingOcrBatch: null,
    parkEmptyBaseline: null,
    recentMatchedPickup: false,
    initialSlotBaselines: new Map(),
    recipeOverride: null,
    checklist: [],
    activeChecklistIdx: -1,
    judgeAfterChain: false,
  };
}

/** Legacy phase 1 for backwards-compat tests; now equivalent to open+settle. */
export function buildUiFastControlPhase1(taskText: string): UiFastControlFrame[] | null {
  const target = parseTargetItem(taskText);
  if (!target) return null;
  return buildCraftOpenInventoryFrames(target);
}

/**
 * Phase 2: builds the cursor + click sequence using the probe-derived slot
 * map. If the probe didn't find the ingredient anywhere on the hotbar, falls
 * back to assuming slot 0 (the legacy /give-order heuristic) so the macro
 * still tries something rather than abandoning.
 */
export function buildUiFastControlPhase2(opts: {
  recipeTarget: string;
  ingredientName: string;
  hotbarSlot: number;
}): UiFastControlFrame[] {
  // Phase 1 already opened the inventory and settled the GUI; phase 2 must
  // NOT toggle inventory again (that would close it and run subsequent
  // clicks in world mode).
  return buildSingleSlot2x2Macro(opts.hotbarSlot, `craft_${opts.recipeTarget}`, { assumeInventoryOpen: true });
}

/**
 * Legacy entry point kept for tests: builds the full macro assuming the
 * ingredient is in hotbar slot 0. New callers should use Phase1 + Phase2.
 */
export function buildUiFastControl(taskText: string): UiFastControlFrame[] | null {
  const target = parseTargetItem(taskText);
  if (!target) return null;
  const recipe = lookupRecipe(target);
  if (!recipe) return null;
  if (recipe.requiresTable) return null;
  if (recipe.ingredients.length !== 1) return null;
  if (recipe.ingredients[0].count !== 1) return null;
  return buildSingleSlot2x2Macro(0, `craft_${recipe.target}`);
}
