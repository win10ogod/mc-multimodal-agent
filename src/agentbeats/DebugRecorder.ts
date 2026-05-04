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
   *  decoded and written as PNG/JPG next to the JSONL line. */
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
        const fname = `${seqStr}_${event.type}.${imageExt}`;
        fs.writeFileSync(path.join(this.dir, fname), Buffer.from(cleaned, "base64"));
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
