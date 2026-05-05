/**
 * Absolute-position keyed slot-content memory.
 *
 * The probe sees raster slot indices, but those are unstable: the SoM
 * detector renumbers slots whenever the GUI changes (open/close, scroll,
 * different window). The pixel position of a slot in 640x360 frame space
 * is comparatively stable for the duration of one UI session.
 *
 * SlotMemory stores `{absX, absY → item, step}` so we can recover "what
 * is at this position" across re-perceptions. When the probe runs again,
 * each freshly-detected slot looks up its closest memory entry by L2
 * distance; if within MATCH_RADIUS pixels, we attach the remembered item
 * name to that raster index.
 */

export type SlotMemoryEntry = {
  x: number;
  y: number;
  item: string;
  step: number;
  /** RGB-mean+stddev fingerprint of the slot patch when the item was
   *  last verified by OCR. Cheap first-pass identity check; same
   *  mean+stddev across different items is common (grey blocks),
   *  so falls back to `patch` for definitive comparison. */
  fingerprint?: { meanR: number; meanG: number; meanB: number; stddev: number };
  /** Cropped icon pixels with the empty-slot grey background masked
   *  out. Stored as a flat RGBA buffer + a foreground mask (1=icon
   *  pixel, 0=BG). Captured from the RAW obs frame BEFORE the SoM
   *  layout markers are drawn, so cursor-hover highlight + numbered
   *  badges don't pollute the reference. Comparison uses SSD over
   *  the foreground-mask intersection — discriminates two items with
   *  near-identical mean RGB. Used as the authoritative tie-breaker
   *  when fingerprint+stddev signals are ambiguous. */
  patch?: { w: number; h: number; rgba: Uint8Array; mask: Uint8Array };
};

const MATCH_RADIUS_PX = 8;
const STALE_STEPS = 80;

export class SlotMemory {
  private entries: SlotMemoryEntry[] = [];

  /** Record (or update) what is at an absolute pixel position. */
  record(x: number, y: number, item: string, step: number, fingerprint?: SlotMemoryEntry["fingerprint"], patch?: SlotMemoryEntry["patch"]): void {
    const idx = this.findClosestIndex(x, y);
    if (idx >= 0) {
      const prev = this.entries[idx];
      this.entries[idx] = {
        x, y, item, step,
        fingerprint: fingerprint ?? prev.fingerprint,
        patch: patch ?? prev.patch,
      };
    } else {
      this.entries.push({ x, y, item, step, fingerprint, patch });
    }
  }

  /** Look up the remembered item at an absolute position, if any.
   *  Returns null when no entry is within MATCH_RADIUS_PX. */
  lookup(x: number, y: number): SlotMemoryEntry | null {
    const idx = this.findClosestIndex(x, y);
    return idx >= 0 ? this.entries[idx] : null;
  }

  /** Drop entries older than `currentStep - STALE_STEPS`. */
  pruneStale(currentStep: number): void {
    this.entries = this.entries.filter((e) => currentStep - e.step <= STALE_STEPS);
  }

  /** Forget the entry near (x, y); used after a click that mutated the slot. */
  invalidate(x: number, y: number): void {
    const idx = this.findClosestIndex(x, y);
    if (idx >= 0) this.entries.splice(idx, 1);
  }

  /** Snapshot for prompt injection: array of {x, y, item, step}. */
  snapshot(): SlotMemoryEntry[] {
    return this.entries.slice();
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  private findClosestIndex(x: number, y: number): number {
    let best = -1;
    let bestD2 = MATCH_RADIUS_PX * MATCH_RADIUS_PX;
    for (let i = 0; i < this.entries.length; i += 1) {
      const e = this.entries[i];
      const d2 = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }
}
