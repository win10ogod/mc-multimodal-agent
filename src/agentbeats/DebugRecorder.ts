/**
 * Per-event structured debug recorder for the closed-loop GUI control.
 *
 * Records ONLY decision-point events (VLM probe call/response, verify
 * result, refusal, chain build), not the per-frame servo trajectory
 * which is huge and uninteresting.
 *
 * Each event is written as one JSON line in events.jsonl plus an
 * optional adjacent PNG (base64-decoded image at the moment of the
 * event). Numbered sequentially so timeline order is obvious.
 *
 * Enable with env var AGENTBEATS_DEBUG_DIR=/path. When unset the
 * recorder is a no-op so prod runs pay nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type DebugEvent = {
  type: string;
  contextId?: string;
  iteration?: number;
  step?: number;
  data: Record<string, unknown>;
};

export class DebugRecorder {
  private readonly enabled: boolean;
  private readonly dir: string | null;
  private seq = 0;

  constructor() {
    const envDir = process.env.AGENTBEATS_DEBUG_DIR;
    this.enabled = !!envDir;
    this.dir = envDir ?? null;
    if (this.enabled && this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch (e) {
        console.warn(`[debug-recorder] could not create ${this.dir}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record one event. `imageBase64` is optional; if provided it's
   *  decoded and written as PNG/JPG next to the JSONL line. The MC sim
   *  outputs JPEGs whose YCbCr decodes to BGR-meaning data (tan looks
   *  blue, blue looks tan). For debug viewing we re-encode the image
   *  with R/B channels swapped so it displays in true color. The
   *  pipeline (VLM, CV) keeps using the raw bytes -- this swap is
   *  cosmetic for human readers only. */
  record(event: DebugEvent, imageBase64?: string, imageExt: "png" | "jpg" = "jpg"): void {
    if (!this.enabled || !this.dir) return;
    this.seq += 1;
    const seqStr = String(this.seq).padStart(5, "0");
    let imageFile: string | undefined;
    if (imageBase64) {
      try {
        const cleaned = imageBase64.startsWith("data:image/")
          ? imageBase64.replace(/^data:image\/[a-z]+;base64,/, "")
          : imageBase64;
        const fname = `${seqStr}_${event.type}.png`;
        // Re-encode as PNG with R/B swapped for human-readable colors.
        try {
          // Lazy require so non-debug runs don't pay the import cost.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const jpegLib = require("jpeg-js");
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { PNG } = require("pngjs");
          const inBuf = Buffer.from(cleaned, "base64");
          let decoded;
          if (imageExt === "jpg") {
            decoded = jpegLib.decode(inBuf, { useTArray: true, formatAsRGBA: true });
          } else {
            const png = PNG.sync.read(inBuf);
            decoded = { width: png.width, height: png.height, data: png.data };
          }
          const w = decoded.width, h = decoded.height;
          const data = Buffer.from(decoded.data);
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            data[i] = data[i + 2];
            data[i + 2] = r;
          }
          const outPng = new PNG({ width: w, height: h });
          data.copy(outPng.data);
          fs.writeFileSync(path.join(this.dir, fname), PNG.sync.write(outPng));
        } catch {
          // Fallback: write raw bytes (color may look swapped).
          fs.writeFileSync(path.join(this.dir, fname.replace(".png", "." + imageExt)), Buffer.from(cleaned, "base64"));
        }
        imageFile = fname;
      } catch (e) {
        console.warn(`[debug-recorder] image write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const line = JSON.stringify({
      seq: this.seq,
      ts: new Date().toISOString(),
      type: event.type,
      contextId: event.contextId,
      iteration: event.iteration,
      step: event.step,
      imageFile,
      data: event.data,
    });
    try {
      fs.appendFileSync(path.join(this.dir, "events.jsonl"), line + "\n");
    } catch (e) {
      console.warn(`[debug-recorder] events.jsonl append failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

let singleton: DebugRecorder | null = null;
export function getDebugRecorder(): DebugRecorder {
  if (!singleton) singleton = new DebugRecorder();
  return singleton;
}
