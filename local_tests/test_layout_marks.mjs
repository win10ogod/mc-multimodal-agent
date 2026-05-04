// Render the slot positions of a named LogicalLayout against a sample
// obs frame, so we can visually confirm the metadata is correct.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { LAYOUTS_BY_ID, slotScreenCenter } from "../dist/agentbeats/InventoryLayouts.js";

const inputPng = process.argv[2];
const outputPng = process.argv[3];
const layoutId = process.argv[4] ?? "player_inventory";
if (!inputPng || !outputPng) {
  console.error("usage: node test_layout_marks.mjs <input.png> <output.png> [layoutId]");
  process.exit(1);
}
const layout = LAYOUTS_BY_ID[layoutId];
if (!layout) {
  console.error(`unknown layoutId ${layoutId}; known: ${Object.keys(LAYOUTS_BY_ID).join(", ")}`);
  process.exit(1);
}

// Load PNG -> raw RGBA
const png = PNG.sync.read(readFileSync(inputPng));
const w = png.width;
const h = png.height;
const buf = Buffer.from(png.data);

// Detect window via grey mask (mirror SlotDetector.findWindowBBox).
function isInventoryGrey(r, g, b) {
  if (r < 175 || r > 215) return false;
  if (g < 175 || g > 215) return false;
  if (b < 175 || b > 215) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min <= 12;
}
const rowGrey = new Int32Array(h);
const colGrey = new Int32Array(w);
for (let y = 0; y < h; y += 1) {
  for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4;
    if (isInventoryGrey(buf[i], buf[i + 1], buf[i + 2])) {
      rowGrey[y] += 1;
      colGrey[x] += 1;
    }
  }
}
const ROW_THR = Math.floor(w * 0.18);
const COL_THR = Math.floor(h * 0.18);
let yTop = -1, yBot = -1, xLeft = -1, xRight = -1;
for (let y = 0; y < h; y += 1) if (rowGrey[y] >= ROW_THR) { yTop = y; break; }
for (let y = h - 1; y >= 0; y -= 1) if (rowGrey[y] >= ROW_THR) { yBot = y; break; }
for (let x = 0; x < w; x += 1) if (colGrey[x] >= COL_THR) { xLeft = x; break; }
for (let x = w - 1; x >= 0; x -= 1) if (colGrey[x] >= COL_THR) { xRight = x; break; }
const winX = xLeft, winY = yTop, winW = xRight - xLeft + 1, winH = yBot - yTop + 1;
console.log(`window: TL=(${winX},${winY}) size=${winW}x${winH}`);
const scale = winW / layout.windowW;
console.log(`layout=${layout.id} (${layout.slots.length} slots) scale=${scale.toFixed(3)}`);

// Draw a magenta ring + small index text at each slot center.
const FONT_3X5 = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111], "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111], "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001], "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111], "7": [0b111, 0b001, 0b010, 0b010, 0b010],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111], "9": [0b111, 0b101, 0b111, 0b001, 0b111],
};
function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
}
function drawMark(cx, cy, num) {
  // Magenta filled square 3x3 at center, then black-on-magenta digits to right
  for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) setPx(cx + dx, cy + dy, 255, 0, 255);
  const text = String(num);
  let tx = cx + 3;
  const ty = cy - 2;
  // Backdrop
  for (let dy = -1; dy <= 5; dy += 1) {
    for (let dx = -1; dx <= text.length * 4; dx += 1) setPx(tx + dx, ty + dy, 0, 0, 0);
  }
  for (const ch of text) {
    const g = FONT_3X5[ch];
    for (let r = 0; r < 5; r += 1) {
      const bits = g[r];
      for (let c = 0; c < 3; c += 1) {
        if ((bits >> (2 - c)) & 1) setPx(tx + c, ty + r, 255, 255, 0);
      }
    }
    tx += 4;
  }
}

layout.slots.forEach((slot, idx) => {
  const p = slotScreenCenter(slot, winX, winY, scale);
  drawMark(p.x, p.y, idx);
});

// Encode PNG
const outPng = new PNG({ width: w, height: h });
buf.copy(outPng.data);
writeFileSync(outputPng, PNG.sync.write(outPng));
console.log(`wrote ${outputPng}`);
