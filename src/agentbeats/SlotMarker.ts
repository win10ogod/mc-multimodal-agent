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
const MARK_FG: RGBA = [255, 255, 0, 255];   // yellow (fully opaque digits)
const MARK_BG_ALPHA = 0.55;                  // semi-transparent backdrop -- item icon stays visible
const MARK_SCALE = 1;                        // tight: 3x5 glyph fits in slot corner
const MARK_CORNER_OFFSET = 7;                // shift from slot center toward top-left corner

function setPixel(buf: Buffer, w: number, x: number, y: number, color: RGBA): void {
  if (x < 0 || y < 0 || x >= w) return;
  const idx = (y * w + x) * 4;
  if (idx < 0 || idx + 3 >= buf.length) return;
  buf[idx] = color[0];
  buf[idx + 1] = color[1];
  buf[idx + 2] = color[2];
  buf[idx + 3] = color[3];
}

function fillRect(buf: Buffer, w: number, x0: number, y0: number, ww: number, hh: number, color: RGBA): void {
  for (let y = y0; y < y0 + hh; y += 1) {
    for (let x = x0; x < x0 + ww; x += 1) {
      setPixel(buf, w, x, y, color);
    }
  }
}

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

const MARK_FG_ALPHA = 0.85;  // digits at 85% opacity so item icon hints through

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

function drawNumber(buf: Buffer, w: number, h: number, centerX: number, centerY: number, num: number, scale: number): void {
  const text = String(num);
  const glyphsW = GLYPH_W * scale;
  const glyphsH = GLYPH_H * scale;
  // No inter-digit gap and no backdrop padding -- keep the badge as small
  // as possible so the underlying item icon stays visible. The semi-
  // transparent darken still goes BEHIND the digits for contrast.
  const totalW = text.length * glyphsW;
  let x = Math.round(centerX - MARK_CORNER_OFFSET);
  const y = Math.round(centerY - MARK_CORNER_OFFSET);
  darkenRect(buf, w, x, y, totalW, glyphsH, MARK_BG_ALPHA);
  for (const ch of text) {
    drawGlyph(buf, w, x, y, ch, scale);
    x += glyphsW;
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
 * Decode a base64 JPEG obs frame, run the unified GUI detector
 * (`detectGuiLayout`) to find every interactable slot at its actually
 * rendered pixel position, draw numbered marks at each, and return the
 * marked image plus the detected layout.
 *
 * Returns `layout: null` and an unmodified frame when no inventory window
 * is visible -- prevents painting bogus marks on a world-view obs.
 */
export function markInventoryFrame(jpegBase64: string): MarkedFrameResult {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const jpegBuf = Buffer.from(cleaned, "base64");
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const w = decoded.width;
  const h = decoded.height;
  const px = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);

  const layout = detectGuiLayout(cleaned);

  const drawn: number[] = [];
  if (layout) {
    for (const slot of layout.slots) {
      drawNumber(px, w, h, slot.cx, slot.cy, slot.index, MARK_SCALE);
      drawn.push(slot.index);
    }
  }

  // Re-encode as PNG (lossless so the marks remain crisp)
  const png = new PNG({ width: w, height: h });
  px.copy(png.data);
  const pngBuf = PNG.sync.write(png);
  return {
    pngBase64: pngBuf.toString("base64"),
    marks: drawn,
    layout,
  };
}
