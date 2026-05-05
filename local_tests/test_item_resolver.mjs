/**
 * End-to-end test of the per-frame CV item resolver added to
 * runClosedLoopStep.ts. Replicates the production logic standalone.
 *
 * Stage 1 (init frame): for every detected slot that classifies as
 * filled by isFilled(), capture {item_label, fp} as if just OCR'd.
 *
 * Stage 2 (live frame): for each tracked item, find the slot in the
 * live frame whose current fp best matches (filtered through isFilled
 * to skip empty / armor-ghost slots). Items with no match → on cursor.
 *
 * Usage:
 *   node local_tests/test_item_resolver.mjs <init.png> <live.png>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import jpegLib from "jpeg-js";

import {
  detectGuiLayout,
  detectCursorWithExpectation,
  samplePatchFingerprint,
  samplePatchDHash,
  dHashDistance,
} from "../dist/agentbeats/tools/SlotDetector.js";

function loadFrame(p) {
  const ext = path.extname(p).toLowerCase();
  const buf = fs.readFileSync(p);
  if (ext === ".png") {
    const png = PNG.sync.read(buf);
    const jpegBuf = jpegLib.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
    return Buffer.from(jpegBuf).toString("base64");
  }
  return buf.toString("base64");
}

const chroma = (fp) => Math.max(fp.meanR, fp.meanG, fp.meanB) - Math.min(fp.meanR, fp.meanG, fp.meanB);
const fpDist = (a, b) => Math.hypot(a.meanR - b.meanR, a.meanG - b.meanG, a.meanB - b.meanB);

function isFilled(fp) {
  if (chroma(fp) > 12) return true;
  const lum = (fp.meanR + fp.meanG + fp.meanB) / 3;
  if (Math.abs(lum - 139) > 30 && fp.stddev > 18 && fp.stddev < 60) return true;
  return false;
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: node local_tests/test_item_resolver.mjs <init.png> <live.png>");
  process.exit(1);
}
const initFrame = loadFrame(args[0]);
const liveFrame = loadFrame(args[1]);

// ---- Stage 1: capture fingerprints for filled slots in init frame ----
const initLayout = detectGuiLayout(initFrame, undefined);
if (!initLayout) { console.error("no layout in init frame"); process.exit(2); }
const initCursor = detectCursorWithExpectation(initFrame, initLayout, null);
console.log(`INIT: layout=${initLayout.matchedLayoutId} slots=${initLayout.slots.length} cursor=${initCursor ? `(${initCursor.x},${initCursor.y})` : "?"}`);

const tracked = []; // {label, x, y, role, fp, hash}
for (const s of initLayout.slots) {
  if (initCursor && Math.hypot(s.cx - initCursor.x, s.cy - initCursor.y) < 12) continue;
  const fp = samplePatchFingerprint(initFrame, s.cx, s.cy, 6);
  if (!fp) continue;
  if (!isFilled(fp)) continue;
  const hash = samplePatchDHash(initFrame, s.cx, s.cy, 16);
  if (hash === null) continue;
  tracked.push({
    label: `item@${s.role ?? "?"}_${s.index}`,
    x: s.cx, y: s.cy, role: s.role,
    fp, hash,
  });
}
console.log(`INIT: tracked items=${tracked.length}`);
for (const t of tracked) {
  console.log(`  ${t.label.padEnd(28)} pos=(${t.x},${t.y}) meanRGB=(${t.fp.meanR.toFixed(0)},${t.fp.meanG.toFixed(0)},${t.fp.meanB.toFixed(0)}) chroma=${chroma(t.fp).toFixed(1)} hash=${t.hash.toString(16).padStart(16, "0")}`);
}

// ---- Stage 2: re-resolve each tracked item against live frame slots ----
console.log("");
const liveLayout = detectGuiLayout(liveFrame, initLayout.matchedLayoutId);
if (!liveLayout) { console.error("no layout in live frame"); process.exit(3); }
const liveCursor = detectCursorWithExpectation(liveFrame, liveLayout, null);
console.log(`LIVE: layout=${liveLayout.matchedLayoutId} slots=${liveLayout.slots.length} cursor=${liveCursor ? `(${liveCursor.x},${liveCursor.y})` : "?"}`);

const liveSlotSigs = [];
for (const s of liveLayout.slots) {
  if (liveCursor && Math.hypot(s.cx - liveCursor.x, s.cy - liveCursor.y) < 12) continue;
  const fp = samplePatchFingerprint(liveFrame, s.cx, s.cy, 6);
  if (!fp || !isFilled(fp)) continue;
  const hash = samplePatchDHash(liveFrame, s.cx, s.cy, 16);
  if (hash === null) continue;
  liveSlotSigs.push({ index: s.index, role: s.role, cx: s.cx, cy: s.cy, fp, hash });
}

const HAMMING_MAX = 16;
const usedSlots = new Set();
const matched = [];
const lost = [];
for (const t of tracked) {
  let bestKey = null, bestSlot = null;
  let bestHam = HAMMING_MAX + 1, bestFpD = Infinity;
  for (const ls of liveSlotSigs) {
    const key = `${ls.cx},${ls.cy}`;
    if (usedSlots.has(key)) continue;
    const ham = dHashDistance(t.hash, ls.hash);
    if (ham > HAMMING_MAX) continue;
    const fd = fpDist(t.fp, ls.fp);
    if (ham < bestHam || (ham === bestHam && fd < bestFpD)) {
      bestHam = ham; bestFpD = fd; bestKey = key; bestSlot = ls;
    }
  }
  if (bestSlot) {
    usedSlots.add(bestKey);
    matched.push({ t, ls: bestSlot, ham: bestHam, fpD: bestFpD });
  } else {
    lost.push(t);
  }
}

console.log("");
console.log("-- LIVE: resolved item locations --");
for (const m of matched) {
  const drift = Math.hypot(m.ls.cx - m.t.x, m.ls.cy - m.t.y);
  const moved = drift > 6 ? `MOVED (${m.t.x},${m.t.y}) -> (${m.ls.cx},${m.ls.cy})` : "stationary";
  console.log(`  ${m.t.label.padEnd(28)} -> slot ${String(m.ls.index).padStart(2)}(${m.ls.role ?? "?"}) ham=${String(m.ham).padStart(2)} fp_d=${m.fpD.toFixed(1).padStart(5)}  ${moved}`);
}

console.log("");
console.log("-- LIVE: items not found in any slot (cursor candidates) --");
for (const t of lost) {
  console.log(`  ${t.label.padEnd(28)} (was @${t.x},${t.y})`);
}

// ---- NEW FILLS: slots that are filled in live but NOT in init ----
// These are landing-zones for items that came from cursor (e.g. cob
// placed into a craft cell). Detected by: live slot is filled, no
// init slot at the same pixel position was filled.
console.log("");
console.log("-- LIVE: newly-filled slots (vs. init) --");
const initFilledKeys = new Set(tracked.map((t) => `${t.x},${t.y}`));
const newFills = [];
for (const ls of liveSlotSigs) {
  if (initFilledKeys.has(`${ls.cx},${ls.cy}`)) continue;
  let bestT = null, bestHam = Infinity;
  for (const t of tracked) {
    const ham = dHashDistance(t.hash, ls.hash);
    if (ham < bestHam) { bestHam = ham; bestT = t; }
  }
  newFills.push({ ls, bestT, bestHam });
  console.log(`  slot ${String(ls.index).padStart(2)}(${ls.role ?? "?"}) at (${ls.cx},${ls.cy}) chroma=${chroma(ls.fp).toFixed(1)}` +
    `  best init match: ${bestT ? bestT.label : "(none)"} ham=${bestHam}`);
}

const cursorHoldingMut = lost.length > 0 ? true : (tracked.length > 0 ? false : null);
console.log("");
console.log(`cursorHoldingMut = ${cursorHoldingMut}`);
console.log(`Summary: matched=${matched.length}/${tracked.length}  lost(on cursor)=${lost.length}  newFills=${newFills.length}`);
