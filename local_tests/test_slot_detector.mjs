// Detect inventory window + slot grid in a real obs frame, render marks at
// the DETECTED slot positions, save out the result for visual verification.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { detectInventoryLayout, detectedSlotPixel } from "../dist/agentbeats/SlotDetector.js";

const inputPng = process.argv[2];
const outputPng = process.argv[3];
if (!inputPng || !outputPng) {
  console.error("usage: node test_slot_detector.mjs <input.png> <output.png>");
  process.exit(1);
}

// Load PNG -> raw RGBA -> encode JPEG (matches obs format)
const png = PNG.sync.read(readFileSync(inputPng));
const jpegBuf = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
const layout = detectInventoryLayout(jpegBuf.toString("base64"));
if (!layout) {
  console.error("inventory NOT detected");
  process.exit(2);
}
console.log("window:", { x: layout.windowX, y: layout.windowY, w: layout.windowW, h: layout.windowH, scale: layout.scale.toFixed(3) });
console.log("hotbar[0]:", layout.hotbar[0], "hotbar[8]:", layout.hotbar[8]);
console.log("mainInv[0] (top-left):", layout.mainInv[0], "mainInv[26] (bot-right):", layout.mainInv[26]);
console.log("craft2x2[0]:", layout.craft2x2[0], "craft2x2[3] (BR):", layout.craft2x2[3]);
console.log("result:", layout.craft2x2Result);

// Draw a tiny crosshair + label at every slot center
const w = png.width, h = png.height;
const buf = Buffer.from(png.data);
function pix(x, y, c) { if (x<0||y<0||x>=w||y>=h) return; const i=(y*w+x)*4; buf[i]=c[0]; buf[i+1]=c[1]; buf[i+2]=c[2]; buf[i+3]=255; }
function cross(x, y, color) {
  for (let d = -2; d <= 2; d += 1) { pix(x + d, y, color); pix(x, y + d, color); }
}
const RED = [255, 0, 0];
const YELLOW = [255, 255, 0];
const GREEN = [0, 255, 0];
const CYAN = [0, 200, 255];
for (let i = 0; i <= 40; i += 1) {
  const p = detectedSlotPixel(layout, i);
  if (!p) continue;
  const c = i <= 8 ? RED : i <= 35 ? YELLOW : i === 40 ? CYAN : GREEN;
  cross(p.x, p.y, c);
}
// Window bbox outline
for (let x = layout.windowX; x < layout.windowX + layout.windowW; x += 1) {
  pix(x, layout.windowY, [0, 255, 0]);
  pix(x, layout.windowY + layout.windowH - 1, [0, 255, 0]);
}
for (let y = layout.windowY; y < layout.windowY + layout.windowH; y += 1) {
  pix(layout.windowX, y, [0, 255, 0]);
  pix(layout.windowX + layout.windowW - 1, y, [0, 255, 0]);
}

const out = new PNG({ width: w, height: h });
buf.copy(out.data);
writeFileSync(outputPng, PNG.sync.write(out));
console.log("wrote", outputPng);
