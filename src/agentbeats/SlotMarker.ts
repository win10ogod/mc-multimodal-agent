/**
 * Set-of-Mark renderer: takes a base64 JPEG of the inventory frame, draws
 * numbered badges at the pixel center of each known slot, and returns the
 * marked image as a base64 PNG for the VLM. Pure JS; relies on jpeg-js for
 * decode and pngjs for encode (both already deps).
 *
 * Numbering convention matches UiFastControl.slotIndexToPixel:
 *   0..8   hotbar
 *   9..35  main inventory (3 rows of 9)
 *   36..39 craft 2x2 grid
 *   40     craft 2x2 result
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { slotIndexToPixel } from "./UiFastControl";
import { detectInventoryLayout, type DetectedLayout } from "./SlotDetector";

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

function drawGlyph(buf: Buffer, w: number, originX: number, originY: number, char: string, scale: number): void {
  const glyph = FONT_3X5[char];
  if (!glyph) return;
  for (let row = 0; row < GLYPH_H; row += 1) {
    const bits = glyph[row];
    for (let col = 0; col < GLYPH_W; col += 1) {
      // bit at column `col` from MSB -> shift = (GLYPH_W - 1 - col)
      const on = ((bits >> (GLYPH_W - 1 - col)) & 1) === 1;
      if (!on) continue;
      fillRect(buf, w, originX + col * scale, originY + row * scale, scale, scale, MARK_FG);
    }
  }
}

function drawNumber(buf: Buffer, w: number, h: number, centerX: number, centerY: number, num: number, scale: number): void {
  const text = String(num);
  const glyphsW = GLYPH_W * scale;
  const glyphsH = GLYPH_H * scale;
  const gap = scale; // 1px (scaled) between digits
  const totalW = text.length * glyphsW + (text.length - 1) * gap;
  // Place the label in the top-left corner of the slot so the item icon
  // (centered in the slot) remains visible.
  let x = Math.round(centerX - MARK_CORNER_OFFSET);
  const y = Math.round(centerY - MARK_CORNER_OFFSET);
  // Semi-transparent backdrop: darkens the underlying item icon for contrast
  // without fully hiding it.
  darkenRect(buf, w, x - 1, y - 1, totalW + 2, glyphsH + 2, MARK_BG_ALPHA);
  for (const ch of text) {
    drawGlyph(buf, w, x, y, ch, scale);
    x += glyphsW + gap;
  }
  void h;
}

export type MarkedFrameResult = {
  /** Base64-encoded PNG (no data: prefix). */
  pngBase64: string;
  /** The slot indices we actually drew marks for. */
  marks: number[];
  /** Detected inventory layout used for label placement (null if detection
   *  failed; in that case the static fallback layout was used). */
  layout: DetectedLayout | null;
};

/**
 * Decode a base64 JPEG inventory frame, run the CV inventory-window
 * detector to find slot pixel centers, draw numbered marks at each, and
 * return a base64 PNG. If detection fails, fall back to the static slot
 * coordinate table.
 */
export function markInventoryFrame(jpegBase64: string, slotIndices?: number[]): MarkedFrameResult {
  const cleaned = jpegBase64.startsWith("data:image/")
    ? jpegBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegBase64;
  const jpegBuf = Buffer.from(cleaned, "base64");
  const decoded = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: true });
  const w = decoded.width;
  const h = decoded.height;
  // jpeg.decode returns Uint8Array; convert to Buffer for our pixel ops
  const px = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);

  // Run CV detection so labels track the actual rendered slot positions.
  // If the inventory window isn't detected (likely the GUI isn't actually
  // open in this frame), skip drawing entirely -- we'd otherwise paint
  // bogus labels on top of the world view.
  const layout = detectInventoryLayout(cleaned);

  const slots = slotIndices ?? Array.from({ length: 41 }, (_, i) => i);
  const drawn: number[] = [];
  if (layout) {
    for (const idx of slots) {
      const pos = slotIndexToPixel(idx, layout);
      if (!pos) continue;
      drawNumber(px, w, h, pos.x, pos.y, idx, MARK_SCALE);
      drawn.push(idx);
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
