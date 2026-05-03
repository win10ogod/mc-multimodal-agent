// Verify SlotDetector.detectCursor returns the right pixel for a frame
// where the cursor is visible. Renders a marker at the detected position
// so the user can confirm visually.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { detectGuiLayout, detectCursor, detectCursorCandidates } from "../dist/agentbeats/SlotDetector.js";

const inputPng = process.argv[2];
const outputPng = process.argv[3];
if (!inputPng || !outputPng) {
  console.error("usage: node test_cursor.mjs <input.png> <output.png>");
  process.exit(1);
}

const png = PNG.sync.read(readFileSync(inputPng));
const jpegBuf = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
const jpegB64 = jpegBuf.toString("base64");

const layout = detectGuiLayout(jpegB64);
if (!layout) { console.error("no layout"); process.exit(1); }
console.log(`window: TL=(${layout.windowX},${layout.windowY}) ${layout.windowW}x${layout.windowH}`);

const t0 = Date.now();
const cursor = detectCursor(jpegB64, layout);
console.log(`cursor: ${cursor ? `(${cursor.x},${cursor.y})` : "NOT FOUND"} in ${Date.now() - t0}ms`);

const candidates = detectCursorCandidates(jpegB64, layout);
console.log(`white components: ${candidates.length}`);
for (const c of candidates.slice(0, 10)) {
  console.log(`  area=${c.area} bbox=${c.w}x${c.h} center=(${c.x},${c.y})`);
}

// Render a red crosshair at detected cursor + green dot at expected
// (hotbar 0 in the frame is where Oak Log tooltip is showing).
const w = png.width;
const h = png.height;
const buf = Buffer.from(png.data);

function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
}

if (cursor) {
  // Red crosshair at detected cursor
  for (let d = -8; d <= 8; d += 1) {
    setPx(cursor.x + d, cursor.y, 255, 0, 0);
    setPx(cursor.x, cursor.y + d, 255, 0, 0);
  }
}
// Mark every layout slot center with a small blue dot
for (const s of layout.slots) {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      setPx(s.cx + dx, s.cy + dy, 0, 100, 255);
    }
  }
}

const outPng = new PNG({ width: w, height: h });
buf.copy(outPng.data);
writeFileSync(outputPng, PNG.sync.write(outPng));
console.log(`wrote ${outputPng}`);
