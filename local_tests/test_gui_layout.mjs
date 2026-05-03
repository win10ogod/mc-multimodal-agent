// Test the unified detectGuiLayout: discoverSlots + LogicalLayout match.
// Prints what was detected and renders an annotated PNG so the user can
// visually confirm.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { detectGuiLayout } from "../dist/agentbeats/SlotDetector.js";

const inputPng = process.argv[2];
const outputPng = process.argv[3];
if (!inputPng || !outputPng) {
  console.error("usage: node test_gui_layout.mjs <input.png> <output.png>");
  process.exit(1);
}

// Load PNG -> raw RGBA -> encode as JPEG (matching obs format)
const png = PNG.sync.read(readFileSync(inputPng));
const jpegBuf = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
const jpegB64 = jpegBuf.toString("base64");

const t0 = Date.now();
const layout = detectGuiLayout(jpegB64);
const t1 = Date.now();

if (!layout) {
  console.error("no GUI layout detected (no window or no slots)");
  process.exit(1);
}

console.log(`detected in ${t1 - t0}ms: ${layout.slots.length} slots, matchedLayoutId=${layout.matchedLayoutId}`);
console.log(`window: TL=(${layout.windowX},${layout.windowY}) size=${layout.windowW}x${layout.windowH}`);
const named = layout.slots.filter((s) => s.name).length;
console.log(`semantic-named slots: ${named}/${layout.slots.length}`);
for (const s of layout.slots) {
  const tag = s.name ? `${s.name} (${s.role})` : `slot_${s.index}`;
  console.log(`  [${s.index.toString().padStart(2)}] (${s.cx},${s.cy}) ${s.w}x${s.h}  ${tag}`);
}

// --- Render annotation ---
const w = png.width;
const h = png.height;
const buf = Buffer.from(png.data);

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
function drawSlot(slot) {
  // Outline the bounding box
  for (let dx = 0; dx < slot.w; dx += 1) {
    setPx(slot.cx - Math.floor(slot.w / 2) + dx, slot.cy - Math.floor(slot.h / 2), 0, 255, 0);
    setPx(slot.cx - Math.floor(slot.w / 2) + dx, slot.cy + Math.ceil(slot.h / 2), 0, 255, 0);
  }
  for (let dy = 0; dy < slot.h; dy += 1) {
    setPx(slot.cx - Math.floor(slot.w / 2), slot.cy - Math.floor(slot.h / 2) + dy, 0, 255, 0);
    setPx(slot.cx + Math.ceil(slot.w / 2), slot.cy - Math.floor(slot.h / 2) + dy, 0, 255, 0);
  }
  // Index number top-left of slot
  const num = String(slot.index);
  let tx = slot.cx - 6;
  const ty = slot.cy - 6;
  for (let dy = -1; dy <= 5; dy += 1) {
    for (let dx = -1; dx <= num.length * 4; dx += 1) setPx(tx + dx, ty + dy, 0, 0, 0);
  }
  for (const ch of num) {
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
for (const slot of layout.slots) drawSlot(slot);

const outPng = new PNG({ width: w, height: h });
buf.copy(outPng.data);
writeFileSync(outputPng, PNG.sync.write(outPng));
console.log(`wrote ${outputPng}`);
