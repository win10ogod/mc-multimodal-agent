// Visual test for SlotMarker. Reads a saved PNG inventory frame, re-encodes
// it as JPEG (to match what the green agent sends), runs markInventoryFrame,
// writes the result to disk for visual inspection.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { markInventoryFrame } from "../dist/agentbeats/SlotMarker.js";

const inputPng = process.argv[2];
const outputPng = process.argv[3];
if (!inputPng || !outputPng) {
  console.error("usage: node test_slot_marker.mjs <input.png> <output.png>");
  process.exit(1);
}

// Load PNG -> raw RGBA -> encode as JPEG to simulate green-agent obs format
const pngBuf = readFileSync(inputPng);
const png = PNG.sync.read(pngBuf);
const jpegBuf = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90).data;
const jpegBase64 = jpegBuf.toString("base64");
console.log(`input: ${png.width}x${png.height}, jpeg ${jpegBuf.length} bytes`);

// Mark
const t0 = Date.now();
const marked = markInventoryFrame(jpegBase64);
const t1 = Date.now();
console.log(`marked ${marked.marks.length} slots in ${t1 - t0}ms, png ${marked.pngBase64.length} chars (b64)`);

// Write
writeFileSync(outputPng, Buffer.from(marked.pngBase64, "base64"));
console.log(`wrote ${outputPng}`);
