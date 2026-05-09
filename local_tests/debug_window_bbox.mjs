// Debug: run detectGuiLayout on a saved frame and draw the resulting
// window bbox + every slot centre on top of the original image.
//
// Usage: node local_tests/debug_window_bbox.mjs <input_png_or_jpg> [output_png]
// Default input: most recent fastui_action_call PNG in the eval debug dir.

import fs from "node:fs";
import path from "node:path";
// pngjs comes from the agent's runtime deps; load via require to keep this
// script ESM-friendly without adding new dependencies.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const jpegLib = require("jpeg-js");

// Compile and load the agent's detector. We import the compiled JS from
// dist/ so we don't need to spin up tsc here. Run `npm run build` in
// mc-multimodal-agent first if dist is stale.
const distEntry = path.resolve("mc-multimodal-agent/dist/agentbeats/tools/SlotDetector.js");
if (!fs.existsSync(distEntry)) {
  console.error(`dist not found: ${distEntry}\n  run: cd mc-multimodal-agent && npm run build`);
  process.exit(1);
}
const SlotDetector = require(distEntry);

function decodeImage(buf, isPng) {
  if (isPng) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  return jpegLib.decode(buf, { useTArray: true, formatAsRGBA: true });
}

function drawRect(data, w, _h, x0, y0, x1, y1, [r, g, b], thickness = 2) {
  const stamp = (px, py) => {
    if (px < 0 || px >= w) return;
    const idx = (py * w + px) * 4;
    if (idx < 0 || idx + 3 >= data.length) return;
    data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
  };
  for (let t = 0; t < thickness; t += 1) {
    for (let x = x0; x <= x1; x += 1) { stamp(x, y0 + t); stamp(x, y1 - t); }
    for (let y = y0; y <= y1; y += 1) { stamp(x0 + t, y); stamp(x1 - t, y); }
  }
}

function drawCircle(data, w, _h, cx, cy, radius, [r, g, b]) {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const d2 = dx * dx + dy * dy;
      if (d2 < (radius - 0.5) * (radius - 0.5) || d2 > (radius + 0.5) * (radius + 0.5)) continue;
      const px = cx + dx, py = cy + dy;
      if (px < 0 || px >= w) continue;
      const idx = (py * w + px) * 4;
      if (idx < 0 || idx + 3 >= data.length) continue;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
    }
  }
}

const inputArg = process.argv[2] ?? (() => {
  const dir = "C:\\Users\\eddie\\AppData\\Local\\Temp\\mcu-eval\\debug";
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /fastui_action_call.*\.png$/.test(f) || /probe_input.*\.png$/.test(f));
  if (files.length === 0) return null;
  files.sort();
  return path.join(dir, files[files.length - 1]);
})();

if (!inputArg) { console.error("no input file"); process.exit(1); }
const outArg = process.argv[3] ?? path.resolve("debug_window_bbox.png");

const buf = fs.readFileSync(inputArg);
const isPng = buf[0] === 0x89 && buf[1] === 0x50;
const decoded = decodeImage(buf, isPng);
const w = decoded.width, h = decoded.height;
console.log(`input: ${inputArg}\nframe: ${w}x${h}, kind=${isPng ? "png" : "jpg"}`);

// detectGuiLayout's discoverSlots calls jpeg-js.decode internally — so
// it ONLY accepts JPEG bytes. If the input is a PNG (DebugRecorder
// converts JPEG obs frames to PNG with an R/B swap before saving),
// we re-encode the decoded RGBA as JPEG. The R/B swap that jpeg-js
// applies during decode (BGR-as-RGBA) cancels out when the JPEG was
// encoded from already-swapped RGBA data — so the agent's downstream
// isInventoryGrey check sees the original JPEG's true colours.
let b64;
if (isPng) {
  const jpegBuf = jpegLib.encode({ data: decoded.data, width: w, height: h }, 90).data;
  b64 = "data:image/jpeg;base64," + Buffer.from(jpegBuf).toString("base64");
} else {
  b64 = "data:image/jpeg;base64," + Buffer.from(buf).toString("base64");
}

const layout = SlotDetector.detectGuiLayout(b64);
if (!layout) { console.error("detectGuiLayout returned null"); process.exit(1); }
console.log(`matchedLayoutId: ${layout.matchedLayoutId}`);
console.log(`window: x=${layout.windowX} y=${layout.windowY} w=${layout.windowW} h=${layout.windowH}`);
console.log(`slots: ${layout.slots.length}`);

// Draw onto an RGBA copy.
const out = new PNG({ width: w, height: h });
out.data.set(decoded.data);

// Window bbox: bright magenta rectangle.
drawRect(
  out.data, w, h,
  layout.windowX, layout.windowY,
  layout.windowX + layout.windowW - 1, layout.windowY + layout.windowH - 1,
  [255, 0, 255], 2,
);

// Each slot centre: 3-px green ring.
for (const s of layout.slots) {
  drawCircle(out.data, w, h, Math.round(s.cx), Math.round(s.cy), 4, [0, 255, 0]);
}

fs.writeFileSync(outArg, PNG.sync.write(out));
console.log(`wrote ${outArg}`);
