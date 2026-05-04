// Render a zoomed view around the detected cursor so the user can
// visually confirm the detection matches the actual cursor pixel.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { detectGuiLayout, detectCursor } from "../dist/agentbeats/SlotDetector.js";

const inputPng = process.argv[2];
const outputPng = process.argv[3];
if (!inputPng || !outputPng) {
  console.error("usage: node test_cursor_zoom.mjs <input.png> <output.png>");
  process.exit(1);
}

const png = PNG.sync.read(readFileSync(inputPng));
const jpegBuf = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
const jpegB64 = jpegBuf.toString("base64");

const layout = detectGuiLayout(jpegB64);
const cursor = detectCursor(jpegB64, layout);
console.log(`window: TL=(${layout.windowX},${layout.windowY}) ${layout.windowW}x${layout.windowH}`);
console.log(`cursor: ${cursor ? `(${cursor.x},${cursor.y})` : "NOT FOUND"}`);

if (!cursor) process.exit(1);

// Crop a 60x60 region around the detected cursor and upscale 4x for visibility.
const w = png.width, h = png.height;
const inputBuf = Buffer.from(png.data);
const CROP = 30;
const SCALE = 4;
const cx0 = Math.max(0, Math.min(w - 2 * CROP, cursor.x - CROP));
const cy0 = Math.max(0, Math.min(h - 2 * CROP, cursor.y - CROP));

const outW = 2 * CROP * SCALE;
const outH = 2 * CROP * SCALE;
const outBuf = Buffer.alloc(outW * outH * 4);

for (let y = 0; y < 2 * CROP; y += 1) {
  for (let x = 0; x < 2 * CROP; x += 1) {
    const srcIdx = ((cy0 + y) * w + (cx0 + x)) * 4;
    const r = inputBuf[srcIdx];
    const g = inputBuf[srcIdx + 1];
    const b = inputBuf[srcIdx + 2];
    for (let dy = 0; dy < SCALE; dy += 1) {
      for (let dx = 0; dx < SCALE; dx += 1) {
        const dstIdx = ((y * SCALE + dy) * outW + (x * SCALE + dx)) * 4;
        outBuf[dstIdx] = r;
        outBuf[dstIdx + 1] = g;
        outBuf[dstIdx + 2] = b;
        outBuf[dstIdx + 3] = 255;
      }
    }
  }
}

// Draw a red crosshair at the detected cursor position (in output space).
const crossX = (cursor.x - cx0) * SCALE;
const crossY = (cursor.y - cy0) * SCALE;
function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= outW || y >= outH) return;
  const i = (y * outW + x) * 4;
  outBuf[i] = r; outBuf[i + 1] = g; outBuf[i + 2] = b; outBuf[i + 3] = 255;
}
for (let d = -SCALE * 6; d <= SCALE * 6; d += 1) {
  if (Math.abs(d) > SCALE) {
    setPx(crossX + d, crossY, 255, 0, 0);
    setPx(crossX, crossY + d, 255, 0, 0);
  }
}
// Small filled square at the exact center pixel
for (let dy = -1; dy <= 1; dy += 1) {
  for (let dx = -1; dx <= 1; dx += 1) {
    setPx(crossX + dx, crossY + dy, 255, 255, 0);
  }
}

const outPng = new PNG({ width: outW, height: outH });
outBuf.copy(outPng.data);
writeFileSync(outputPng, PNG.sync.write(outPng));
console.log(`zoom ${2 * CROP}x${2 * CROP} crop @ (${cx0},${cy0}) upscaled ${SCALE}x -> ${outW}x${outH}`);
console.log(`crosshair drawn at (${crossX},${crossY}) in output (= cursor (${cursor.x},${cursor.y}) in input)`);
