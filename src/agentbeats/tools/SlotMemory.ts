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
};

const MATCH_RADIUS_PX = 8;
const STALE_STEPS = 80;

export class SlotMemory {
  private entries: SlotMemoryEntry[] = [];

  /** Record (or update) what is at an absolute pixel position. */
  record(x: number, y: number, item: string, step: number): void {
    const idx = this.findClosestIndex(x, y);
    if (idx >= 0) {
      this.entries[idx] = { x, y, item, step };
    } else {
      this.entries.push({ x, y, item, step });
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
