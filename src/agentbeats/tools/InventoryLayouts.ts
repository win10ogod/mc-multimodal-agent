/**
 * Vanilla Minecraft GUI layout metadata.
 *
 * Each entry describes a known GUI type — its window logical size and the
 * logical pixel positions of every interactable slot, with a semantic role
 * the VLM can reason about ("furnace_input", "anvil_output", etc.).
 *
 * Logical pixels match the GUI texture coordinates used by the vanilla
 * client. To get screen pixel positions for a given obs frame, multiply by
 * `scale = windowPixelW / windowLogicalW` and offset by the detected
 * window top-left (from SlotDetector.findWindowBBox).
 *
 * Sources: vanilla 1.18-1.20 client GUI texture coords. Verified against
 * the CV slot-position measurements in local_tests/measure_slots.py.
 *
 * This module is intentionally data-only; SlotDetector applies it.
 */

export type LogicalSlot = {
  /** Semantic name visible to the VLM, e.g. "hotbar_0", "craft_3x3_4",
   *  "furnace_input", "chest_27". Use stable lowercase snake_case. */
  name: string;
  /** A grouping role the VLM can reason about
   *  ("hotbar" | "main_inv" | "craft_2x2" | "craft_3x3" | "result"
   *   | "armor" | "offhand" | "furnace_input" | "furnace_fuel"
   *   | "furnace_output" | "brewing_potion" | "brewing_ingredient"
   *   | "brewing_blaze" | "anvil_input_a" | "anvil_input_b" | "anvil_output"
   *   | "enchant_item" | "enchant_lapis" | "enchant_button"
   *   | "chest_storage" | "trade_offer" | "trade_input_a" | "trade_input_b"
   *   | "trade_output"). */
  role: string;
  /** Logical pixel center within the window. */
  x: number;
  y: number;
};

export type LogicalLayout = {
  /** Stable identifier, e.g. "player_inventory", "crafting_table". */
  id: string;
  /** Window logical width and height. Most MC GUIs are 176-wide. */
  windowW: number;
  windowH: number;
  /** Slots in canonical raster order (top-to-bottom, left-to-right).
   *  This index will be the SoM number shown to the VLM. */
  slots: LogicalSlot[];
};

// Logical-pixel slot inner size (16) and stride (18) are constant across
// vanilla MC GUIs. Helper to enumerate a slot grid.
function gridSlots(opts: {
  prefix: string;
  role: string;
  rows: number;
  cols: number;
  /** Top-left CORNER of the top-left slot in logical pixels. The slot
   *  CENTER is at (corner + 8, corner + 8). */
  topLeftX: number;
  topLeftY: number;
  stride?: number;
}): LogicalSlot[] {
  const stride = opts.stride ?? 18;
  const out: LogicalSlot[] = [];
  for (let r = 0; r < opts.rows; r += 1) {
    for (let c = 0; c < opts.cols; c += 1) {
      const idx = r * opts.cols + c;
      out.push({
        name: `${opts.prefix}_${idx}`,
        role: opts.role,
        x: opts.topLeftX + c * stride + 8,
        y: opts.topLeftY + r * stride + 8,
      });
    }
  }
  return out;
}

// Player-inventory bottom block (3x9 main + 1x9 hotbar). Y offsets are
// measured from the WINDOW top of whichever GUI hosts them. For vanilla
// 176x166 GUIs (player inventory, crafting table, furnace, brewing
// stand, anvil, enchanting table) the player block sits at y=84/142.
function playerInventoryBlock(yMain: number, yHotbar: number): LogicalSlot[] {
  return [
    ...gridSlots({ prefix: "main_inv", role: "main_inv", rows: 3, cols: 9, topLeftX: 8, topLeftY: yMain }),
    ...gridSlots({ prefix: "hotbar", role: "hotbar", rows: 1, cols: 9, topLeftX: 8, topLeftY: yHotbar }),
  ];
}

// ---------------------------------------------------------------------------
// Layout definitions
// ---------------------------------------------------------------------------

export const LAYOUT_PLAYER_INVENTORY: LogicalLayout = {
  id: "player_inventory",
  windowW: 176,
  windowH: 166,
  slots: [
    { name: "armor_helmet",     role: "armor",      x: 8 + 8,   y: 8 + 8 },
    { name: "armor_chestplate", role: "armor",      x: 8 + 8,   y: 26 + 8 },
    { name: "armor_leggings",   role: "armor",      x: 8 + 8,   y: 44 + 8 },
    { name: "armor_boots",      role: "armor",      x: 8 + 8,   y: 62 + 8 },
    { name: "offhand",          role: "offhand",    x: 76 + 8,  y: 62 + 8 },
    ...gridSlots({ prefix: "craft_2x2", role: "craft_2x2", rows: 2, cols: 2, topLeftX: 98, topLeftY: 18 }),
    { name: "craft_2x2_result", role: "result",     x: 154 + 8, y: 28 + 8 },
    ...playerInventoryBlock(84, 142),
  ],
};

export const LAYOUT_CRAFTING_TABLE: LogicalLayout = {
  id: "crafting_table",
  windowW: 176,
  windowH: 166,
  slots: [
    ...gridSlots({ prefix: "craft_3x3", role: "craft_3x3", rows: 3, cols: 3, topLeftX: 30, topLeftY: 17 }),
    { name: "craft_3x3_result", role: "result",     x: 124 + 8, y: 35 + 8 },
    ...playerInventoryBlock(84, 142),
  ],
};

// Single chest: 3 rows of container + player inv. Window is 176x132 + 90 = 222.
// y=18 for container, y=140 for main_inv (offset 18 + 3*18 + 14 padding = 86? -> use measured 140)
// y=198 for hotbar.
export const LAYOUT_CHEST_SMALL: LogicalLayout = {
  id: "chest_small",
  windowW: 176,
  windowH: 132 + 84,  // ~216 — exact by measurement may differ
  slots: [
    ...gridSlots({ prefix: "chest", role: "chest_storage", rows: 3, cols: 9, topLeftX: 8, topLeftY: 18 }),
    ...playerInventoryBlock(140, 198),
  ],
};

export const LAYOUT_CHEST_LARGE: LogicalLayout = {
  id: "chest_large",
  windowW: 176,
  windowH: 168 + 84,
  slots: [
    ...gridSlots({ prefix: "chest", role: "chest_storage", rows: 6, cols: 9, topLeftX: 8, topLeftY: 18 }),
    ...playerInventoryBlock(140, 198),  // shifted down for double chest; tune from CV when used
  ],
};

export const LAYOUT_FURNACE: LogicalLayout = {
  id: "furnace",
  windowW: 176,
  windowH: 166,
  slots: [
    { name: "furnace_input",  role: "furnace_input",  x: 56 + 8, y: 17 + 8 },
    { name: "furnace_fuel",   role: "furnace_fuel",   x: 56 + 8, y: 53 + 8 },
    { name: "furnace_output", role: "furnace_output", x: 116 + 8, y: 35 + 8 },
    ...playerInventoryBlock(84, 142),
  ],
};

// Smoker and blast_furnace share the furnace layout slot positions.
export const LAYOUT_SMOKER: LogicalLayout = { ...LAYOUT_FURNACE, id: "smoker" };
export const LAYOUT_BLAST_FURNACE: LogicalLayout = { ...LAYOUT_FURNACE, id: "blast_furnace" };

export const LAYOUT_BREWING_STAND: LogicalLayout = {
  id: "brewing_stand",
  windowW: 176,
  windowH: 166,
  slots: [
    { name: "brewing_blaze",      role: "brewing_blaze",      x: 17 + 8,  y: 17 + 8 },
    { name: "brewing_ingredient", role: "brewing_ingredient", x: 79 + 8,  y: 17 + 8 },
    { name: "brewing_potion_0",   role: "brewing_potion",     x: 56 + 8,  y: 51 + 8 },
    { name: "brewing_potion_1",   role: "brewing_potion",     x: 79 + 8,  y: 58 + 8 },
    { name: "brewing_potion_2",   role: "brewing_potion",     x: 102 + 8, y: 51 + 8 },
    ...playerInventoryBlock(84, 142),
  ],
};

export const LAYOUT_ANVIL: LogicalLayout = {
  id: "anvil",
  windowW: 176,
  windowH: 166,
  slots: [
    { name: "anvil_input_a", role: "anvil_input_a", x: 27 + 8,  y: 47 + 8 },
    { name: "anvil_input_b", role: "anvil_input_b", x: 76 + 8,  y: 47 + 8 },
    { name: "anvil_output",  role: "anvil_output",  x: 134 + 8, y: 47 + 8 },
    ...playerInventoryBlock(84, 142),
  ],
};

export const LAYOUT_ENCHANTING_TABLE: LogicalLayout = {
  id: "enchanting_table",
  windowW: 176,
  windowH: 166,
  slots: [
    { name: "enchant_item",     role: "enchant_item",   x: 15 + 8, y: 47 + 8 },
    { name: "enchant_lapis",    role: "enchant_lapis",  x: 35 + 8, y: 47 + 8 },
    // Enchant buttons aren't slots per se but are clickable; treat them
    // as interactable for SoM purposes.
    { name: "enchant_button_0", role: "enchant_button", x: 60 + 50, y: 14 + 9 },
    { name: "enchant_button_1", role: "enchant_button", x: 60 + 50, y: 33 + 9 },
    { name: "enchant_button_2", role: "enchant_button", x: 60 + 50, y: 52 + 9 },
    ...playerInventoryBlock(84, 142),
  ],
};

export const LAYOUT_VILLAGER: LogicalLayout = {
  id: "villager",
  windowW: 276,  // wider than standard
  windowH: 166,
  slots: [
    { name: "trade_input_a", role: "trade_input_a", x: 136 + 8, y: 37 + 8 },
    { name: "trade_input_b", role: "trade_input_b", x: 162 + 8, y: 37 + 8 },
    { name: "trade_output",  role: "trade_output",  x: 220 + 8, y: 37 + 8 },
    // Player inv shifted right by the trade-list panel
    ...gridSlots({ prefix: "main_inv", role: "main_inv", rows: 3, cols: 9, topLeftX: 108, topLeftY: 84 }),
    ...gridSlots({ prefix: "hotbar",   role: "hotbar",   rows: 1, cols: 9, topLeftX: 108, topLeftY: 142 }),
  ],
};

export const ALL_LAYOUTS: LogicalLayout[] = [
  LAYOUT_PLAYER_INVENTORY,
  LAYOUT_CRAFTING_TABLE,
  LAYOUT_CHEST_SMALL,
  LAYOUT_CHEST_LARGE,
  LAYOUT_FURNACE,
  LAYOUT_SMOKER,
  LAYOUT_BLAST_FURNACE,
  LAYOUT_BREWING_STAND,
  LAYOUT_ANVIL,
  LAYOUT_ENCHANTING_TABLE,
  LAYOUT_VILLAGER,
];

export const LAYOUTS_BY_ID: Record<string, LogicalLayout> = Object.fromEntries(
  ALL_LAYOUTS.map((l) => [l.id, l]),
);

/**
 * Pick the best-matching layout for a given window aspect + slot count.
 * Returns null if nothing matches; caller should then fall back to
 * dynamic CV discovery (SlotDetector.discoverSlots).
 *
 * Heuristic:
 *   1. Filter layouts whose window aspect ratio matches within tolerance.
 *   2. Among those, prefer the one whose slot count matches the number of
 *      CV-discovered slot rectangles.
 *   3. Tie-break by GUI familiarity priority (player_inventory first).
 */
export function pickLayout(opts: {
  windowAspect: number;        // windowW / windowH
  discoveredSlotCount: number; // from SlotDetector.discoverSlots
  /** Optional hint from the task text or open-window event, e.g. "furnace". */
  hintId?: string;
}): LogicalLayout | null {
  if (opts.hintId && LAYOUTS_BY_ID[opts.hintId]) return LAYOUTS_BY_ID[opts.hintId];

  const ASPECT_TOL = 0.18;
  const SLOT_TOL = 3;
  const candidates = ALL_LAYOUTS.filter((l) => {
    const a = l.windowW / l.windowH;
    if (Math.abs(a - opts.windowAspect) > ASPECT_TOL) return false;
    if (Math.abs(l.slots.length - opts.discoveredSlotCount) > SLOT_TOL) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  // Sort by slot-count proximity, then by name-priority order in ALL_LAYOUTS.
  candidates.sort((a, b) => {
    const da = Math.abs(a.slots.length - opts.discoveredSlotCount);
    const db = Math.abs(b.slots.length - opts.discoveredSlotCount);
    if (da !== db) return da - db;
    return ALL_LAYOUTS.indexOf(a) - ALL_LAYOUTS.indexOf(b);
  });
  return candidates[0];
}

/** Resolve a logical-pixel slot to a screen pixel center given a detected
 *  window position + scale. */
export function slotScreenCenter(
  slot: LogicalSlot,
  windowX: number,
  windowY: number,
  scale: number,
): { x: number; y: number } {
  return {
    x: Math.round(windowX + slot.x * scale),
    y: Math.round(windowY + slot.y * scale),
  };
}
