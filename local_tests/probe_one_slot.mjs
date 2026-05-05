import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import jpegLib from "jpeg-js";
import { detectGuiLayout, samplePatchFingerprint, samplePatchDHash, dHashDistance } from "../dist/agentbeats/tools/SlotDetector.js";

function loadFrame(p) {
  const ext = path.extname(p).toLowerCase();
  const buf = fs.readFileSync(p);
  if (ext === ".png") {
    const png = PNG.sync.read(buf);
    return Buffer.from(jpegLib.encode({ data: png.data, width: png.width, height: png.height }, 90).data).toString("base64");
  }
  return buf.toString("base64");
}
const chroma = (fp) => Math.max(fp.meanR, fp.meanG, fp.meanB) - Math.min(fp.meanR, fp.meanG, fp.meanB);

const initFrame = loadFrame(process.argv[2]);
const liveFrame = loadFrame(process.argv[3]);
const initLayout = detectGuiLayout(initFrame, undefined);
const liveLayout = detectGuiLayout(liveFrame, initLayout.matchedLayoutId);

// Cobblestone signature from init hotbar_38
const cobInit = initLayout.slots.find((s) => s.index === 38);
const cobFp = samplePatchFingerprint(initFrame, cobInit.cx, cobInit.cy, 6);
const cobHash = samplePatchDHash(initFrame, cobInit.cx, cobInit.cy, 16);
console.log(`INIT cob @hotbar_38 (${cobInit.cx},${cobInit.cy}): meanRGB=(${cobFp.meanR.toFixed(0)},${cobFp.meanG.toFixed(0)},${cobFp.meanB.toFixed(0)}) chroma=${chroma(cobFp).toFixed(1)} hash=${cobHash.toString(16).padStart(16,"0")}`);
console.log("");

// Scan all live slots and report Hamming distance to cob
console.log("LIVE: every slot vs cobblestone signature");
for (const s of liveLayout.slots) {
  const fp = samplePatchFingerprint(liveFrame, s.cx, s.cy, 6);
  if (!fp) continue;
  const hash = samplePatchDHash(liveFrame, s.cx, s.cy, 16);
  if (hash === null) continue;
  const ham = dHashDistance(cobHash, hash);
  const c = chroma(fp);
  if (s.role && s.role.startsWith("craft") || s.role === "result" || ham <= 20 || c > 12) {
    console.log(`  slot ${String(s.index).padStart(2)}(${s.role ?? "?"}) (${s.cx},${s.cy}): meanRGB=(${fp.meanR.toFixed(0)},${fp.meanG.toFixed(0)},${fp.meanB.toFixed(0)}) stddev=${fp.stddev.toFixed(1).padStart(4)} chroma=${c.toFixed(1).padStart(5)} ham=${String(ham).padStart(2)}${ham<=10?"  ← STRONG match cob":""}${ham<=16&&ham>10?"  ← loose match cob":""}`);
  }
}
