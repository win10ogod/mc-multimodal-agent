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

// Render: draw red dot at picked cursor, yellow dots at other candidates.
const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
const w = decoded.width, h = decoded.height;
const px = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);

function drawCross(x, y, color, size = 5) {
  for (let dy = -size; dy <= size; dy += 1) {
    for (let dx = -size; dx <= size; dx += 1) {
      if (Math.abs(dx) > 1 && Math.abs(dy) > 1) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = (ny * w + nx) * 4;
      px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2];
    }
  }
}

for (const c of candidates) {
  drawCross(c.x, c.y, [255, 255, 0], 3);
}
if (cursor) drawCross(cursor.x, cursor.y, [255, 0, 0], 6);

const png = new PNG({ width: w, height: h });
px.copy(png.data);
fs.writeFileSync(outFile, PNG.sync.write(png));
console.log(`wrote ${outFile}`);
