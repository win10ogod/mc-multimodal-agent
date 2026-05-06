/**
 * Diagnose why cobblestone fails detection in resolver_00001_raw.png.
 * Loads the PNG directly (no JPEG re-encode noise), samples the
 * fingerprint at every hotbar position with multiple sample sizes,
 * and reports what each isFilled branch decides.
 *
 * Usage:
 *   node local_tests/diagnose_cob.mjs <png>
 */
import * as fs from "node:fs";
import { PNG } from "pngjs";

const png = PNG.sync.read(fs.readFileSync(process.argv[2]));
const { width: w, height: h, data } = png;

function samplePatch(cx, cy, half) {
  let n = 0, sumR = 0, sumG = 0, sumB = 0;
  const pixels = [];
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
  const mR = sumR / n, mG = sumG / n, mB = sumB / n;
  let varSum = 0;
  for (const [r, g, b] of pixels) {
    const dr = r - mR, dg = g - mG, db = b - mB;
    varSum += dr * dr + dg * dg + db * db;
  }
  return { mR, mG, mB, stddev: Math.sqrt(varSum / n), n };
}
const chroma = (fp) => Math.max(fp.mR, fp.mG, fp.mB) - Math.min(fp.mR, fp.mG, fp.mB);

function classify(fp, role = "hotbar") {
  const c = chroma(fp);
  const lum = (fp.mR + fp.mG + fp.mB) / 3;
  if (c > 25) return `FILLED (chroma>25)`;
  const isItemSlot = role === "hotbar" || role === "main_inv" || role === "craft_2x2" || role === "craft_3x3" || role === "result";
  if (!isItemSlot) return `empty (non-item-slot, requires chroma>25)`;
  if (c > 12 && fp.stddev > 18) return `FILLED (chroma>12 + stddev>18)`;
  if (Math.abs(lum - 139) > 30 && fp.stddev > 18) return `FILLED (grey-textured: lum-dist=${Math.abs(lum-139).toFixed(0)})`;
  return `empty`;
}

// Hotbar slot positions per the runtime layout (events.jsonl iteration 0).
// All cy=247 in this run.
const HOTBAR = [
  { name: "hotbar_0", cx: 248, cy: 247 },
  { name: "hotbar_1", cx: 266, cy: 247 },
  { name: "hotbar_2", cx: 284, cy: 247 },
  { name: "hotbar_3", cx: 302, cy: 247 },
  { name: "hotbar_4", cx: 320, cy: 247 },
  { name: "hotbar_5", cx: 338, cy: 247 },
  { name: "hotbar_6", cx: 356, cy: 247 },
  { name: "hotbar_7", cx: 374, cy: 247 },
  { name: "hotbar_8", cx: 392, cy: 247 },
];

console.log(`Image: ${w}x${h}`);
console.log("");
console.log("name      pos        size3     size6     size8     verdict(size6)");
console.log("--------  --------   ----      ----      ----      -------");
for (const s of HOTBAR) {
  const fps = [3, 6, 8].map((half) => samplePatch(s.cx, s.cy, half));
  const fmt = (fp) => fp ? `(${Math.round(fp.mR).toString().padStart(3)},${Math.round(fp.mG).toString().padStart(3)},${Math.round(fp.mB).toString().padStart(3)}) c=${chroma(fp).toFixed(1).padStart(4)} sd=${fp.stddev.toFixed(0).padStart(2)}` : "-";
  console.log(`${s.name}  (${s.cx},${s.cy})  ${fmt(fps[0])}   ${fmt(fps[1])}   ${fmt(fps[2])}   ${fps[1] ? classify(fps[1]) : "?"}`);
}

// Also scan vertically around hotbar_0 to find where cob actually is
console.log("");
console.log(`Vertical scan around hotbar_0 (cx=248) at varying cy:`);
for (let dy = -8; dy <= 8; dy += 2) {
  const fp = samplePatch(248, 247 + dy, 6);
  if (!fp) continue;
  const c = chroma(fp);
  console.log(`  cy=${247+dy}: rgb=(${Math.round(fp.mR)},${Math.round(fp.mG)},${Math.round(fp.mB)}) chroma=${c.toFixed(1)} stddev=${fp.stddev.toFixed(0)}`);
}
