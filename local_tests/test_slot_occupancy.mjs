/**
 * Verifies the per-frame slot occupancy + cursor-NW heuristics on a
 * debug frame. Mirrors the runtime classifier in runClosedLoopStep.ts:
 *   isFilled = (stddev<25 && chroma<18) → empty
 *              chroma>25 → filled
 *              stddev>45 → filled
 *              else      → empty
 *
 * Usage:
 *   node local_tests/test_slot_occupancy.mjs <frame.png|jpg>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import jpegLib from "jpeg-js";

import {
  detectGuiLayout,
  detectCursorWithExpectation,
  samplePatchFingerprint,
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
// Strict color-only test (matches runtime). chroma > 12 separates real
// items (saturated colors) from ghost armor icons / UI text (greyscale).
function isFilled(fp) { return chroma(fp) > 12; }

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("usage: node local_tests/test_slot_occupancy.mjs <frame.png|jpg>");
  process.exit(1);
}
const frame = loadFrame(args[0]);
const layout = detectGuiLayout(frame, undefined);
if (!layout) {
  console.error(`no GUI layout detected in ${args[0]}`);
  process.exit(2);
}

const cursor = detectCursorWithExpectation(frame, layout, null);

console.log(`Layout: ${layout.matchedLayoutId ?? "unknown"}  slots=${layout.slots.length}  window=(${layout.windowX},${layout.windowY}) ${layout.windowW}x${layout.windowH}`);
console.log(`Cursor: ${cursor ? `(${cursor.x},${cursor.y})` : "not detected"}`);
console.log("");
console.log("idx role/name                    pos        meanRGB          stddev  chroma  verdict");
console.log("--- --------------------------  ---------  ---------------  ------  ------  -------");

let nFilled = 0, nEmpty = 0, nNoSample = 0;
for (const s of layout.slots) {
  const fp = samplePatchFingerprint(frame, s.cx, s.cy, 6);
  const nearCursor = cursor && Math.hypot(s.cx - cursor.x, s.cy - cursor.y) < 12;
  if (!fp) { nNoSample += 1; continue; }
  const c = chroma(fp);
  const filled = isFilled(fp);
  if (filled) nFilled += 1; else nEmpty += 1;
  const label = `${s.role ?? "?"}${s.name ? `/${s.name}` : ""}`;
  console.log(
    `${String(s.index).padStart(3)} ${label.padEnd(26)}  (${String(s.cx).padStart(3)},${String(s.cy).padStart(3)})  ` +
    `(${String(Math.round(fp.meanR)).padStart(3)},${String(Math.round(fp.meanG)).padStart(3)},${String(Math.round(fp.meanB)).padStart(3)})  ` +
    `${fp.stddev.toFixed(1).padStart(6)}  ${c.toFixed(1).padStart(6)}  ${filled ? "FILLED" : "empty "}` +
    `${nearCursor ? "  [near-cursor: skipped at runtime]" : ""}`,
  );
}
console.log("");
console.log(`Summary: filled=${nFilled}  empty=${nEmpty}  no-sample=${nNoSample}`);

if (cursor) {
  const overSlot = layout.slots.some((s) => Math.hypot(s.cx - cursor.x, s.cy - cursor.y) < 12);
  console.log("");
  console.log(`Cursor-NW held-item check: cursor at (${cursor.x},${cursor.y}); overSlot=${overSlot}`);
  if (!overSlot) {
    const heldFp = samplePatchFingerprint(frame, cursor.x - 8, cursor.y - 8, 4);
    if (heldFp) {
      const heldC = chroma(heldFp);
      const holding = heldFp.stddev > 35 || heldC > 30;
      const empty = heldFp.stddev < 18 && heldC < 15;
      console.log(`  patch fp meanRGB=(${Math.round(heldFp.meanR)},${Math.round(heldFp.meanG)},${Math.round(heldFp.meanB)}) stddev=${heldFp.stddev.toFixed(1)} chroma=${heldC.toFixed(1)}`);
      console.log(`  verdict: ${holding ? "HOLDING" : empty ? "empty" : "ambiguous"}`);
    }
  } else {
    console.log("  skipped — cursor over a slot");
  }
}
