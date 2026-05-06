/**
 * Programmatic scan for non-grey UI elements outside the detected
 * inventory window — used to locate the recipe-book toggle button
 * pattern without needing a human to read the image.
 *
 * Usage: node local_tests/scan_recipe_button.mjs <path-to-png>
 *
 * Output: window bbox; then per-blob centroid + dominant RGB + size.
 */
import fs from "node:fs";
import { PNG } from "pngjs";

const path = process.argv[2];
if (!path) { console.error("usage: node scan_recipe_button.mjs <png>"); process.exit(1); }
const png = PNG.sync.read(fs.readFileSync(path));
const { width: w, height: h, data } = png;
const idx = (x, y) => (y * w + x) * 4;
const isNeutralGrey = (r, g, b, lo, hi, tol) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min <= tol && r >= lo && r <= hi;
};

// 1) Replicate the detector's window-mass scan: light-grey ~198 ±15
const ROW_PX_THRESH = 0.6;
const colMass = new Array(w).fill(0);
const rowMass = new Array(h).fill(0);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = idx(x, y);
    if (isNeutralGrey(data[i], data[i+1], data[i+2], 180, 215, 12)) {
      colMass[x] += 1; rowMass[y] += 1;
    }
  }
}
const colThresh = Math.max(20, Math.floor(h * 0.15));
const rowThresh = Math.max(20, Math.floor(w * 0.15));
let wx0 = w, wx1 = 0, wy0 = h, wy1 = 0;
for (let x = 0; x < w; x++) if (colMass[x] >= colThresh) { wx0 = Math.min(wx0, x); wx1 = Math.max(wx1, x); }
for (let y = 0; y < h; y++) if (rowMass[y] >= rowThresh) { wy0 = Math.min(wy0, y); wy1 = Math.max(wy1, y); }
console.log(`window bbox: x=[${wx0}..${wx1}] y=[${wy0}..${wy1}] (${wx1-wx0}x${wy1-wy0})`);

// 2) Scan ALL non-grey blobs in the entire frame (so we can find the
//    recipe-book button regardless of which GUI it belongs to: player
//    inv, furnace, brewing, anvil, etc.). Filter blobs to small UI
//    button-sized clusters.
const scanX0 = 0, scanX1 = w, scanY0 = 0, scanY1 = h;
console.log(`scan band: full frame ${w}x${h}`);

const visited = new Uint8Array(w * h);
const blobs = [];
for (let y = scanY0; y < scanY1; y++) {
  for (let x = scanX0; x < scanX1; x++) {
    if (visited[y*w+x]) continue;
    const i = idx(x, y);
    const r = data[i], g = data[i+1], b = data[i+2];
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const sat = max - min;
    if (sat < 30) continue;                 // too neutral
    const lum = (r + g + b) / 3;
    if (lum < 50 || lum > 240) continue;    // too dark/bright
    // Flood fill
    const stack = [[x, y]];
    let pix = 0, sumR = 0, sumG = 0, sumB = 0;
    let bx0 = x, bx1 = x, by0 = y, by1 = y;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const k = cy*w+cx;
      if (visited[k]) continue;
      const ii = idx(cx, cy);
      const cr = data[ii], cg = data[ii+1], cb = data[ii+2];
      const cmax = Math.max(cr,cg,cb), cmin = Math.min(cr,cg,cb);
      if (cmax - cmin < 20) continue;       // grey -> stop expanding
      visited[k] = 1;
      pix += 1; sumR += cr; sumG += cg; sumB += cb;
      bx0 = Math.min(bx0, cx); bx1 = Math.max(bx1, cx);
      by0 = Math.min(by0, cy); by1 = Math.max(by1, cy);
      if (cx > 0) stack.push([cx-1, cy]);
      if (cx < w-1) stack.push([cx+1, cy]);
      if (cy > 0) stack.push([cx, cy-1]);
      if (cy < h-1) stack.push([cx, cy+1]);
    }
    if (pix >= 6 && pix <= 600) {
      blobs.push({ pix, cx: Math.round((bx0+bx1)/2), cy: Math.round((by0+by1)/2),
                   bbox: [bx0, by0, bx1-bx0+1, by1-by0+1],
                   meanR: sumR/pix|0, meanG: sumG/pix|0, meanB: sumB/pix|0 });
    }
  }
}
blobs.sort((a, b) => b.pix - a.pix);
console.log(`\nblobs found in scan band (sorted by pixel count, top 8):`);
for (const b of blobs.slice(0, 8)) {
  console.log(`  pix=${String(b.pix).padStart(4)} center=(${b.cx},${b.cy}) bbox=${b.bbox.join("x")} rgb=(${b.meanR},${b.meanG},${b.meanB})`);
}

// 3) Recipe-book heuristic: a green book icon (G clearly dominant
//    over R and B, mid brightness) within a small button-sized blob
//    (10..22 px each side) anywhere inside or on the window mass.
// Helper: count near-white pixels in a thin border ring around a bbox
const countWhiteBorder = (bx, by, bw, bh, expand = 2) => {
  let total = 0, white = 0;
  const inWhite = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = idx(x, y);
    return data[i] > 200 && data[i+1] > 200 && data[i+2] > 200;
  };
  // Top + bottom edges (with expand)
  for (let dx = -expand; dx < bw + expand; dx++) {
    if (inWhite(bx+dx, by-expand)) white++; total++;
    if (inWhite(bx+dx, by+bh+expand-1)) white++; total++;
  }
  for (let dy = -expand; dy < bh + expand; dy++) {
    if (inWhite(bx-expand, by+dy)) white++; total++;
    if (inWhite(bx+bw+expand-1, by+dy)) white++; total++;
  }
  return white / total;
};

const bookCandidates = blobs.filter((b) => {
  const [bx, by, bw, bh] = b.bbox;
  const greenDominant = b.meanG > b.meanR + 25 && b.meanG > b.meanB + 25 && b.meanG > 100 && b.meanG < 220;
  const buttonSized = bw >= 8 && bw <= 22 && bh >= 6 && bh <= 22;
  const insideOrEdge = bx >= wx0 - 8 && bx + bw <= wx1 + 8 && by >= wy0 - 8 && by + bh <= wy1 + 8;
  if (!(greenDominant && buttonSized && insideOrEdge)) return false;
  // Recipe button has a white-ish frame around it, distinguishing it from
  // slot items (which sit on grey ~139 backgrounds).
  const whiteBorderFrac = countWhiteBorder(bx, by, bw, bh, 2);
  b.whiteFrac = whiteBorderFrac;
  return whiteBorderFrac >= 0.35;
});
console.log(`\nrecipe-book candidates (green book + white frame):`);
for (const b of bookCandidates.slice(0, 5)) {
  console.log(`  pix=${String(b.pix).padStart(4)} center=(${b.cx},${b.cy}) bbox=${b.bbox.join("x")} rgb=(${b.meanR},${b.meanG},${b.meanB}) whiteFrac=${b.whiteFrac.toFixed(2)}`);
}

// 4) Plot found candidates back on the image with a magenta bbox so the
//    user can visually confirm. Save as <input>.recipe_scan.png next to
//    the source.
const out = new PNG({ width: w, height: h });
data.copy(out.data);
const stroke = (x0, y0, ww, hh, R, G, B) => {
  const drawPx = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y*w+x)*4;
    out.data[i] = R; out.data[i+1] = G; out.data[i+2] = B; out.data[i+3] = 255;
  };
  for (let x = x0; x < x0+ww; x++) { drawPx(x, y0); drawPx(x, y0+hh-1); }
  for (let y = y0; y < y0+hh; y++) { drawPx(x0, y); drawPx(x0+ww-1, y); }
};
// Window bbox in CYAN
stroke(wx0, wy0, wx1-wx0+1, wy1-wy0+1, 0, 255, 255);
// Recipe-book candidates only, in MAGENTA (loud)
for (const b of bookCandidates) stroke(b.bbox[0]-1, b.bbox[1]-1, b.bbox[2]+2, b.bbox[3]+2, 255, 0, 255);
// Persistent matches dir alongside the eval debug dir.
import path2 from "node:path";
import os from "node:os";
const matchesDir = process.env.MCU_MATCHES_DIR
  ?? (process.env.AGENTBEATS_DEBUG_DIR
       ? path2.resolve(process.env.AGENTBEATS_DEBUG_DIR, "..", "matches")
       : path2.join(os.tmpdir(), "mcu-eval", "matches"));
fs.mkdirSync(matchesDir, { recursive: true });
const outPath = path2.join(matchesDir, path2.basename(path).replace(/\.png$/, ".recipe_scan.png"));
fs.writeFileSync(outPath, PNG.sync.write(out));
console.log(`\nverification image written: ${outPath}`);
