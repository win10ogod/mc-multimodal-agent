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
const WIN_LOGICAL_H = 166;
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

  // Raster-order by row band, then x. Row band = quantize cy to slot stride.
  const stride = Math.max(8, Math.round(expectedSide * 1.1));
  candidates.sort((a, b) => {
    const ra = Math.round(a.cy / stride);
    const rb = Math.round(b.cy / stride);
    if (ra !== rb) return ra - rb;
    return a.cx - b.cx;
  });
  candidates.forEach((s, i) => { s.index = i; });

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
