// Offline verification test: load saved click frames and check if we can
// detect (a) cursor position and (b) whether the target slot's contents
// changed between pre-click and post-click frames.
//
// usage: node test_click_verify.mjs <frame_dir>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import path from "node:path";
import { detectGuiLayout, detectCursor } from "../dist/agentbeats/SlotDetector.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node test_click_verify.mjs <frame_dir>");
  process.exit(1);
}

// Sample a 12x12 patch centered on (cx, cy). Returns mean RGB + stddev.
function patchFingerprint(rgba, w, h, cx, cy, size = 12) {
  const half = Math.floor(size / 2);
  let n = 0, sumR = 0, sumG = 0, sumB = 0;
  const pixels = [];
  for (let dy = -half; dy < half; dy += 1) {
    for (let dx = -half; dx < half; dx += 1) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      pixels.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
      sumR += rgba[i]; sumG += rgba[i + 1]; sumB += rgba[i + 2];
      n += 1;
    }
  }
  const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
  let varSum = 0;
  for (const [r, g, b] of pixels) {
    const dr = r - meanR, dg = g - meanG, db = b - meanB;
    varSum += dr * dr + dg * dg + db * db;
  }
  const stddev = Math.sqrt(varSum / n);
  return { meanR, meanG, meanB, stddev };
}

function fingerprintDistance(a, b) {
  return Math.hypot(a.meanR - b.meanR, a.meanG - b.meanG, a.meanB - b.meanB) +
         Math.abs(a.stddev - b.stddev);
}

const files = readdirSync(dir).filter((f) => f.startsWith("f_") && f.endsWith(".png")).sort();
console.log(`found ${files.length} frames in ${dir}`);

// Simulate session-locked layout: detect from FIRST frame, reuse for all
// subsequent frames. This matches the runtime closed-loop behavior.
let sessionLayout = null;
const data = [];
for (const f of files) {
  const png = PNG.sync.read(readFileSync(path.join(dir, f)));
  const jpegBuf = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
  const b64 = jpegBuf.toString("base64");
  const liveLayout = detectGuiLayout(b64, sessionLayout?.matchedLayoutId ?? undefined);
  if (sessionLayout === null && liveLayout) sessionLayout = liveLayout;
  const cursor = liveLayout ? detectCursor(b64, liveLayout) : null;
  data.push({ frame: parseInt(f.match(/\d+/)[0], 10), file: f, png, layout: sessionLayout, liveLayout, cursor });
}

console.log(`\nsession layout: ${sessionLayout?.matchedLayoutId ?? "unknown"} (${sessionLayout?.slots.length ?? 0} slots)`);

console.log("\n=== cursor detection per frame ===");
for (const d of data) {
  const c = d.cursor ? `(${d.cursor.x},${d.cursor.y})` : "NOT FOUND";
  const live = d.liveLayout ? `live=${d.liveLayout.slots.length}` : "no live";
  console.log(`  frame ${d.frame.toString().padStart(3)}: cursor=${c}  ${live}`);
}

// For each click-step (8, 12, 17), compare hotbar_0 / craft_2x2_0 / craft_2x2_result patch BEFORE vs AFTER
const probes = [
  { step: 8,  slotName: "hotbar_0",          expect: "should_empty" },  // pickup -> slot becomes empty
  { step: 12, slotName: "craft_2x2_0",       expect: "should_fill" },   // place  -> slot becomes filled
  { step: 17, slotName: "craft_2x2_result",  expect: "should_empty" },  // take   -> result becomes empty
];

console.log("\n=== click verification probes ===");
for (const p of probes) {
  const pre  = data.find((d) => d.frame === p.step - 1);
  const post = data.find((d) => d.frame === p.step + 1);
  if (!pre || !post || !pre.layout || !post.layout) {
    console.log(`  step=${p.step} ${p.slotName}: missing pre/post frames`);
    continue;
  }
  const preSlot  = pre.layout.slots.find((s) => s.name === p.slotName);
  const postSlot = post.layout.slots.find((s) => s.name === p.slotName);
  if (!preSlot || !postSlot) {
    console.log(`  step=${p.step} ${p.slotName}: slot not found in layout`);
    continue;
  }
  const preFP  = patchFingerprint(pre.png.data,  pre.png.width,  pre.png.height,  preSlot.cx,  preSlot.cy);
  const postFP = patchFingerprint(post.png.data, post.png.width, post.png.height, postSlot.cx, postSlot.cy);
  const dist = fingerprintDistance(preFP, postFP);
  const verdict = dist > 8 ? "CHANGED" : "unchanged";
  console.log(
    `  step=${p.step} ${p.slotName.padEnd(20)} expect=${p.expect}  pre stddev=${preFP.stddev.toFixed(1)}  post stddev=${postFP.stddev.toFixed(1)}  dist=${dist.toFixed(1)} -> ${verdict}`,
  );
}
