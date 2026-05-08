/**
 * High-contrast crosshair overlay for world-view VLM frames.
 *
 * The native MC crosshair at 640x360 is a 1-2 px white + symbol — visible
 * to a human but small enough that VLM ViT backbones (typically 14×14 or
 * larger patch tokenizers) normalize it into the surrounding patch's
 * background statistics. The model has nothing salient to attend to when
 * asked "what block is at the crosshair?" so its answer drifts toward
 * whatever object happens to dominate the centre region.
 *
 * This module decodes the obs JPEG, draws a bold red+yellow crosshair at
 * the image centre (28 px arms with a 5 px-stroke yellow halo and a 1 px
 * red core), and returns a PNG base64. The overlay spans multiple ViT
 * patches so it's a first-class feature the attention can latch onto.
 *
 * Use for ALL world-view VLM calls (WorldBlockOpener, WorldExplorer,
 * Mining, Combat, Placing). Skip for GUI-mode frames (the cursor is
 * tracked elsewhere; GUI overlays don't apply).
 */

const CROSS_HALF = 14;       // arm length in px, each direction
const CROSS_STROKE = 2;      // stroke width
const RED: [number, number, number] = [255, 30, 30];
const YELLOW: [number, number, number] = [255, 235, 0];

export type CrosshairOverlayOpts = {
  /** Pixel centre of the crosshair. Defaults to image centre. */
  center?: { x: number; y: number };
  /** Arm length per direction. Defaults to CROSS_HALF (14 px). */
  half?: number;
};

/** Draw a crosshair on the obs JPEG and return a PNG base64. */
export function drawCrosshair(obsBase64: string, opts?: CrosshairOverlayOpts): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jpegLib = require("jpeg-js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PNG } = require("pngjs");

  const cleaned = obsBase64.startsWith("data:image/")
    ? obsBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : obsBase64;
  const inBuf = Buffer.from(cleaned, "base64");
  const decoded = jpegLib.decode(inBuf, { useTArray: true, formatAsRGBA: true });
  const w = decoded.width as number;
  const h = decoded.height as number;
  const cx = Math.round(opts?.center?.x ?? w / 2);
  const cy = Math.round(opts?.center?.y ?? h / 2);
  const half = opts?.half ?? CROSS_HALF;

  // jpeg-js outputs RGBA but the underlying byte order from MC sim is BGR.
  // We need to swap on copy so the displayed image uses true colours
  // (matches what DebugRecorder does for jpg→png conversions).
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < decoded.data.length; i += 4) {
    out.data[i] = decoded.data[i + 2];     // R <- B
    out.data[i + 1] = decoded.data[i + 1]; // G
    out.data[i + 2] = decoded.data[i];     // B <- R
    out.data[i + 3] = 255;
  }

  // Yellow outer halo (3-px thick), red core (1-px thick).
  const drawPixel = (x: number, y: number, color: [number, number, number]) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = (y * w + x) * 4;
    out.data[idx] = color[0];
    out.data[idx + 1] = color[1];
    out.data[idx + 2] = color[2];
    out.data[idx + 3] = 255;
  };
  // Yellow halo arms (thicker outer band)
  for (let d = -half; d <= half; d += 1) {
    for (let s = -CROSS_STROKE; s <= CROSS_STROKE; s += 1) {
      // horizontal arm
      drawPixel(cx + d, cy + s, YELLOW);
      // vertical arm
      drawPixel(cx + s, cy + d, YELLOW);
    }
  }
  // Red core (1-px thick) on top
  for (let d = -half; d <= half; d += 1) {
    drawPixel(cx + d, cy, RED);
    drawPixel(cx, cy + d, RED);
  }
  // Small black outline at the centre intersection so the cross is
  // distinguishable even on red/yellow world tiles (e.g. red sand).
  drawPixel(cx, cy, [0, 0, 0]);

  return PNG.sync.write(out).toString("base64");
}
