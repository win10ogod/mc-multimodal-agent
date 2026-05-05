/**
 * Pixel-level template matcher.
 *
 * Slides a small template image across an obs frame, computes the
 * normalized sum of squared RGB differences at every position, and
 * picks the lowest-error location as the match. Writes a verification
 * PNG with a magenta bbox at the match.
 *
 * Usage:
 *   node local_tests/template_match.mjs <frame.png> [<template.png>]
 *
 * Defaults: <template.png> = local_tests/fixtures/recipe_book_template.png
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const framePath = process.argv[2];
const tmplPath = process.argv[3] || path.resolve("data", "ui-templates", "recipe_book.png");
if (!framePath) {
  console.error("usage: node template_match.mjs <frame.png> [<template.png>]");
  process.exit(1);
}

const frame = PNG.sync.read(fs.readFileSync(framePath));
const tmpl = PNG.sync.read(fs.readFileSync(tmplPath));
const fw = frame.width, fh = frame.height;
const tw = tmpl.width, th = tmpl.height;
console.log(`frame ${fw}x${fh}  template ${tw}x${th}  -> ${(fw - tw + 1) * (fh - th + 1)} positions`);

if (tw > fw || th > fh) {
  console.error("template larger than frame");
  process.exit(2);
}

// SSD score per position. Lower = better. Skip alpha channel.
let bestScore = Infinity, bestX = 0, bestY = 0;
const fdata = frame.data, tdata = tmpl.data;
const tArea = tw * th;

for (let y = 0; y <= fh - th; y++) {
  for (let x = 0; x <= fw - tw; x++) {
    let sum = 0;
    // Sample every other pixel for speed (still 9*tArea/4 comparisons)
    for (let ty = 0; ty < th; ty += 2) {
      for (let tx = 0; tx < tw; tx += 2) {
        const fi = ((y + ty) * fw + (x + tx)) * 4;
        const ti = (ty * tw + tx) * 4;
        const dr = fdata[fi]   - tdata[ti];
        const dg = fdata[fi+1] - tdata[ti+1];
        const db = fdata[fi+2] - tdata[ti+2];
        sum += dr*dr + dg*dg + db*db;
        if (sum > bestScore) break; // early-exit (poor man's branch-and-bound)
      }
      if (sum > bestScore) break;
    }
    if (sum < bestScore) {
      bestScore = sum; bestX = x; bestY = y;
    }
  }
}

const cx = bestX + Math.floor(tw / 2);
const cy = bestY + Math.floor(th / 2);
const norm = bestScore / (tArea / 4); // average squared diff per sampled pixel * 3 channels
console.log(`match: (${cx},${cy})  bbox=(${bestX},${bestY})..(${bestX+tw},${bestY+th})  score=${bestScore}  norm=${norm.toFixed(1)}`);

// Plot magenta bbox on a copy of the frame
const out = new PNG({ width: fw, height: fh });
fdata.copy(out.data);
const drawPx = (x, y, R, G, B) => {
  if (x < 0 || y < 0 || x >= fw || y >= fh) return;
  const i = (y * fw + x) * 4;
  out.data[i]   = R; out.data[i+1] = G; out.data[i+2] = B; out.data[i+3] = 255;
};
const stroke = (x0, y0, ww, hh, R, G, B) => {
  for (let x = x0; x < x0 + ww; x++) { drawPx(x, y0, R, G, B); drawPx(x, y0 + hh - 1, R, G, B); }
  for (let y = y0; y < y0 + hh; y++) { drawPx(x0, y, R, G, B); drawPx(x0 + ww - 1, y, R, G, B); }
};
// Match bbox in MAGENTA, expand 1 px
stroke(bestX - 1, bestY - 1, tw + 2, th + 2, 255, 0, 255);
stroke(bestX - 2, bestY - 2, tw + 4, th + 4, 255, 0, 255);

// Persistent matches dir alongside the eval debug dir, so verification
// images survive when we wipe debug between runs.
import os from "node:os";
const matchesDir = process.env.MCU_MATCHES_DIR
  ?? (process.env.AGENTBEATS_DEBUG_DIR
       ? path.resolve(process.env.AGENTBEATS_DEBUG_DIR, "..", "matches")
       : path.join(os.tmpdir(), "mcu-eval", "matches"));
fs.mkdirSync(matchesDir, { recursive: true });
const outPath = path.join(matchesDir, path.basename(framePath).replace(/\.png$/i, ".match.png"));
fs.writeFileSync(outPath, PNG.sync.write(out));
console.log(`verification: ${outPath}`);
