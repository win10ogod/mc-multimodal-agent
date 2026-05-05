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
   *  last verified by OCR. Used by the cross-frame material-tracker
   *  to decide whether the item is still at this anchor, has moved to
   *  another slot, is on the cursor, or is missing -- without paying
   *  another OCR call. */
  fingerprint?: { meanR: number; meanG: number; meanB: number; stddev: number };
  /** dHash (64-bit perceptual hash) of the slot patch. Captures the
   *  spatial texture of the item icon. Many MC blocks share similar
   *  mean RGB (grey/brown palette) but differ in pixel layout — the
   *  hash discriminates them. Hamming distance ≤16 ⇒ same item. */
  hash?: bigint;
};

/** Tolerance for LOOKUP — slot centers can drift 2–5 px between
 *  layout detections (CV centroid jitter, row-median snap). 8 px is
 *  comfortable inside the 18 px slot stride. */
export const MATCH_RADIUS_PX = 8;
/** Tolerance for WRITE — must be tighter than the slot stride / 2
 *  to prevent record() from clobbering an adjacent slot's entry
 *  when caller's coords are slightly off. 3 px ≈ "same physical
 *  slot center"; anything further creates a NEW entry. */
const WRITE_RADIUS_PX = 3;
const STALE_STEPS = 80;

export class SlotMemory {
  private entries: SlotMemoryEntry[] = [];

  /** Record (or update) what is at an absolute pixel position.
   *  Uses a tighter radius than lookup to avoid clobbering an
   *  adjacent slot's entry when the caller's (x,y) is a few pixels
   *  off from the recorded position. */
  record(x: number, y: number, item: string, step: number, fingerprint?: SlotMemoryEntry["fingerprint"], hash?: bigint): void {
    const idx = this.findClosestIndex(x, y, WRITE_RADIUS_PX);
    if (idx >= 0) {
      const prev = this.entries[idx];
      this.entries[idx] = { x, y, item, step, fingerprint: fingerprint ?? prev.fingerprint, hash: hash ?? prev.hash };
    } else {
      this.entries.push({ x, y, item, step, fingerprint, hash });
    }
  }

  /** Look up the remembered item at an absolute position, if any.
   *  Returns null when no entry is within MATCH_RADIUS_PX. */
  lookup(x: number, y: number): SlotMemoryEntry | null {
    const idx = this.findClosestIndex(x, y, MATCH_RADIUS_PX);
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

  private findClosestIndex(x: number, y: number, radiusPx: number = MATCH_RADIUS_PX): number {
    let best = -1;
    let bestD2 = radiusPx * radiusPx;
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
