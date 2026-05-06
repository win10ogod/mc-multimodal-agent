/**
 * Standalone perception unit test.
 *
 * Loads one or two probe-input frames from disk and exercises the CV
 * components without docker, without LLM calls, without an eval loop.
 *
 * Usage:
 *   node local_tests/test_item_tracking.mjs <ocr-frame.png> [<live-frame.png>]
 *
 *   ocr-frame:  the frame at the time slot contents were OCR-confirmed.
 *               Each detected slot's pixel fingerprint is stored as if
 *               it had just been OCR'd.
 *   live-frame: a later frame to scan for disappearances. If omitted,
 *               we only print the ocr-frame's slot fingerprints.
 *
 * Output:
 *   - detected layout id + slot list
 *   - per-slot fingerprint at OCR time
 *   - (with live-frame) per-slot fingerprint NOW, distance to OCR
 *     fingerprint, stddev drop, and whether the 3-way disappear gate
 *     fires (distFromOcr>40 AND stddevDrop>30 AND live.stddev<30).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import jpegLib from "jpeg-js";

import {
  detectGuiLayout,
  samplePatchFingerprint,
} from "../dist/agentbeats/tools/SlotDetector.js";

function loadFrame(p) {
  const ext = path.extname(p).toLowerCase();
  const buf = fs.readFileSync(p);
  if (ext === ".png") {
    const png = PNG.sync.read(buf);
    // Return as base64-encoded JPEG so the existing detectors (which
    // expect base64 input) can decode it. We use a cheap re-encode.
    const jpegBuf = jpegLib.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
    return Buffer.from(jpegBuf).toString("base64");
  }
  return buf.toString("base64");
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("usage: node local_tests/test_item_tracking.mjs <ocr-frame.png|jpg> [<live-frame.png|jpg>]");
  process.exit(1);
}
const ocrFrame = loadFrame(args[0]);
const liveFrame = args[1] ? loadFrame(args[1]) : null;

const layout = detectGuiLayout(ocrFrame, undefined);
if (!layout) {
  console.error(`no GUI layout detected in ${args[0]}`);
  process.exit(2);
}
console.log(`Detected layout: ${layout.matchedLayoutId ?? "unknown"} | slots=${layout.slots.length} | window=${layout.windowX},${layout.windowY} ${layout.windowW}x${layout.windowH}`);

// Capture each slot's fingerprint as if just OCR-confirmed.
const memory = layout.slots.map((s) => ({
  index: s.index,
  name: s.name,
  cx: s.cx,
  cy: s.cy,
  fingerprint: samplePatchFingerprint(ocrFrame, s.cx, s.cy, 6),
}));

console.log("\n-- OCR-frame fingerprints --");
for (const m of memory) {
  if (!m.fingerprint) continue;
  console.log(`  slot ${m.index.toString().padStart(2)}${m.name ? `(${m.name})` : ""} pos=(${m.cx},${m.cy}) meanRGB=(${m.fingerprint.meanR.toFixed(0)},${m.fingerprint.meanG.toFixed(0)},${m.fingerprint.meanB.toFixed(0)}) stddev=${m.fingerprint.stddev.toFixed(1)}`);
}

if (!liveFrame) process.exit(0);

console.log("\n-- Live-frame disappearance scan --");
const liveLayout = detectGuiLayout(liveFrame, layout.matchedLayoutId);
if (!liveLayout) {
  console.error("no GUI layout detected in live frame");
  process.exit(3);
}

let disappeared = 0;
for (const s of liveLayout.slots) {
  const m = memory.find((mem) => Math.hypot(mem.cx - s.cx, mem.cy - s.cy) < 8);
  if (!m || !m.fingerprint) continue;
  const live = samplePatchFingerprint(liveFrame, s.cx, s.cy, 6);
  if (!live) continue;
  const dr = live.meanR - m.fingerprint.meanR;
  const dg = live.meanG - m.fingerprint.meanG;
  const db = live.meanB - m.fingerprint.meanB;
  const distFromOcr = Math.sqrt(dr * dr + dg * dg + db * db);
  const stddevDrop = m.fingerprint.stddev - live.stddev;
  const gateFires = distFromOcr > 40 && stddevDrop > 30 && live.stddev < 30;
  console.log(
    `  slot ${m.index.toString().padStart(2)}${m.name ? `(${m.name})` : ""} ` +
    `dist=${distFromOcr.toFixed(1)} stddevDrop=${stddevDrop.toFixed(1)} live.stddev=${live.stddev.toFixed(1)} ` +
    `${gateFires ? "→ DISAPPEARED" : ""}`,
  );
  if (gateFires) disappeared += 1;
}
console.log(`\nTotal slots flagged disappeared: ${disappeared}`);
