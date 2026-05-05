/**
 * Inventory window + slot grid detector.
 *
 * The Minecraft inventory GUI has a fixed light-grey window (RGB ~198) over
 * a darker background. We detect that window's bounding box in the obs
 * frame, then derive every slot pixel center from the window's position
 * using the game's hard-coded internal layout (176x166 logical pixels,
 * scaled to fit 640x360 obs).
 *
 * This replaces the previous hard-coded slot Y/X constants which were
 * empirically guessed and shifted around with each obs frame's offset.
 */
import jpeg from "jpeg-js";

// Minecraft inventory window logical layout (vanilla 1.x, scale-invariant
// fractions of the 176x166 window).
const WIN_LOGICAL_W = 176;
const SLOT_LOGICAL = 18;          // stride between slot centers
const SLOT_INNER_LOGICAL = 16;    // visible slot square
// Logical pixel positions of each slot's TOP-LEFT corner inside the window.
// Source: vanilla Minecraft inventory GUI texture coordinates.
const HOTBAR_TL = { x: 8, y: 142 };          // hotbar row, slot 0 top-left
const MAIN_INV_TL = { x: 8, y: 84 };          // main inv row 1 (top), slot 0 top-left
const CRAFT_2X2_TL = { x: 98, y: 18 };        // 2x2 craft top-left slot
const CRAFT_RESULT_TL = { x: 154, y: 28 };    // craft result slot

export type DetectedLayout = {
  windowX: number;
  windowY: number;
  windowW: number;
  windowH: number;
  scale: number;             // pixels per logical unit (windowW / 176)
  slotSize: number;          // visible slot square in pixels
  // Resolved pixel CENTERS for each semantic slot.
  hotbar: Array<{ x: number; y: number }>;        // 9 slots
  mainInv: Array<{ x: number; y: number }>;       // 27 slots, idx 0..26 (top row first)
  craft2x2: Array<{ x: number; y: number }>;      // 4 slots: TL, TR, BL, BR
  craft2x2Result: { x: number; y: number };
  cursorOpenCenter: { x: number; y: number };
};

const GRAY_MIN = 175;
const GRAY_MAX = 215;
const GRAY_TOLERANCE = 12; // max channel spread for "neutral grey"

function isInventoryGrey(r: number, g: number, b: number): boolean {
  if (r < GRAY_MIN || r > GRAY_MAX) return false;
  if (g < GRAY_MIN || g > GRAY_MAX) return false;
  if (b < GRAY_MIN || b > GRAY_MAX) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= GRAY_TOLERANCE;
}

/**
 * Find the bounding box of the inventory window's light-grey area.
 * Strategy: row-major scan, count grey pixels per row/column, take rows
 * and columns where grey pixels exceed a threshold to bound the window.
 */
function findWindowBBox(rgba: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  const rowGreyCount = new Int32Array(h);
  const colGreyCount = new Int32Array(w);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (isInventoryGrey(rgba[i], rgba[i + 1], rgba[i + 2])) {
        rowGreyCount[y] += 1;
        colGreyCount[x] += 1;
      }
    }
  }
  // The inventory window at MC GUI scales we see has horizontal bands of
  // ~150-180 grey pixels per row. Threshold = a row that is at least 60%
  // grey out to the window's pixel width (>=100 px on 640 wide).
  const ROW_THR = Math.floor(w * 0.18);
  const COL_THR = Math.floor(h * 0.18);
  let yTop = -1, yBot = -1, xLeft = -1, xRight = -1;
  for (let y = 0; y < h; y += 1) if (rowGreyCount[y] >= ROW_THR) { yTop = y; break; }
  for (let y = h - 1; y >= 0; y -= 1) if (rowGreyCount[y] >= ROW_THR) { yBot = y; break; }
  for (let x = 0; x < w; x += 1) if (colGreyCount[x] >= COL_THR) { xLeft = x; break; }
  for (let x = w - 1; x >= 0; x -= 1) if (colGreyCount[x] >= COL_THR) { xRight = x; break; }
  if (yTop < 0 || yBot < 0 || xLeft < 0 || xRight < 0) return null;
  // Sanity check: the window should be roughly the right aspect ratio
  // (176 / 166 ~= 1.06). Reject obviously wrong detections.
  const ww = xRight - xLeft + 1;
  const hh = yBot - yTop + 1;
  if (ww < 100 || hh < 80 || ww > w || hh > h) return null;
  return { x: xLeft, y: yTop, w: ww, h: hh };
}

function slotCenter(winX: number, winY: number, scale: number, logicalTL: { x: number; y: number }, idx: number, cols: number): { x: number; y: number } {
  const r = Math.floor(idx / cols);
  const c = idx % cols;
  const lx = logicalTL.x + c * SLOT_LOGICAL + SLOT_INNER_LOGICAL / 2;
  const ly = logicalTL.y + r * SLOT_LOGICAL + SLOT_INNER_LOGICAL / 2;
  return { x: Math.round(winX + lx * scale), y: Math.round(winY + ly * scale) };
}

/** Detect the inventory window in a 640x360-ish JPEG obs frame and return
 *  a full slot pixel layout. Returns null if the inventory window can't be
 *  found (caller should fall back to defaults or skip the action). */
export function detectInventoryLayout(jpegBase64: string): DetectedLayout | null {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const buf = Buffer.from(cleaned, "base64");
  let decoded;
  try {
    decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  }
  const { width: w, height: h, data } = decoded;
  const bbox = findWindowBBox(data, w, h);
  if (!bbox) return null;
  // Window pixel width corresponds to WIN_LOGICAL_W logical pixels. Use that
  // to derive scale; height should follow but use width as reference since
  // the top/bottom edges blend into player avatar / slot grid.
  const scale = bbox.w / WIN_LOGICAL_W;

  const hotbar: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 9; i += 1) {
    hotbar.push(slotCenter(bbox.x, bbox.y, scale, HOTBAR_TL, i, 9));
  }
  const mainInv: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 27; i += 1) {
    mainInv.push(slotCenter(bbox.x, bbox.y, scale, MAIN_INV_TL, i, 9));
  }
  const craft2x2: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 4; i += 1) {
    craft2x2.push(slotCenter(bbox.x, bbox.y, scale, CRAFT_2X2_TL, i, 2));
  }
  const craft2x2Result = slotCenter(bbox.x, bbox.y, scale, CRAFT_RESULT_TL, 0, 1);
  // When the inventory just opens, the cursor sits at the screen center
  // (640x360 frame). This is a frame property, not an inventory property.
  const cursorOpenCenter = { x: Math.round(w / 2), y: Math.round(h / 2) };

  return {
    windowX: bbox.x,
    windowY: bbox.y,
    windowW: bbox.w,
    windowH: bbox.h,
    scale,
    slotSize: SLOT_INNER_LOGICAL * scale,
    hotbar,
    mainInv,
    craft2x2,
    craft2x2Result,
    cursorOpenCenter,
  };
}

/** Map a probe slot index (0..40) to its detected pixel center. */
export function detectedSlotPixel(layout: DetectedLayout, slotIndex: number): { x: number; y: number } | null {
  if (slotIndex >= 0 && slotIndex <= 8) return layout.hotbar[slotIndex];
  if (slotIndex >= 9 && slotIndex <= 35) return layout.mainInv[slotIndex - 9];
  if (slotIndex >= 36 && slotIndex <= 39) return layout.craft2x2[slotIndex - 36];
  if (slotIndex === 40) return layout.craft2x2Result;
  return null;
}

// =========================================================================
// Generic slot discovery (no vanilla-MC layout assumptions).
//
// Works for ANY Minecraft GUI: crafting table, chest, double chest,
// furnace, brewing stand, beacon, enchanting table, anvil, modded
// containers, etc. We detect interactable slots by:
//   1. Finding the inventory window's light-grey mass.
//   2. Within the window, masking pixels that match the slot-interior
//      darker-grey color (~RGB 139).
//   3. Running connected components on that mask.
//   4. Keeping components whose bounding box is square-ish and whose size
//      matches a single-slot footprint (auto-sized from the window scale).
//   5. Numbering them in raster order: top-to-bottom by row band, then
//      left-to-right within each band.
//
// The VLM then sees marks for every actual interactable slot in any GUI,
// no per-GUI layout knowledge required.
// =========================================================================

const SLOT_GRAY_MIN = 120;
const SLOT_GRAY_MAX = 165;
const SLOT_GRAY_TOLERANCE = 14;

function isSlotInteriorGrey(r: number, g: number, b: number): boolean {
  if (r < SLOT_GRAY_MIN || r > SLOT_GRAY_MAX) return false;
  if (g < SLOT_GRAY_MIN || g > SLOT_GRAY_MAX) return false;
  if (b < SLOT_GRAY_MIN || b > SLOT_GRAY_MAX) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= SLOT_GRAY_TOLERANCE;
}

export type DiscoveredSlot = {
  /** Raster-order index, 0..N-1. */
  index: number;
  /** Pixel center. */
  cx: number;
  cy: number;
  /** Bounding box of the slot interior. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DiscoveredLayout = {
  windowX: number;
  windowY: number;
  windowW: number;
  windowH: number;
  /** Heuristic slot pixel size used for filtering (square inner extent). */
  slotPx: number;
  /** All interactable slots, raster-ordered. */
  slots: DiscoveredSlot[];
  /** Cursor center (frame center). */
  cursorOpenCenter: { x: number; y: number };
};

/** Iterative flood-fill of a binary mask starting from (sx, sy). Marks
 *  each visited pixel in `labels` with `lid` and returns its bbox + area. */
function floodFill(
  mask: Uint8Array,
  labels: Int32Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  lid: number,
): { x0: number; y0: number; x1: number; y1: number; area: number } {
  const stack: number[] = [sx, sy];
  let x0 = sx, y0 = sy, x1 = sx, y1 = sy;
  let area = 0;
  while (stack.length > 0) {
    const py = stack.pop()!;
    const px = stack.pop()!;
    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    const off = py * w + px;
    if (labels[off] !== 0) continue;
    if (mask[off] === 0) continue;
    labels[off] = lid;
    area += 1;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
    stack.push(px - 1, py, px + 1, py, px, py - 1, px, py + 1);
  }
  return { x0, y0, x1, y1, area };
}

/** GENERAL DETECTION POLICY (call this for SoM marking + click compilation):
 *  1. Find inventory window via grey-mass scan.
 *  2. Discover all interactable slot rectangles in the window via CV.
 *  3. Attempt to promote the raster-ordered slots to semantic-named slots
 *     using the closest matching LogicalLayout from InventoryLayouts.ts.
 *  4. Return a unified GuiLayout that always has raster `index` and
 *     pixel `cx,cy` for every slot, plus an optional `role`/`name` when
 *     the GUI was recognized.
 *
 *  Works for any GUI -- vanilla, modded, or unknown -- because slot
 *  detection is purely visual. Layout matching only adds names; missing
 *  it just means slots stay numbered (e.g. "slot_5" instead of
 *  "hotbar_3"), which is still fully usable for SoM. */
export type GuiSlot = {
  index: number;        // raster order, 0..N-1
  name?: string;        // semantic name if a layout matched, e.g. "hotbar_0"
  role?: string;        // semantic role, e.g. "hotbar", "result", "furnace_input"
  cx: number;           // pixel center
  cy: number;
  w: number;            // bounding-box size (for click verification)
  h: number;
};

export type GuiLayout = {
  windowX: number;
  windowY: number;
  windowW: number;
  windowH: number;
  /** ID of the matching LogicalLayout (e.g. "player_inventory") if any
   *  was a confident match; null for unknown/unmatched GUIs. */
  matchedLayoutId: string | null;
  /** All interactable slots, raster order. */
  slots: GuiSlot[];
  cursorOpenCenter: { x: number; y: number };
};

/** Slot lookup by raster index. */
export function guiSlotByIndex(layout: GuiLayout, index: number): GuiSlot | null {
  return layout.slots[index] ?? null;
}

/** Slot lookup by semantic name (e.g. "hotbar_0", "craft_3x3_result").
 *  Returns null if the GUI wasn't matched to a known layout or the name
 *  isn't found. */
export function guiSlotByName(layout: GuiLayout, name: string): GuiSlot | null {
  for (const s of layout.slots) {
    if (s.name === name) return s;
  }
  return null;
}

/** Slot lookup by semantic role (e.g. "hotbar", "furnace_input"). Returns
 *  the FIRST matching slot, or all of them if you pass `all=true`. */
export function guiSlotsByRole(layout: GuiLayout, role: string): GuiSlot[] {
  return layout.slots.filter((s) => s.role === role);
}

// =========================================================================
// Cursor position detector (for Image-Based Visual Servoing).
// =========================================================================

/** Detect the GUI cursor (small white-arrow sprite) within the inventory
 *  window. Strategy: mask near-white pixels, flood-fill connected
 *  components, keep the largest component whose size matches the cursor's
 *  ~10x16 footprint and is not at a slot's typical position (helps avoid
 *  matching white items in slots). Returns null if no plausible cursor
 *  is found. */
// Binary template of the MC GUI cursor sprite at 1x scale: 8 cols x 12
// rows. 1 = expect white, 0 = expect non-white. The shape is an arrow
// pointing up-left: dense 1s at the top-left tip with a diagonal tail
// going down-right. This template lets us match the cursor against the
// obs frame by pixel-similarity instead of relying on heuristic shape
// rules (which kept locking onto static white blobs like the avatar
// or slot highlights).
const CURSOR_TEMPLATE: number[][] = [
  [1, 1, 0, 0, 0, 0, 0, 0],
  [1, 1, 1, 0, 0, 0, 0, 0],
  [1, 1, 1, 1, 0, 0, 0, 0],
  [1, 0, 0, 1, 1, 0, 0, 0],
  [1, 0, 0, 0, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 1, 1, 0],
  [0, 0, 0, 0, 0, 0, 1, 1],
  [0, 0, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
];
const TPL_W = 8, TPL_H = 12;
let TPL_ON_COUNT = 0;
for (const row of CURSOR_TEMPLATE) for (const v of row) if (v) TPL_ON_COUNT += 1;

/** Pixel-template match for the MC GUI cursor sprite. Slides the
 *  CURSOR_TEMPLATE across the white-pixel mask of the obs frame and
 *  returns the (x, y) of the best-scoring top-left position. Returns
 *  null when no position scores above the minimum confidence
 *  threshold. */
export function detectCursorTemplate(jpegBase64: string): { x: number; y: number } | null {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const buf = Buffer.from(cleaned, "base64");
  let decoded;
  try { decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); } catch { return null; }
  const { width: w, height: h, data } = decoded;
  // Build white-pixel mask once.
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r >= 235 && g >= 235 && b >= 235 && Math.max(r, g, b) - Math.min(r, g, b) <= 12) {
        mask[y * w + x] = 1;
      }
    }
  }
  // Slide template; reward template-on hitting white, penalize template-on
  // missing white and template-off finding white.
  let bestScore = -Infinity;
  let bestX = -1, bestY = -1;
  const xMax = w - TPL_W;
  const yMax = h - TPL_H;
  for (let y = 0; y <= yMax; y += 1) {
    for (let x = 0; x <= xMax; x += 1) {
      let score = 0;
      for (let dy = 0; dy < TPL_H; dy += 1) {
        for (let dx = 0; dx < TPL_W; dx += 1) {
          const tpl = CURSOR_TEMPLATE[dy][dx];
          const m = mask[(y + dy) * w + (x + dx)];
          if (tpl === 1) score += m ? 2 : -2;
          else if (m) score -= 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  // Min confidence: the template has TPL_ON_COUNT ON pixels, perfect
  // score = 2 * TPL_ON_COUNT. Require >=60% of perfect.
  const minScore = Math.floor(TPL_ON_COUNT * 2 * 0.6);
  if (bestScore < minScore) return null;
  return { x: bestX, y: bestY };
}

export function detectCursor(jpegBase64: string, _layout: GuiLayout): { x: number; y: number } | null {
  // Try template matching first -- it's far more discriminative than the
  // shape-heuristic blob detector, which keeps locking onto the avatar
  // or slot highlights. Fall back to the heuristic only if template
  // match returns null.
  const tpl = detectCursorTemplate(jpegBase64);
  if (tpl) return tpl;
  return detectCursorBlob(jpegBase64);
}

function detectCursorBlob(jpegBase64: string): { x: number; y: number } | null {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const buf = Buffer.from(cleaned, "base64");
  let decoded;
  try {
    decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  }
  const { width: w, height: h, data } = decoded;

  // Search the whole frame: the GUI cursor can be anywhere on screen,
  // not just inside the inventory window's grey area (e.g. on the
  // sidebar, hotbar, or transparent overlay regions). With shape
  // filtering below the false-positive rate is acceptable.
  const x0 = 0;
  const y0 = 0;
  const ww = w;
  const hh = h;

  // Build mask of near-white pixels.
  const mask = new Uint8Array(ww * hh);
  for (let yy = 0; yy < hh; yy += 1) {
    const absY = y0 + yy;
    for (let xx = 0; xx < ww; xx += 1) {
      const absX = x0 + xx;
      const i = (absY * w + absX) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r >= 235 && g >= 235 && b >= 235) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min <= 12) {
          mask[yy * ww + xx] = 1;
        }
      }
    }
  }

  // Flood-fill, score components.
  const labels = new Int32Array(ww * hh);
  let best: { cx: number; cy: number; area: number; cw: number; ch: number; score: number } | null = null;
  let nextLabel = 1;
  for (let yy = 0; yy < hh; yy += 1) {
    for (let xx = 0; xx < ww; xx += 1) {
      const off = yy * ww + xx;
      if (mask[off] !== 1 || labels[off] !== 0) continue;
      const stack: number[] = [xx, yy];
      let minX = xx, maxX = xx, minY = yy, maxY = yy, area = 0;
      while (stack.length > 0) {
        const py = stack.pop()!;
        const px = stack.pop()!;
        if (px < 0 || px >= ww || py < 0 || py >= hh) continue;
        const o = py * ww + px;
        if (labels[o] !== 0 || mask[o] === 0) continue;
        labels[o] = nextLabel;
        area += 1;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        stack.push(px - 1, py, px + 1, py, px, py - 1, px, py + 1);
      }
      nextLabel += 1;
      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;
      // Cursor footprint: ~10w x 16h at GUI scale 1. Allow a generous range.
      if (area < 6 || area > 90) continue;
      if (cw < 4 || cw > 16) continue;
      if (ch < 6 || ch > 22) continue;
      if (ch < cw * 0.7) continue;
      // SHAPE MATCHING: the MC GUI cursor is an arrow pointing UP-LEFT
      // -- its tip is at the bbox top-left corner, density is heavy in
      // the upper-left, light toward the bottom-right. Static slot
      // highlights / item icon edges have rectangular or hollow density
      // distributions, so they fail this test even when their size is
      // in the cursor range. Reject blobs that don't look like cursors.
      let topLeftFill = 0;
      let bottomRightFill = 0;
      const midX = minX + Math.floor(cw / 2);
      const midY = minY + Math.floor(ch / 2);
      for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
          if (labels[py * ww + px] !== nextLabel - 1) continue;
          if (px <= midX && py <= midY) topLeftFill += 1;
          else if (px > midX && py > midY) bottomRightFill += 1;
        }
      }
      // Cursor: tip pixel must lie in the bbox top-left corner (within
      // 1 px). For a hollow rectangle the top-left bbox corner is empty.
      const tipPresent =
        labels[minY * ww + minX] === nextLabel - 1
        || (minX + 1 < ww && labels[minY * ww + (minX + 1)] === nextLabel - 1)
        || (minY + 1 < hh && labels[(minY + 1) * ww + minX] === nextLabel - 1);
      if (!tipPresent) continue;
      // Cursor: top-left half should have noticeably more pixels than
      // bottom-right half (mass concentrated at tip, tail thinning).
      if (topLeftFill < bottomRightFill * 1.5 + 2) continue;
      // Score by cursor-likeness, not size. Larger asymmetry wins.
      const score = topLeftFill - bottomRightFill;
      const candidate = {
        cx: x0 + minX,
        cy: y0 + minY,
        area, cw, ch, score,
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best ? { x: Math.round(best.cx), y: Math.round(best.cy) } : null;
}

/** Disambiguating cursor detector: returns the cursor candidate closest to
 *  an EXPECTED position. The plain `detectCursor` picks the largest white
 *  blob, which can latch onto static GUI features (slot highlights, item
 *  icon edges) and report the same phantom pixel for many frames despite
 *  the sim moving the cursor. By tracking an assumed cursor (advanced
 *  open-loop from emitted cam deltas), we pick the candidate that matches
 *  motion expectation. Falls back to largest-blob if `expected` is null. */
export function detectCursorWithExpectation(
  jpegBase64: string,
  layout: GuiLayout,
  _expected: { x: number; y: number } | null,
  _maxDistPx = 60,
): { x: number; y: number } | null {
  // Currently just delegates to the shape-filtered detectCursor. The
  // expected-position disambiguation path was never reliable in practice
  // and tended to lock onto raw white blobs (avatar, slot highlights)
  // when its candidate source ignored the shape filter. Keep the
  // signature for API compatibility; route through the shape filter.
  return detectCursor(jpegBase64, layout);
}

/** Detect whether the GUI cursor is currently carrying an item icon.
 *  The held-item sprite is centered roughly 8px down-right of the cursor
 *  TIP. Sample a 12x12 patch there: high stddev (item icon edges) means
 *  carrying, low stddev (uniform GUI background) means empty. Returns
 *  null when we can't sample (no cursor / off-frame). */
export function detectCursorHolding(
  jpegBase64: string,
  cursor: { x: number; y: number } | null,
  threshold = 30,
): boolean | null {
  if (!cursor) return null;
  const patch = samplePatchFingerprint(jpegBase64, cursor.x + 8, cursor.y + 8, 12);
  if (!patch) return null;
  return patch.stddev >= threshold;
}

/** Sample a small RGB patch around a pixel and return mean+stddev as a
 *  fingerprint. Used by the closed-loop click verifier to compare a
 *  slot's appearance before vs after a click (filled vs empty). */
export function samplePatchFingerprint(
  jpegBase64: string,
  cx: number,
  cy: number,
  size = 12,
): { meanR: number; meanG: number; meanB: number; stddev: number } | null {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  let decoded;
  try {
    decoded = jpeg.decode(Buffer.from(cleaned, "base64"), { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  }
  const { width: w, height: h, data } = decoded;
  const half = Math.floor(size / 2);
  let n = 0, sumR = 0, sumG = 0, sumB = 0;
  const pixels: Array<[number, number, number]> = [];
  for (let dy = -half; dy < half; dy += 1) {
    for (let dx = -half; dx < half; dx += 1) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      pixels.push([data[i], data[i + 1], data[i + 2]]);
      sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2];
      n += 1;
    }
  }
  if (n === 0) return null;
  const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
  let varSum = 0;
  for (const [r, g, b] of pixels) {
    const dr = r - meanR, dg = g - meanG, db = b - meanB;
    varSum += dr * dr + dg * dg + db * db;
  }
  return { meanR, meanG, meanB, stddev: Math.sqrt(varSum / n) };
}

/** Perceptual hash of a slot patch (dHash, 64-bit). Captures spatial
 *  texture at the slot center: each bit compares adjacent grayscale
 *  cells in a 9×8 grid. Two patches showing the same item yield very
 *  close hashes (Hamming distance 0–4); patches with the same mean
 *  RGB but different items (a common Minecraft case — many block
 *  textures share a grey/brown palette but differ in pixel layout)
 *  diverge to Hamming distance 12+. Use a loose threshold (≤16 of 64)
 *  for "same item" matching across frames. */
export function samplePatchDHash(
  jpegBase64: string,
  cx: number,
  cy: number,
  size = 16,
): bigint | null {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  let decoded;
  try {
    decoded = jpeg.decode(Buffer.from(cleaned, "base64"), { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  }
  const { width: w, height: h, data } = decoded;
  const half = Math.floor(size / 2);
  // 9×8 grayscale grid. Each cell averages a (size/9 × size/8) sub-block.
  const cols = 9, rows = 8;
  const cellW = size / cols, cellH = size / rows;
  const grid = new Float32Array(cols * rows);
  const cnt = new Uint16Array(cols * rows);
  const x0 = cx - half, y0 = cy - half;
  for (let dy = 0; dy < size; dy += 1) {
    const y = y0 + dy;
    if (y < 0 || y >= h) continue;
    const rowIdx = Math.min(rows - 1, Math.floor(dy / cellH));
    for (let dx = 0; dx < size; dx += 1) {
      const x = x0 + dx;
      if (x < 0 || x >= w) continue;
      const colIdx = Math.min(cols - 1, Math.floor(dx / cellW));
      const i = (y * w + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      grid[rowIdx * cols + colIdx] += lum;
      cnt[rowIdx * cols + colIdx] += 1;
    }
  }
  for (let i = 0; i < grid.length; i += 1) {
    if (cnt[i] > 0) grid[i] /= cnt[i];
  }
  // dHash: for each row, compare adjacent cells horizontally.
  let hash = 0n;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      hash <<= 1n;
      if (grid[r * cols + c] > grid[r * cols + c + 1]) hash |= 1n;
    }
  }
  return hash;
}

/** Hamming distance between two 64-bit dHashes (popcount of XOR). */
export function dHashDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x !== 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Debug variant: return ALL plausible cursor components (useful for
 *  triaging false positives during calibration). */
export function detectCursorCandidates(
  jpegBase64: string,
  layout: GuiLayout,
): Array<{ x: number; y: number; w: number; h: number; area: number }> {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const buf = Buffer.from(cleaned, "base64");
  let decoded;
  try { decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); } catch { return []; }
  const { width: w, data } = decoded;
  const x0 = layout.windowX, y0 = layout.windowY, ww = layout.windowW, hh = layout.windowH;

  const mask = new Uint8Array(ww * hh);
  for (let yy = 0; yy < hh; yy += 1) {
    for (let xx = 0; xx < ww; xx += 1) {
      const i = ((y0 + yy) * w + (x0 + xx)) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r >= 235 && g >= 235 && b >= 235 && (Math.max(r, g, b) - Math.min(r, g, b)) <= 12) {
        mask[yy * ww + xx] = 1;
      }
    }
  }
  const labels = new Int32Array(ww * hh);
  const out: Array<{ x: number; y: number; w: number; h: number; area: number }> = [];
  let nextLabel = 1;
  for (let yy = 0; yy < hh; yy += 1) {
    for (let xx = 0; xx < ww; xx += 1) {
      const off = yy * ww + xx;
      if (mask[off] !== 1 || labels[off] !== 0) continue;
      const stack: number[] = [xx, yy];
      let minX = xx, maxX = xx, minY = yy, maxY = yy, area = 0;
      while (stack.length > 0) {
        const py = stack.pop()!;
        const px = stack.pop()!;
        if (px < 0 || px >= ww || py < 0 || py >= hh) continue;
        const o = py * ww + px;
        if (labels[o] !== 0 || mask[o] === 0) continue;
        labels[o] = nextLabel;
        area += 1;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        stack.push(px - 1, py, px + 1, py, px, py - 1, px, py + 1);
      }
      nextLabel += 1;
      out.push({
        x: x0 + Math.round((minX + maxX) / 2),
        y: y0 + Math.round((minY + maxY) / 2),
        w: maxX - minX + 1,
        h: maxY - minY + 1,
        area,
      });
    }
  }
  return out.sort((a, b) => b.area - a.area);
}

/** Discover every interactable slot in the inventory window without
 *  assuming any specific GUI layout. Returns null if no window is found
 *  or no slot-shaped components are detected.
 */
export function discoverSlots(jpegBase64: string): DiscoveredLayout | null {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const buf = Buffer.from(cleaned, "base64");
  let decoded;
  try {
    decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  } catch {
    return null;
  }
  const { width: w, height: h, data } = decoded;
  const bbox = findWindowBBox(data, w, h);
  if (!bbox) return null;

  // Build the slot-interior mask only inside the window region.
  const winSize = bbox.w * bbox.h;
  const mask = new Uint8Array(winSize);
  for (let yy = 0; yy < bbox.h; yy += 1) {
    const absY = bbox.y + yy;
    for (let xx = 0; xx < bbox.w; xx += 1) {
      const absX = bbox.x + xx;
      const i = (absY * w + absX) * 4;
      if (isSlotInteriorGrey(data[i], data[i + 1], data[i + 2])) {
        mask[yy * bbox.w + xx] = 1;
      }
    }
  }

  // Flood-fill connected components.
  const labels = new Int32Array(winSize);
  const components: Array<{ x0: number; y0: number; x1: number; y1: number; area: number }> = [];
  let nextLabel = 1;
  for (let yy = 0; yy < bbox.h; yy += 1) {
    for (let xx = 0; xx < bbox.w; xx += 1) {
      const off = yy * bbox.w + xx;
      if (mask[off] === 1 && labels[off] === 0) {
        components.push(floodFill(mask, labels, bbox.w, bbox.h, xx, yy, nextLabel));
        nextLabel += 1;
      }
    }
  }

  // Filter to plausible slots: rectangular-ish, area in the slot-size band.
  // We auto-size the slot footprint from the window: vanilla 176-logical
  // window has 16-logical slot interior, so slot side ~ windowW * 16/176
  // (~9% of window width).
  const expectedSide = bbox.w * (16 / 176);
  const minSide = Math.max(8, Math.round(expectedSide * 0.6));
  const maxSide = Math.round(expectedSide * 1.6);
  const minArea = minSide * minSide * 0.5;
  const maxArea = maxSide * maxSide * 1.2;

  const candidates: DiscoveredSlot[] = [];
  for (const c of components) {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    if (cw < minSide || ch < minSide) continue;
    if (cw > maxSide || ch > maxSide) continue;
    if (c.area < minArea || c.area > maxArea) continue;
    // Reject highly non-square components (lines / ribbons).
    if (Math.abs(cw - ch) > Math.max(2, expectedSide * 0.4)) continue;
    candidates.push({
      index: 0,
      cx: bbox.x + Math.round((c.x0 + c.x1) / 2),
      cy: bbox.y + Math.round((c.y0 + c.y1) / 2),
      x: bbox.x + c.x0,
      y: bbox.y + c.y0,
      w: cw,
      h: ch,
    });
  }
  if (candidates.length === 0) return null;

  // Overlap dedup: when two bboxes overlap significantly (e.g. armor
  // shield and chestplate icons being detected as separate components
  // inside the same slot, or item-icon contours nested inside the
  // slot frame), drop the SMALLER one and keep the OUTER. We score
  // overlap by intersection-over-union of the bboxes; anything >0.5
  // is a duplicate of the larger.
  {
    const bboxOf = (s: typeof candidates[0]) => ({ x0: s.x, y0: s.y, x1: s.x + s.w - 1, y1: s.y + s.h - 1, area: s.w * s.h });
    const drop = new Set<number>();
    for (let i = 0; i < candidates.length; i += 1) {
      if (drop.has(i)) continue;
      const a = bboxOf(candidates[i]);
      for (let j = i + 1; j < candidates.length; j += 1) {
        if (drop.has(j)) continue;
        const b = bboxOf(candidates[j]);
        const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0);
        const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1);
        if (ix1 < ix0 || iy1 < iy0) continue;
        const inter = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
        const union = a.area + b.area - inter;
        const iou = inter / union;
        if (iou > 0.5) {
          // Drop the smaller area; keep the larger (outer) bbox.
          if (a.area >= b.area) drop.add(j);
          else { drop.add(i); break; }
        }
      }
    }
    if (drop.size > 0) {
      const kept: typeof candidates = [];
      for (let i = 0; i < candidates.length; i += 1) if (!drop.has(i)) kept.push(candidates[i]);
      candidates.length = 0;
      for (const k of kept) candidates.push(k);
    }
  }

  // Raster-order by clustering slots into row groups using a tight cy
  // tolerance, then sorting each row by cx. The previous version
  // quantized cy by stride which mis-grouped neighboring slots that
  // straddled a stride boundary -- so the SoM badges came out in
  // jumbled order (e.g. hotbar reading 42, 40, 41, 43, ...) and the
  // agent could not reason about "the next slot to the right".
  // Wide tolerance: bbox cy can shift upward by several pixels when
  // an item icon occupies the slot, so a strict tolerance jumbles
  // neighboring slots in the same physical row.
  const ROW_TOL = Math.max(6, Math.round(expectedSide * 0.6));
  const sortedByY = [...candidates].sort((a, b) => a.cy - b.cy);
  const rows: Array<typeof sortedByY> = [];
  for (const s of sortedByY) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].cy - s.cy) <= ROW_TOL) last.push(s);
    else rows.push([s]);
  }
  for (const row of rows) row.sort((a, b) => a.cx - b.cx);
  const flattened = rows.flat();
  flattened.forEach((s, i) => { s.index = i; });
  // Mutate the original candidates array order to match for downstream consumers.
  candidates.length = 0;
  for (const s of flattened) candidates.push(s);

  return {
    windowX: bbox.x,
    windowY: bbox.y,
    windowW: bbox.w,
    windowH: bbox.h,
    slotPx: Math.round(expectedSide),
    slots: candidates,
    cursorOpenCenter: { x: Math.round(w / 2), y: Math.round(h / 2) },
  };
}

// =========================================================================
// Unified detection: discoverSlots + LogicalLayout matching.
// =========================================================================
import { ALL_LAYOUTS, slotScreenCenter, type LogicalLayout } from "./InventoryLayouts";

function aspect(w: number, h: number): number {
  return h === 0 ? 0 : w / h;
}

/** Score a candidate logical layout's plausibility for the discovered
 *  geometry. Lower score = better match. Returns +Infinity for layouts
 *  that don't match aspect/slot-count basics at all. */
function scoreLayout(disc: DiscoveredLayout, layout: LogicalLayout): number {
  // Cheap pre-filter: only reject layouts with grossly wrong window
  // aspect; let annotation + match-ratio scoring (see detectGuiLayout) do
  // the real selection. A scoreLayout return value of 0 means "passes
  // pre-filter, evaluate further".
  const aDisc = aspect(disc.windowW, disc.windowH);
  const aLayout = aspect(layout.windowW, layout.windowH);
  if (Math.abs(aDisc - aLayout) > 0.3) return Infinity;
  return 0;
}

/** Match discovered slots against a logical layout, then backfill any
 *  layout-known slots that CV missed (e.g. slots filled with items can
 *  darken past our detection threshold). Returns null on poor matches. */
function annotateWithLayout(
  disc: DiscoveredLayout,
  layout: LogicalLayout,
): GuiSlot[] | null {
  const scale = disc.windowW / layout.windowW;
  const layoutScreen = layout.slots.map((s) => ({
    name: s.name,
    role: s.role,
    p: slotScreenCenter(s, disc.windowX, disc.windowY, scale),
  }));
  const tolerance = Math.max(8, disc.slotPx * 0.7);

  // 1. Greedy nearest-neighbour: each discovered slot grabs the closest
  //    unused layout slot within tolerance.
  const matchedLayout = new Set<number>();
  const matched: Array<{ disc: DiscoveredSlot; layoutIdx: number; dist: number }> = [];
  const unmatched: DiscoveredSlot[] = [];
  for (const slot of disc.slots) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < layoutScreen.length; i += 1) {
      if (matchedLayout.has(i)) continue;
      const dx = layoutScreen[i].p.x - slot.cx;
      const dy = layoutScreen[i].p.y - slot.cy;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestDist <= tolerance) {
      matchedLayout.add(bestIdx);
      matched.push({ disc: slot, layoutIdx: bestIdx, dist: bestDist });
    } else {
      unmatched.push(slot);
    }
  }
  // Confidence: at least 50% of layout slots accounted for.
  if (matched.length < layout.slots.length * 0.5) return null;

  // 2. Backfill layout slots that no discovered component matched. This
  //    covers slots with items in them (icon darkens slot interior past
  //    our threshold) -- we still have the layout's pixel center.
  const out: GuiSlot[] = [];
  // Discovered + matched slots: keep CV centroid (anchored to actual
  // rendered slot pixels — more accurate than the template's predicted
  // position when window detection is even slightly off). Force the
  // bbox to FULL slot side so the SoM mark covers the whole slot
  // regardless of how much of the interior the connected component
  // managed to capture (item icons occlude most of the dark-grey
  // interior, shrinking the cv bbox).
  const slotPx = Math.max(8, Math.round(disc.slotPx));
  for (const m of matched) {
    out.push({
      index: 0,
      cx: m.disc.cx,
      cy: m.disc.cy,
      w: slotPx,
      h: slotPx,
      name: layoutScreen[m.layoutIdx].name,
      role: layoutScreen[m.layoutIdx].role,
    });
  }
  for (let i = 0; i < layoutScreen.length; i += 1) {
    if (matchedLayout.has(i)) continue;
    const ls = layoutScreen[i];
    out.push({
      index: 0,
      cx: ls.p.x,
      cy: ls.p.y,
      w: slotPx,
      h: slotPx,
      name: ls.name,
      role: ls.role,
    });
  }
  // Unmatched discovered components (probably spurious or modded extras):
  // keep them anonymous so the agent can still see them.
  for (const u of unmatched) {
    out.push({ index: 0, cx: u.cx, cy: u.cy, w: slotPx, h: slotPx });
  }
  // Unmatched discovered components (probably spurious or modded extras):
  // keep them anonymous so the agent can still see them.
  for (const u of unmatched) {
    out.push({ index: 0, cx: u.cx, cy: u.cy, w: u.w, h: u.h });
  }

  // 3. Re-sort raster order and re-index. Cluster by cy with a wider
  // tolerance because bbox cy can shift upward when an item icon
  // occupies the slot (the icon's bounding box pulls the centroid up
  // by ~3-5 px relative to an empty slot); a stride-based row
  // assignment then jumbles neighbors. ROW_TOL ~ 0.6 * slot side
  // tolerates that shift while still separating distinct physical rows.
  const ROW_TOL = Math.max(6, Math.round(disc.slotPx * 0.6));
  const sortedByY = [...out].sort((a, b) => a.cy - b.cy);
  const rows: Array<typeof sortedByY> = [];
  for (const s of sortedByY) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].cy - s.cy) <= ROW_TOL) last.push(s);
    else rows.push([s]);
  }
  for (const row of rows) row.sort((a, b) => a.cx - b.cx);
  out.length = 0;
  for (const s of rows.flat()) out.push(s);
  out.forEach((s, i) => { s.index = i; });

  return out;
}

/** Infer the regular grid pattern from discovered slots and fill in any
 *  positions that look like slots but the CV step missed (commonly because
 *  an item icon darkens the slot interior past our threshold).
 *
 *  Strategy:
 *  - Cluster cy values into row bands using the slot pixel stride.
 *  - For each row, cluster cx into columns and infer the column spacing.
 *  - For each (row, col) inside the window bounding box, if no slot is
 *    already present there, add a synthetic one at the predicted center.
 *
 *  This guarantees we never miss a slot just because it had an item in it,
 *  even for unknown/modded GUIs we have no LogicalLayout for. */
function fillGridGaps(disc: DiscoveredLayout): DiscoveredSlot[] {
  if (disc.slots.length < 3) return disc.slots;
  const stride = Math.max(8, Math.round(disc.slotPx * 1.1));
  const rowTol = Math.max(3, Math.round(stride * 0.4));
  const colTol = Math.max(3, Math.round(stride * 0.4));

  // Cluster by row Y.
  const rows: Array<{ cy: number; members: DiscoveredSlot[] }> = [];
  const sortedByY = [...disc.slots].sort((a, b) => a.cy - b.cy);
  for (const s of sortedByY) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(s.cy - last.cy) <= rowTol) {
      last.members.push(s);
      last.cy = (last.cy * (last.members.length - 1) + s.cy) / last.members.length;
    } else {
      rows.push({ cy: s.cy, members: [s] });
    }
  }

  const filled: DiscoveredSlot[] = [...disc.slots];
  for (const row of rows) {
    if (row.members.length < 2) continue;
    const colsByX = [...row.members].sort((a, b) => a.cx - b.cx);
    // Estimate column stride from neighbouring slots in this row.
    const diffs: number[] = [];
    for (let i = 1; i < colsByX.length; i += 1) {
      const d = colsByX[i].cx - colsByX[i - 1].cx;
      if (d > 4 && d < disc.windowW) diffs.push(d);
    }
    if (diffs.length === 0) continue;
    diffs.sort((a, b) => a - b);
    // Use the smallest non-trivial inter-slot distance as the col stride
    // (gaps between slots are multiples of this stride).
    const colStride = Math.round(diffs[0]);
    if (colStride < 8) continue;

    // Walk the row, fill any column gap whose center is inside the
    // window bbox.
    const minX = colsByX[0].cx;
    const maxX = colsByX[colsByX.length - 1].cx;
    for (let cx = minX; cx <= maxX; cx += colStride) {
      const exists = filled.some(
        (s) => Math.abs(s.cx - cx) <= colTol && Math.abs(s.cy - row.cy) <= rowTol,
      );
      if (exists) continue;
      // Within window bounds?
      if (cx < disc.windowX + 4 || cx > disc.windowX + disc.windowW - 4) continue;
      filled.push({
        index: 0,
        cx: Math.round(cx),
        cy: Math.round(row.cy),
        x: Math.round(cx - disc.slotPx / 2),
        y: Math.round(row.cy - disc.slotPx / 2),
        w: disc.slotPx,
        h: disc.slotPx,
      });
    }
  }
  return filled;
}

/** Adapter for the Dispatcher GUI gate. Returns slots[] or empty on any error.
 *  Uses discoverSlots internally -- pure CV, no layout assumption. */
export function detectGuiSlots(imageBase64: string): { slots: Array<{ index: number; cx?: number; cy?: number }> } {
  try {
    const result = discoverSlots(imageBase64);
    return { slots: result?.slots ?? [] };
  } catch {
    return { slots: [] };
  }
}

/** GENERAL DETECTION POLICY entry point.
 *  - Always runs CV slot discovery (works for any GUI).
 *  - Tries to promote raster indices to semantic names by matching
 *    aspect + slot-count + per-slot screen-distance against the known
 *    LogicalLayouts in InventoryLayouts.ts.
 *  - For unknown GUIs (no layout match), runs grid-gap fill to catch
 *    item-filled slots the CV missed.
 *  - Returns a GuiLayout that always has raster `index`+pixel center,
 *    plus optional `name`/`role` when the GUI was recognized.
 *  - Returns null when no inventory window is found (caller should fall
 *    through to the LLM-direct path).
 *
 *  `hintLayoutId` skips matching if you already know which GUI is open
 *  (e.g. from an open-window event or task text). */
export function detectGuiLayout(
  jpegBase64: string,
  hintLayoutId?: string,
): GuiLayout | null {
  const disc = discoverSlots(jpegBase64);
  if (!disc) return null;

  // Try the hinted layout first if given, else score all and pick best.
  let bestLayout: LogicalLayout | null = null;
  let bestSlots: GuiSlot[] | null = null;
  if (hintLayoutId) {
    const hinted = ALL_LAYOUTS.find((l) => l.id === hintLayoutId);
    if (hinted) {
      const annotated = annotateWithLayout(disc, hinted);
      if (annotated) {
        bestLayout = hinted;
        bestSlots = annotated;
      }
    }
  }
  if (!bestLayout) {
    // Score by how many of THIS LAYOUT's slots were actually matched
    // (not just by total slot count delta -- two layouts can both have
    // 41-46 slots but with totally different positions). Prefer the
    // layout with the highest match ratio; tie-break by fewer unmatched
    // discovered slots.
    let bestScore = Infinity;
    const debug = process.env.SLOT_DEBUG === "1";
    for (const layout of ALL_LAYOUTS) {
      const prefilter = scoreLayout(disc, layout);
      if (prefilter === Infinity) {
        if (debug) console.log(`  ${layout.id}: prefilter rejected`);
        continue;
      }
      const annotated = annotateWithLayout(disc, layout);
      if (!annotated) {
        if (debug) console.log(`  ${layout.id}: annotated rejected`);
        continue;
      }
      // Count how many slots have name (= matched to this layout's logical slots)
      const namedCount = annotated.filter((s) => s.name !== undefined).length;
      const matchRatio = namedCount / layout.slots.length;
      // Score: invert match ratio (so high ratio = low score) + small
      // penalty for excess detected components.
      const extras = Math.max(0, annotated.length - layout.slots.length);
      const score = (1 - matchRatio) * 1000 + extras * 2;
      if (debug) console.log(`  ${layout.id}: matched=${namedCount}/${layout.slots.length} (${(matchRatio * 100).toFixed(0)}%) extras=${extras} score=${score.toFixed(1)}`);
      if (score < bestScore) {
        bestScore = score;
        bestLayout = layout;
        bestSlots = annotated;
      }
    }
    if (debug) console.log(`  -> chose ${bestLayout?.id ?? "none"} score=${bestScore.toFixed(1)}`);
  }

  let slots: GuiSlot[];
  if (bestSlots) {
    slots = bestSlots;
  } else {
    // Unknown GUI: still try to recover missing slots from the discovered
    // grid pattern so item-filled slots aren't dropped.
    const filled = fillGridGaps(disc);
    const stride = Math.max(8, Math.round(disc.slotPx * 1.1));
    filled.sort((a, b) => {
      const ra = Math.round(a.cy / stride);
      const rb = Math.round(b.cy / stride);
      if (ra !== rb) return ra - rb;
      return a.cx - b.cx;
    });
    slots = filled.map((s, i) => ({ index: i, cx: s.cx, cy: s.cy, w: s.w, h: s.h }));
  }

  return {
    windowX: disc.windowX,
    windowY: disc.windowY,
    windowW: disc.windowW,
    windowH: disc.windowH,
    matchedLayoutId: bestLayout?.id ?? null,
    slots,
    cursorOpenCenter: disc.cursorOpenCenter,
  };
}
