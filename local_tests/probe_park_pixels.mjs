#!/usr/bin/env node
// Dump pixel values around the cursor-park sample region for two
// consecutive probe frames so we can characterise what the BG noise +
// cursor sprite + held-icon area actually looks like.
//
// Usage: node probe_park_pixels.mjs <debugDir> [imgFile1] [imgFile2]
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const debugDir = process.argv[2] || "C:/Users/eddie/AppData/Local/Temp/mcu-eval/debug";
const files = process.argv.slice(3);
const list = files.length > 0 ? files : fs.readdirSync(debugDir).filter(f => f.endsWith("_probe_input.png")).sort();

if (list.length === 0) { console.error("no probe_input PNGs found"); process.exit(1); }

// Park spot per runClosedLoopStep: PARK_X = min(632, windowX+windowW+16), PARK_Y = windowY+8.
// windowX/Y/W/H not stored in events.jsonl directly; player_inventory window is roughly
// x in [232..408], y in [100..256]. So PARK_X = min(632, 408+16) = 424. PARK_Y = 108.
// The sample is at (PARK_X+8, PARK_Y+8) = (432, 116), 14x14.
// BUT memory says PARK_X = 632 in the actual log -- runtime computes it from the LIVE
// detected layout. Let me sample BOTH possibilities.
//
// Update: log shows "park step=2/16: cursor=(387,115) -> (421,108)" — target is (421,108).
// So PARK_X=421, PARK_Y=108. Sample region center = (429, 116).

const PARK_X = 421, PARK_Y = 108;
const HELD_X = PARK_X + 8, HELD_Y = PARK_Y + 8;
const SIZE = 14;
const HALF = Math.floor(SIZE / 2);

function loadRGBA(file) {
  const buf = fs.readFileSync(file);
  const png = PNG.sync.read(buf);
  return { w: png.width, h: png.height, data: png.data };
}

function samplePatch(img, cx, cy) {
  const x0 = Math.max(0, cx - HALF), y0 = Math.max(0, cy - HALF);
  const out = [];
  for (let y = 0; y < SIZE; y++) {
    const row = [];
    for (let x = 0; x < SIZE; x++) {
      const px = x0 + x, py = y0 + y;
      if (px >= img.w || py >= img.h) { row.push("___"); continue; }
      const off = (py * img.w + px) * 4;
      const r = img.data[off], g = img.data[off+1], b = img.data[off+2];
      const lum = Math.round(0.299*r + 0.587*g + 0.114*b);
      row.push(`${String(lum).padStart(3,"0")}`);
    }
    out.push(row.join(" "));
  }
  return out;
}

console.log(`PARK=(${PARK_X},${PARK_Y}) sample center=(${HELD_X},${HELD_Y}) size=${SIZE}`);
console.log("");

for (const f of list) {
  const full = path.join(debugDir, f);
  if (!fs.existsSync(full)) continue;
  const img = loadRGBA(full);
  console.log(`=== ${f} (${img.w}x${img.h}) ===`);
  console.log("luminance grid (each cell = 0..255):");
  const rows = samplePatch(img, HELD_X, HELD_Y);
  for (const r of rows) console.log("  " + r);

  // Stats
  let sum=0, sumSq=0, n=0, lo=255, hi=0;
  const x0 = HELD_X - HALF, y0 = HELD_Y - HALF;
  for (let y=0; y<SIZE; y++) {
    for (let x=0; x<SIZE; x++) {
      const px = x0+x, py = y0+y;
      if (px<0||py<0||px>=img.w||py>=img.h) continue;
      const off = (py*img.w+px)*4;
      const lum = 0.299*img.data[off] + 0.587*img.data[off+1] + 0.114*img.data[off+2];
      sum += lum; sumSq += lum*lum; n++;
      if (lum<lo) lo=lum; if (lum>hi) hi=lum;
    }
  }
  const mean = sum/n, std = Math.sqrt(sumSq/n - mean*mean);
  console.log(`  stats: n=${n} mean=${mean.toFixed(1)} std=${std.toFixed(1)} range=[${lo.toFixed(0)}..${hi.toFixed(0)}]`);
  console.log("");
}
