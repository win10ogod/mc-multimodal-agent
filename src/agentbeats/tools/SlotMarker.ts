/**
 * Set-of-Mark renderer.
 *
 * Takes a base64 JPEG of an obs frame, runs the unified GUI detector to
 * find the actual rendered slot positions in this frame, draws numbered
 * yellow badges at each slot center, and returns the marked image plus
 * the detected layout. Pure JS; uses jpeg-js for decode and pngjs for
 * encode (both already deps).
 *
 * Numbering matches the GuiLayout's raster order (top-to-bottom by row
 * band, left-to-right within each row). Same indices the VLM sees on
 * the marks are passed back to the cursor compiler so a click lands at
 * the SAME slot the VLM picked.
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { detectGuiLayout, type GuiLayout } from "./SlotDetector";

// 3x5 bitmap font for digits 0-9 (rows = 5, cols = 3).
// Each row's bits are MSB-first across the 3 columns.
// Compact enough to render legibly at 1-2x scale on a 640x360 frame.
const FONT_3X5: Record<string, number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b010, 0b010, 0b010],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
};
const GLYPH_W = 3;
const GLYPH_H = 5;

type RGBA = [number, number, number, number];
const MARK_FG: RGBA = [255, 255, 0, 255];   // yellow base color (digits)
const MARK_BBOX: RGBA = [120, 255, 120, 255]; // light green slot outline
const MARK_BG_ALPHA = 0.35;                  // grey wash behind the digits for contrast
const MARK_FG_ALPHA = 0.85;                  // digits mostly opaque (top-left, doesn't cover item center)
const MARK_BBOX_ALPHA = 0.5;                 // bbox stroke 50% so item icon edges still hint through
const MARK_SCALE = 1;                        // 3x5 glyph footprint - small, fits comfortably in slot corner
const MARK_DIGIT_GAP = 1;                    // pixels between adjacent digits

/** Darken a rectangle by mixing each pixel toward black using `alpha` (0..1).
 *  This keeps the underlying item icon visible while improving contrast for
 *  the foreground text drawn on top. */
function darkenRect(buf: Buffer, w: number, x0: number, y0: number, ww: number, hh: number, alpha: number): void {
  const inv = 1 - alpha;
  for (let y = y0; y < y0 + hh; y += 1) {
    for (let x = x0; x < x0 + ww; x += 1) {
      if (x < 0 || y < 0 || x >= w) continue;
      const idx = (y * w + x) * 4;
      if (idx < 0 || idx + 3 >= buf.length) continue;
      buf[idx] = Math.round(buf[idx] * inv);
      buf[idx + 1] = Math.round(buf[idx + 1] * inv);
      buf[idx + 2] = Math.round(buf[idx + 2] * inv);
      // alpha channel stays opaque
    }
  }
}

/** Blend each pixel of a rectangle toward `color` by `alpha` (0..1). Lets
 *  the digit show clearly while the item icon underneath stays partially
 *  visible. */
function blendRect(buf: Buffer, w: number, x0: number, y0: number, ww: number, hh: number, color: RGBA, alpha: number): void {
  const inv = 1 - alpha;
  for (let y = y0; y < y0 + hh; y += 1) {
    for (let x = x0; x < x0 + ww; x += 1) {
      if (x < 0 || y < 0 || x >= w) continue;
      const idx = (y * w + x) * 4;
      if (idx < 0 || idx + 3 >= buf.length) continue;
      buf[idx]     = Math.round(buf[idx]     * inv + color[0] * alpha);
      buf[idx + 1] = Math.round(buf[idx + 1] * inv + color[1] * alpha);
      buf[idx + 2] = Math.round(buf[idx + 2] * inv + color[2] * alpha);
    }
  }
}

function drawGlyph(buf: Buffer, w: number, originX: number, originY: number, char: string, scale: number): void {
  const glyph = FONT_3X5[char];
  if (!glyph) return;
  for (let row = 0; row < GLYPH_H; row += 1) {
    const bits = glyph[row];
    for (let col = 0; col < GLYPH_W; col += 1) {
      const on = ((bits >> (GLYPH_W - 1 - col)) & 1) === 1;
      if (!on) continue;
      blendRect(buf, w, originX + col * scale, originY + row * scale, scale, scale, MARK_FG, MARK_FG_ALPHA);
    }
  }
}

/** 1px alpha-blended rectangle outline. */
function strokeRect(buf: Buffer, w: number, x0: number, y0: number, ww: number, hh: number, color: RGBA, alpha: number): void {
  // top + bottom edges
  blendRect(buf, w, x0,             y0,           ww, 1, color, alpha);
  blendRect(buf, w, x0,             y0 + hh - 1,  ww, 1, color, alpha);
  // left + right edges
  blendRect(buf, w, x0,             y0,           1,  hh, color, alpha);
  blendRect(buf, w, x0 + ww - 1,    y0,           1,  hh, color, alpha);
}

/**
 * Draw a slot mark: a light-green semi-transparent bbox outline around
 * the slot, with the index drawn as digits in the slot's TOP-LEFT corner
 * (over a small darken wash for contrast). The slot center stays clear
 * so the item icon underneath remains visible.
 */
function drawSlotMark(
  buf: Buffer,
  w: number,
  h: number,
  slot: { cx: number; cy: number; w: number; h: number },
  num: number,
  scale: number,
): void {
  // 1. Light green slot bbox outline
  const halfW = Math.max(6, Math.round(slot.w / 2));
  const halfH = Math.max(6, Math.round(slot.h / 2));
  const bx = slot.cx - halfW;
  const by = slot.cy - halfH;
  strokeRect(buf, w, bx, by, halfW * 2, halfH * 2, MARK_BBOX, MARK_BBOX_ALPHA);

  // 2. Digits at the slot's top-left corner. No backdrop padding -- darken
  //    is exactly the digit footprint to keep the mark as small as possible.
  const text = String(num);
  const glyphsW = GLYPH_W * scale;
  const glyphsH = GLYPH_H * scale;
  const totalW = text.length * glyphsW + Math.max(0, text.length - 1) * MARK_DIGIT_GAP;
  const x0 = bx + 1;
  const y0 = by + 1;
  darkenRect(buf, w, x0, y0, totalW, glyphsH, MARK_BG_ALPHA);
  let x = x0;
  for (const ch of text) {
    drawGlyph(buf, w, x, y0, ch, scale);
    x += glyphsW + MARK_DIGIT_GAP;
  }
  void h;
}

export type MarkedFrameResult = {
  /** Base64-encoded PNG (no data: prefix). */
  pngBase64: string;
  /** Slot indices we actually drew marks for (raster order from GuiLayout). */
  marks: number[];
  /** Detected GuiLayout (CV-discovered + optionally layout-matched) used to
   *  place the marks. Null if no inventory window was visible in this frame
   *  -- in that case no marks are drawn and the caller should treat this
   *  obs as world-view rather than running a probe. */
  layout: GuiLayout | null;
};

/**
 * Decode a base64 JPEG obs frame and draw numbered slot marks.
 *
 * If `sessionLayout` is provided, the marks are placed at the SESSION-
 * LOCKED slot positions (stable across all frames in a UI session) — the
 * agent and the VLM see the same indices at the same pixels for the
 * entire session. If null, the function falls back to per-frame
 * detection via `detectGuiLayout` (used for the first frame to capture
 * a session layout).
 *
 * Returns `layout: null` when no inventory window is visible -- prevents
 * painting bogus marks on a world-view obs.
 */
export function markInventoryFrame(jpegBase64: string, sessionLayout?: GuiLayout | null): MarkedFrameResult {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const jpegBuf = Buffer.from(cleaned, "base64");
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const w = decoded.width;
  const h = decoded.height;
  const px = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);

  // Prefer the session-locked layout (stable marks across frames). Only
  // run fresh detection when the caller hasn't supplied one.
  const layout = sessionLayout ?? detectGuiLayout(cleaned);

  const drawn: number[] = [];
  if (layout) {
    for (const slot of layout.slots) {
      drawSlotMark(px, w, h, slot, slot.index, MARK_SCALE);
      drawn.push(slot.index);
    }
  }

  // Re-encode as PNG. jpeg-js with formatAsRGBA:true already returns
  // real RGBA — copy through directly. (Earlier code did an R↔B swap
  // that produced blue-tinted Alex hair under current jpeg-js;
  // removed.)
  const png = new PNG({ width: w, height: h });
  png.data.set(px);
  const pngBuf = PNG.sync.write(png);
  return {
    pngBase64: pngBuf.toString("base64"),
    marks: drawn,
    layout,
  };
}
