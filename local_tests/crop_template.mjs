/**
 * Crop a square template from a frame at a given pixel center.
 * Usage: node local_tests/crop_template.mjs <frame.png> <cx> <cy> [<half>] [<out.png>]
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const [, , src, cxRaw, cyRaw, halfRaw, outRaw] = process.argv;
if (!src || !cxRaw || !cyRaw) {
  console.error("usage: node crop_template.mjs <frame.png> <cx> <cy> [<half>] [<out.png>]");
  process.exit(1);
}
const cx = parseInt(cxRaw, 10);
const cy = parseInt(cyRaw, 10);
const half = parseInt(halfRaw ?? "9", 10);
const out = outRaw ?? path.resolve("data", "ui-templates", "recipe_book.png");

const frame = PNG.sync.read(fs.readFileSync(src));
const fw = frame.width, fh = frame.height;
const x0 = Math.max(0, cx - half);
const y0 = Math.max(0, cy - half);
const x1 = Math.min(fw, cx + half);
const y1 = Math.min(fh, cy + half);
const cw = x1 - x0, ch = y1 - y0;

const tmpl = new PNG({ width: cw, height: ch });
for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const fi = ((y0 + y) * fw + (x0 + x)) * 4;
    const ti = (y * cw + x) * 4;
    tmpl.data[ti]   = frame.data[fi];
    tmpl.data[ti+1] = frame.data[fi+1];
    tmpl.data[ti+2] = frame.data[fi+2];
    tmpl.data[ti+3] = 255;
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, PNG.sync.write(tmpl));
console.log(`saved ${out}  click=(${cx},${cy})  bbox=(${x0},${y0})..(${x1},${y1})  size=${cw}x${ch}`);
