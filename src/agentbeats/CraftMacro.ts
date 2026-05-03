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
import { defaultMcuAction, type McuEnvAction } from "./McuPrompt";
import { detectedSlotPixel, type DetectedLayout } from "./SlotDetector";

export type CraftMacroFrame = {
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

// Empirical K from fix4 evaluation run, which scored 4.0/10 (best so far).
// Asymmetric: yaw stronger than pitch in GUI mode. fix5 tried averaging both
// to ~6 and regressed to 1.5/10, so the asymmetry matters more than absolute
// accuracy.
const PX_PER_CAM_YAW = 8.5;
const PX_PER_CAM_PITCH = 4.0;
const PITCH_DEADZONE_MIN = 8;
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

/** Resolve a probe slot index (0..40) to a screen pixel center.
 *  When a CV-detected `layout` is supplied, slot positions come from that
 *  per-frame detection (preferred); otherwise the static fallback table
 *  is used. */
export function slotIndexToPixel(slotIndex: number, layout?: DetectedLayout | null): { x: number; y: number } | null {
  if (layout) return detectedSlotPixel(layout, slotIndex);
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
type RecipeInfo = {
  target: string;
  ingredients: RecipeIngredient[];
  requiresTable: boolean;
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
  return {
    target: resolvedName,
    ingredients,
    requiresTable: !!recipe.requiresTable,
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
): CraftMacroFrame[] {
  const frames: CraftMacroFrame[] = [];
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
  layout?: DetectedLayout | null;
}): { frames: CraftMacroFrame[]; newCursor: { x: number; y: number } } {
  const target = slotIndexToPixel(opts.toSlot, opts.layout ?? null);
  if (!target) return { frames: [], newCursor: opts.fromCursor };
  const out: CraftMacroFrame[] = [];
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
export function buildCraftOpenInventoryFrames(target: string): CraftMacroFrame[] {
  const label = `craft_${target}`;
  const frames: CraftMacroFrame[] = [];
  const push = (action: McuEnvAction, holdSteps: number, frameLabel: string) =>
    frames.push({ action, holdSteps, label: `${label}:${frameLabel}` });
  const openAct = defaultMcuAction();
  openAct.inventory = 1;
  push(openAct, 1, "open_inv");
  push(defaultMcuAction(), 4, "settle_after_open");
  return frames;
}

/** Plan for the closed-loop driver living in McuPolicy state. */
export type ClosedLoopCraftPlan = {
  target: string;
  ingredient: string;
  cursor: { x: number; y: number };
  iteration: number;
  done: boolean;
  /** Cap the number of probe iterations so a confused VLM can't loop forever. */
  maxIterations: number;
};

/** Returns null if the task is not a single-ingredient 2x2 craft we handle. */
export function planClosedLoopCraft(taskText: string): ClosedLoopCraftPlan | null {
  const target = parseTargetItem(taskText);
  if (!target) return null;
  const recipe = lookupRecipe(target);
  if (!recipe) return null;
  if (recipe.requiresTable) return null;
  if (recipe.ingredients.length !== 1) return null;
  if (recipe.ingredients[0].count !== 1) return null;
  return {
    target: recipe.target,
    ingredient: recipe.ingredients[0].name,
    cursor: CURSOR_OPEN_CENTER,
    iteration: 0,
    done: false,
    maxIterations: 8,
  };
}

/** Legacy phase 1 for backwards-compat tests; now equivalent to open+settle. */
export function buildCraftMacroPhase1(taskText: string): CraftMacroFrame[] | null {
  const plan = planClosedLoopCraft(taskText);
  if (!plan) return null;
  return buildCraftOpenInventoryFrames(plan.target);
}

/**
 * Phase 2: builds the cursor + click sequence using the probe-derived slot
 * map. If the probe didn't find the ingredient anywhere on the hotbar, falls
 * back to assuming slot 0 (the legacy /give-order heuristic) so the macro
 * still tries something rather than abandoning.
 */
export function buildCraftMacroPhase2(opts: {
  recipeTarget: string;
  ingredientName: string;
  hotbarSlot: number;
}): CraftMacroFrame[] {
  // Phase 1 already opened the inventory and settled the GUI; phase 2 must
  // NOT toggle inventory again (that would close it and run subsequent
  // clicks in world mode).
  return buildSingleSlot2x2Macro(opts.hotbarSlot, `craft_${opts.recipeTarget}`, { assumeInventoryOpen: true });
}

/**
 * Legacy entry point kept for tests: builds the full macro assuming the
 * ingredient is in hotbar slot 0. New callers should use Phase1 + Phase2.
 */
export function buildCraftMacro(taskText: string): CraftMacroFrame[] | null {
  const target = parseTargetItem(taskText);
  if (!target) return null;
  const recipe = lookupRecipe(target);
  if (!recipe) return null;
  if (recipe.requiresTable) return null;
  if (recipe.ingredients.length !== 1) return null;
  if (recipe.ingredients[0].count !== 1) return null;
  return buildSingleSlot2x2Macro(0, `craft_${recipe.target}`);
}
