/**
 * Pixel-level template matcher for fixed UI elements (recipe-book toggle,
 * recipe icons, etc.) that the colour/grey-mass slot detector cannot find.
 *
 * Templates live in `data/ui-templates/<name>.png` and are loaded once on
 * first use. matchTemplate slides the template across the frame and
 * returns the lowest-SSD position. A normalized score threshold filters
 * out "no match" cases (e.g. world frames where the button isn't visible).
 *
 * Ordinarily the full search is O(W*H*tw*th) per channel which would be
 * expensive — we sample every other source pixel inside the template
 * (≈4× speedup) and use early-exit when the running sum exceeds the best
 * score so far. For 18×18 templates on a 640×360 frame this runs in
 * single-digit milliseconds.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import jpegLib from "jpeg-js";
import { PNG } from "pngjs";

export type TemplateMatch = {
  /** Centroid of the matched region in the source frame. */
  cx: number;
  cy: number;
  /** Normalized SSD: average squared diff per sampled RGB channel. Lower is better. */
  norm: number;
  /** Source-frame bbox of the matched region. */
  bbox: { x: number; y: number; w: number; h: number };
};

type CachedTemplate = {
  width: number;
  height: number;
  /** RGBA byte buffer, length = width*height*4. */
  data: Buffer;
};

const cache = new Map<string, CachedTemplate>();

function templatesRoot(): string {
  // Walk up from this file (src/agentbeats/tools/) until we hit data/ui-templates/.
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.resolve(dir, "data", "ui-templates");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.resolve(dir, "..");
  }
  // Fall back to dist-relative if we couldn't walk up (Docker layout).
  return path.resolve(__dirname, "..", "..", "..", "data", "ui-templates");
}

function loadTemplate(name: string): CachedTemplate | null {
  const cached = cache.get(name);
  if (cached) return cached;
  const file = path.join(templatesRoot(), `${name}.png`);
  if (!fs.existsSync(file)) {
    console.warn(`[ui-template] missing: ${file}`);
    return null;
  }
  const png = PNG.sync.read(fs.readFileSync(file));
  const tmpl: CachedTemplate = { width: png.width, height: png.height, data: Buffer.from(png.data) };
  cache.set(name, tmpl);
  return tmpl;
}

function decodeFrame(jpegOrPngBase64: string): { width: number; height: number; data: Buffer } | null {
  const cleaned = jpegOrPngBase64.startsWith("data:image/")
    ? jpegOrPngBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : jpegOrPngBase64;
  const buf = Buffer.from(cleaned, "base64");
  if (!buf.length) return null;
  // Try PNG first (cheaper signature check), then JPEG.
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Buffer.from(png.data) };
  }
  try {
    const decoded = jpegLib.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  } catch (e) {
    console.warn(`[ui-template] decode failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Find the best position of `templateName` in the given frame.
 * Returns null when the lowest score exceeds `maxNorm` (no match).
 *
 * `maxNorm` is the average squared diff per sampled RGB channel; with a
 * fresh frame and minor SoM overlay we typically see ~75, with the
 * source frame ~0. A "no match" frame (template absent) usually scores
 * 1000+. Default threshold 300 is conservative.
 */
export function matchTemplate(
  frameBase64: string,
  templateName: string,
  maxNorm = 300,
): TemplateMatch | null {
  const tmpl = loadTemplate(templateName);
  if (!tmpl) return null;
  const frame = decodeFrame(frameBase64);
  if (!frame) return null;
  const { width: fw, height: fh, data: fdata } = frame;
  const { width: tw, height: th, data: tdata } = tmpl;
  if (tw > fw || th > fh) return null;

  let bestScore = Infinity;
  let bestX = 0;
  let bestY = 0;

  for (let y = 0; y <= fh - th; y += 1) {
    for (let x = 0; x <= fw - tw; x += 1) {
      let sum = 0;
      for (let ty = 0; ty < th; ty += 2) {
        for (let tx = 0; tx < tw; tx += 2) {
          const fi = ((y + ty) * fw + (x + tx)) * 4;
          const ti = (ty * tw + tx) * 4;
          const dr = fdata[fi]     - tdata[ti];
          const dg = fdata[fi + 1] - tdata[ti + 1];
          const db = fdata[fi + 2] - tdata[ti + 2];
          sum += dr * dr + dg * dg + db * db;
          if (sum > bestScore) break;
        }
        if (sum > bestScore) break;
      }
      if (sum < bestScore) {
        bestScore = sum;
        bestX = x;
        bestY = y;
      }
    }
  }

  const sampledChannels = Math.ceil(tw / 2) * Math.ceil(th / 2) * 3;
  const norm = bestScore / sampledChannels;
  if (norm > maxNorm) return null;
  return {
    cx: bestX + Math.floor(tw / 2),
    cy: bestY + Math.floor(th / 2),
    norm,
    bbox: { x: bestX, y: bestY, w: tw, h: th },
  };
}
