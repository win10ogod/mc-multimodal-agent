#!/usr/bin/env node
// Offline verification of the cursorHolding detector.
//
// Loads every probe-input frame from a debug dir, treats the FIRST frame as
// the empty-cursor baseline, then runs the same pixel-diff detector against
// every later frame. Each later frame is also empty (per ground truth: the
// last eval bailed before any pickup), so a correct detector returns
// holding=false on ALL of them.
//
// Usage: node verify_cursor_holding.mjs [debugDir] [--cursor-relative]

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const debugDir = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : "C:/Users/eddie/AppData/Local/Temp/mcu-eval/debug";
const cursorRelative = process.argv.includes("--cursor-relative");

// Parameters from runClosedLoopStep
const PARK_X = 421, PARK_Y = 108;
const HELD_OFF = 8;
const SIZE = 14;
const HALF = Math.floor(SIZE / 2);
const BG_LUM_MAX = 60;
const PX_DIST_THR = 24;
const HOLDING_FG_THR = 30;

function loadRGBA(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { w: png.width, h: png.height, data: png.data };
}

// Cursor template match: the cursor sprite has a unique shape — tip at top-
// left, extends down-right ~12x16. Find it by searching for the brightest
// (lum>240) connected blob. For the verify harness we approximate by finding
// the centroid of pixels with lum>200 in the upper-right quadrant of the frame
// (cursor in our scenario parks near x~421, y~108 so search a window around it).
// Find cursor tip: search a tight window around PARK (the cursor parks
// here after the inventory open + park-step block runs). Tip = topmost-
// leftmost bright pixel that ALSO has bright neighbours below+right
// (rules out isolated noise / SoM badges).
function findCursorTip(img) {
  const x0 = 410, y0 = 100, x1 = 445, y1 = 130;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const off = (y * img.w + x) * 4;
      const lum = 0.299*img.data[off] + 0.587*img.data[off+1] + 0.114*img.data[off+2];
      if (lum < 240) continue;
      const off2 = ((y + 1) * img.w + (x + 1)) * 4;
      const lum2 = 0.299*img.data[off2] + 0.587*img.data[off2+1] + 0.114*img.data[off2+2];
      if (lum2 > 240) return { x, y };
    }
  }
  return null;
}

function samplePatch(img, cx, cy) {
  const x0 = cx - HALF, y0 = cy - HALF;
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x0 + x, py = y0 + y;
      const oOut = (y * SIZE + x) * 4;
      if (px < 0 || py < 0 || px >= img.w || py >= img.h) {
        out[oOut] = out[oOut+1] = out[oOut+2] = 0; out[oOut+3] = 255; continue;
      }
      const oIn = (py * img.w + px) * 4;
      out[oOut] = img.data[oIn];
      out[oOut+1] = img.data[oIn+1];
      out[oOut+2] = img.data[oIn+2];
      out[oOut+3] = 255;
    }
  }
  return out;
}

function lumOf(rgba, off) {
  return 0.299 * rgba[off] + 0.587 * rgba[off+1] + 0.114 * rgba[off+2];
}

function detect(baseline, live) {
  let pixelDiffFg = 0;
  let bgMasked = 0, spriteShifts = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const off = i * 4;
    const lumB = lumOf(baseline, off);
    const lumL = lumOf(live, off);
    if (lumL < BG_LUM_MAX && lumB < BG_LUM_MAX) { bgMasked++; continue; }
    const dr = live[off] - baseline[off];
    const dg = live[off+1] - baseline[off+1];
    const db = live[off+2] - baseline[off+2];
    const d = Math.sqrt(dr*dr + dg*dg + db*db);
    if (d > PX_DIST_THR) {
      pixelDiffFg++;
      // Sprite-shift: one is bright, the other is BG-dark
      if ((lumB > 200 && lumL < 60) || (lumL > 200 && lumB < 60)) spriteShifts++;
    }
  }
  return { pixelDiffFg, bgMasked, spriteShifts, holding: pixelDiffFg > HOLDING_FG_THR };
}

const files = fs.readdirSync(debugDir)
  .filter(f => /probe_input\.png$|fastui_action_\d+_input\.png$|fastui_planner_\d+_input\.png$/.test(f))
  .sort();

if (files.length < 2) { console.error(`need >=2 frames in ${debugDir}, got ${files.length}`); process.exit(1); }

console.log(`Sample mode: ${cursorRelative ? "CURSOR-RELATIVE (cursor.x+8, cursor.y+8)" : "FIXED (PARK_X+8, PARK_Y+8)"}`);
console.log(`Threshold: pixelDiffFg > ${HOLDING_FG_THR} ⇒ holding=true`);
console.log("");

const baselineImg = loadRGBA(path.join(debugDir, files[0]));
const baselineCursor = findCursorTip(baselineImg);
console.log(`Baseline: ${files[0]}  cursorTip=${baselineCursor ? `(${baselineCursor.x},${baselineCursor.y})` : "NOT FOUND"}`);

const baseCx = cursorRelative && baselineCursor ? baselineCursor.x + HELD_OFF : PARK_X + HELD_OFF;
const baseCy = cursorRelative && baselineCursor ? baselineCursor.y + HELD_OFF : PARK_Y + HELD_OFF;
const baselinePatch = samplePatch(baselineImg, baseCx, baseCy);

let truePos = 0, trueNeg = 0, falsePos = 0;
console.log("");
console.log("frame                              cursor           pixelDiffFg  bgMasked  spriteShifts  holding");
console.log("-".repeat(105));
for (const f of files) {
  const img = loadRGBA(path.join(debugDir, f));
  const cur = findCursorTip(img);
  const cx = cursorRelative && cur ? cur.x + HELD_OFF : PARK_X + HELD_OFF;
  const cy = cursorRelative && cur ? cur.y + HELD_OFF : PARK_Y + HELD_OFF;
  const live = samplePatch(img, cx, cy);
  const r = detect(baselinePatch, live);
  const tag = r.holding ? "HOLDING" : "empty";
  // Ground truth: empty (eval bailed before any pickup)
  if (r.holding) falsePos++; else trueNeg++;
  const curStr = cur ? `(${cur.x},${cur.y})` : "no-cursor";
  console.log(`${f.padEnd(36)} ${curStr.padEnd(14)}  ${String(r.pixelDiffFg).padStart(4)}        ${String(r.bgMasked).padStart(3)}      ${String(r.spriteShifts).padStart(3)}          ${tag}`);
}
console.log("");
console.log(`SUMMARY: ${trueNeg}/${files.length} correct (empty), ${falsePos}/${files.length} false-positive (holding)`);
