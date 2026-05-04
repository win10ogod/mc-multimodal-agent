/* Verify shape-matching cursor detection on a saved obs frame.
 * Runs detectGuiLayout + detectCursor + (legacy) detectCursorCandidates
 * and renders a marked image showing what we picked vs all candidates. */
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  detectCursor,
  detectCursorCandidates,
  detectGuiLayout,
} from "../dist/agentbeats/SlotDetector.js";

const inFile = process.argv[2] ?? "C:/Users/eddie/AppData/Local/Temp/sample_obs.jpg";
const outFile = process.argv[3] ?? "C:/Users/eddie/AppData/Local/Temp/mcu-eval/cursor_shape_test.png";

const buf = fs.readFileSync(inFile);
const b64 = buf.toString("base64");
const layout = detectGuiLayout(b64);
if (!layout) { console.error("no layout detected"); process.exit(1); }
console.log(`layout: ${layout.matchedLayoutId ?? "unknown"} window=${layout.windowX},${layout.windowY} ${layout.windowW}x${layout.windowH} slots=${layout.slots.length}`);

const cursor = detectCursor(b64, layout);
const candidates = detectCursorCandidates(b64, layout);
console.log("picked cursor:", cursor);
console.log("all candidates (largest 10 by area):", candidates.sort((a,b)=>b.area-a.area).slice(0,10));

// Render: draw bright outlined marker at picked cursor, then 4x zoom
// the whole frame so the marker is readable.
const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
const w = decoded.width, h = decoded.height;
const px = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);

function drawOutlinedRect(x0, y0, x1, y1, color) {
  const setPx = (x, y, c) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
  };
  for (let x = x0; x <= x1; x += 1) { setPx(x, y0, color); setPx(x, y1, color); }
  for (let y = y0; y <= y1; y += 1) { setPx(x0, y, color); setPx(x1, y, color); }
}

if (cursor) {
  drawOutlinedRect(cursor.x - 8, cursor.y - 8, cursor.x + 8, cursor.y + 8, [255, 0, 0]);
  drawOutlinedRect(cursor.x - 9, cursor.y - 9, cursor.x + 9, cursor.y + 9, [255, 0, 0]);
  drawOutlinedRect(cursor.x - 10, cursor.y - 10, cursor.x + 10, cursor.y + 10, [255, 0, 0]);
}

// 3x nearest-neighbor zoom for visibility.
const ZOOM = 3;
const zw = w * ZOOM, zh = h * ZOOM;
const zoomed = Buffer.alloc(zw * zh * 4);
for (let y = 0; y < zh; y += 1) {
  for (let x = 0; x < zw; x += 1) {
    const sx = Math.floor(x / ZOOM), sy = Math.floor(y / ZOOM);
    const s = (sy * w + sx) * 4;
    const d = (y * zw + x) * 4;
    zoomed[d] = px[s]; zoomed[d+1] = px[s+1]; zoomed[d+2] = px[s+2]; zoomed[d+3] = 255;
  }
}

const png = new PNG({ width: zw, height: zh });
zoomed.copy(png.data);
fs.writeFileSync(outFile, PNG.sync.write(png));
console.log(`wrote ${outFile} (cursor at ${cursor ? `(${cursor.x},${cursor.y})` : "null"})`);
