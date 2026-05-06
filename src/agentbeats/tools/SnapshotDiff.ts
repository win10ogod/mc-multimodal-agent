/**
 * Park-snapshot action verification.
 *
 * Replaces the per-click slot-center stddev verify (cycling-prone
 * under cursor-sprite + animated-bg pollution) with before/after
 * pixel snapshots of the entire layout taken when the cursor is at
 * park (outside the GUI). All measurements are clean of cursor
 * sprite. Pixel-level RMS for change detection; patch similarity
 * for identity matching against known items.
 *
 * Spec: docs/superpowers/specs/2026-05-07-park-snapshot-action-verify-design.md
 */

import { samplePatchPixels, patchPixelRms, patchSimilarity } from "./SlotDetector";
import type { GuiLayout } from "./SlotDetector";

export type PatchPixels = { w: number; h: number; rgba: Uint8Array; mask: Uint8Array };

export type LayoutSnapshot = {
  /** Per-slot raw RGBA + BG mask, keyed by raster index. */
  slots: Map<number, PatchPixels>;
  /** Cursor-area patch (cursor.x+8, cursor.y+8) at park time. Captures
   *  any held-icon overlay; null if cursor wasn't at park. */
  cursor: PatchPixels | null;
  /** Cursor-holding state derived at snapshot time by BG-masked
   *  pixel-diff against the parkEmptyCursorPatch baseline. The
   *  raw-RGBA RMS approach (used for slots) breaks for the cursor
   *  patch because sub-pixel sprite shifts between snapshots
   *  produce huge RMS even when the cursor is empty in both. The
   *  baseline-relative BG-masked count is sprite-shift-tolerant. */
  cursorHolding: boolean | null;
  /** Step the snapshot was taken — for staleness diagnostics. */
  takenAt: number;
};

export type SlotChange = "filled→empty" | "empty→filled" | "swapped";

export type SnapshotDiff = {
  slotChanges: Map<number, SlotChange>;
  cursorChange: "empty→holding" | "holding→empty" | "unchanged";
};

const SLOT_CHANGE_RMS = 25;
const ID_MATCH_SIM = 0.85;
/** BG-masked pixel-diff threshold for cursor-holding detection.
 *  A held item adds ~36+ bright pixels to the cursor patch vs the
 *  empty baseline (verified offline against ground-truth eval frames:
 *  empty=0, cobblestone=36, nether_quartz=66). Threshold 30 cleanly
 *  separates empty from holding. */
const CURSOR_HOLDING_FG_THR = 30;
const CURSOR_BG_LUM_MAX = 60;
const CURSOR_PIXEL_DIST_THR = 24;
/** Per-slot fill heuristic from a single patch: mask foreground
 *  pixel count. An empty slot's mask is mostly 0 (everything is
 *  near the BG grey baseline); a filled slot has substantial
 *  foreground. Threshold tuned to the 14×14 patch — ~30 fg pixels
 *  = clearly an item. */
const FILL_FG_THR = 30;

function isPatchFilled(p: PatchPixels): boolean {
  let fg = 0;
  for (let i = 0; i < p.mask.length; i += 1) if (p.mask[i]) fg += 1;
  return fg >= FILL_FG_THR;
}

/** BG-masked pixel-diff between the live cursor-area patch and the
 *  parkEmptyCursorPatch baseline. Skips pixels where BOTH sides are
 *  dark (animated dimmed-world background) so only sprite + held-icon
 *  pixels contribute. Returns true when the count of significantly-
 *  changed pixels exceeds CURSOR_HOLDING_FG_THR — a held item adds
 *  bright icon pixels that weren't in the empty baseline. */
function detectCursorHolding(
  live: { rgba: Uint8Array },
  baseline: { w: number; h: number; rgba: Uint8Array },
): boolean {
  const n = baseline.w * baseline.h;
  let fg = 0;
  for (let i = 0; i < n; i += 1) {
    const off = i * 4;
    const lumLive = 0.299 * live.rgba[off] + 0.587 * live.rgba[off + 1] + 0.114 * live.rgba[off + 2];
    const lumBase = 0.299 * baseline.rgba[off] + 0.587 * baseline.rgba[off + 1] + 0.114 * baseline.rgba[off + 2];
    if (lumLive < CURSOR_BG_LUM_MAX && lumBase < CURSOR_BG_LUM_MAX) continue;
    const dr = live.rgba[off] - baseline.rgba[off];
    const dg = live.rgba[off + 1] - baseline.rgba[off + 1];
    const db = live.rgba[off + 2] - baseline.rgba[off + 2];
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d > CURSOR_PIXEL_DIST_THR) fg += 1;
  }
  return fg > CURSOR_HOLDING_FG_THR;
}

/** Capture a snapshot of every slot in the active layout, plus the
 *  cursor-area patch. cursorBaseline is the parkEmptyCursorPatch
 *  reference used to determine cursor-holding via BG-masked diff.
 *  fallbackCursor is the last-known cursor position; used when the
 *  live cursor isn't detected (held items can occlude the sprite,
 *  failing template match even though the cursor IS still at park).
 *  Sampling at the last-known position keeps baseline + live patches
 *  covering the same physical region. */
export function takeLayoutSnapshot(
  obsBase64: string,
  layout: GuiLayout,
  cursor: { x: number; y: number } | null,
  step: number,
  cursorBaseline: { w: number; h: number; rgba: Uint8Array } | null,
  fallbackCursor: { x: number; y: number } | null = null,
): LayoutSnapshot {
  const slots = new Map<number, PatchPixels>();
  for (const s of layout.slots) {
    const p = samplePatchPixels(obsBase64, s.cx, s.cy, 14);
    if (p) slots.set(s.index, p);
  }
  // Sample CURSOR-RELATIVE: held-icon renders at a fixed offset from
  // the cursor sprite. Falls back to last-known cursor position when
  // the live cursor isn't detected (held items can occlude the sprite,
  // failing template match even though the cursor IS at park).
  const sampleAt = cursor ?? fallbackCursor;
  const cursorPatch = sampleAt
    ? samplePatchPixels(obsBase64, sampleAt.x + 8, sampleAt.y + 8, 14)
    : null;
  // Cursor-holding detection is too fragile to be load-bearing
  // (template match fails when held items occlude the sprite, sub-px
  // cursor jitter shifts the sample area). We keep cursorHolding for
  // diagnostics but classifyOutcome doesn't depend on it — slot delta
  // is the authoritative signal.
  let cursorHolding: boolean | null = null;
  if (cursorPatch && cursorBaseline
      && cursorPatch.w === cursorBaseline.w
      && cursorPatch.h === cursorBaseline.h) {
    cursorHolding = detectCursorHolding(cursorPatch, cursorBaseline);
  }
  return { slots, cursor: cursorPatch, cursorHolding, takenAt: step };
}

/** Diff two snapshots. Slot is "changed" when same-position pixel
 *  RMS exceeds threshold; classify direction by foreground mask
 *  fill on each side. */
export function diffSnapshots(s0: LayoutSnapshot, s1: LayoutSnapshot): SnapshotDiff {
  const slotChanges = new Map<number, SlotChange>();
  for (const [idx, before] of s0.slots) {
    const after = s1.slots.get(idx);
    if (!after) continue;
    const rms = patchPixelRms(before, after);
    if (rms <= SLOT_CHANGE_RMS) continue;
    const beforeFilled = isPatchFilled(before);
    const afterFilled = isPatchFilled(after);
    if (beforeFilled && !afterFilled) slotChanges.set(idx, "filled→empty");
    else if (!beforeFilled && afterFilled) slotChanges.set(idx, "empty→filled");
    else slotChanges.set(idx, "swapped");
  }
  // Cursor change derived from the per-snapshot cursorHolding flag
  // (BG-masked diff against empty baseline). Sprite-shift-tolerant.
  let cursorChange: SnapshotDiff["cursorChange"] = "unchanged";
  if (s0.cursorHolding !== null && s1.cursorHolding !== null) {
    if (!s0.cursorHolding && s1.cursorHolding) cursorChange = "empty→holding";
    else if (s0.cursorHolding && !s1.cursorHolding) cursorChange = "holding→empty";
  }
  return { slotChanges, cursorChange };
}

/** Identify a newly-filled slot by patch similarity against known
 *  items in slotMemory. Returns null when no match scores above the
 *  high-confidence threshold (caller falls back to cursor-held
 *  label or "unknown"). */
export function identifyChangedSlot(
  newPatch: PatchPixels,
  knownItems: Array<{ item: string; patch?: PatchPixels }>,
): { item: string; sim: number } | null {
  let bestItem: string | null = null;
  let bestSim = ID_MATCH_SIM;
  for (const k of knownItems) {
    if (!k.patch) continue;
    if (k.item === "empty" || k.item === "unknown") continue;
    const sim = patchSimilarity(k.patch, newPatch);
    if (sim > bestSim) {
      bestSim = sim;
      bestItem = k.item;
    }
  }
  return bestItem ? { item: bestItem, sim: bestSim } : null;
}

export type ActionIntent =
  | { kind: "pickup"; targetSlot: number }
  | { kind: "place_one"; targetSlot: number }
  | { kind: "place_all"; targetSlot: number };

export type Outcome =
  | { kind: "confirmed"; targetSlot: number; change: SlotChange; cursorChange: SnapshotDiff["cursorChange"] }
  | { kind: "drifted"; intendedSlot: number; actualSlot: number; change: SlotChange; cursorChange: SnapshotDiff["cursorChange"] }
  | { kind: "no_op" }
  | { kind: "anomaly"; reason: string };

/** Classify the diff against the action intent. SLOT delta is the
 *  authoritative signal; cursor-state detection is too fragile to
 *  gate on (sub-pixel sprite jitter, held-item sprite occlusion).
 *  Cursor-side state is INFERRED from the action kind + slot delta. */
export function classifyOutcome(intent: ActionIntent, diff: SnapshotDiff): Outcome {
  const targetChange = diff.slotChanges.get(intent.targetSlot);
  const totalSlotChanges = diff.slotChanges.size;
  const cursorChange = diff.cursorChange;

  const matchesIntent = (slotDelta: SlotChange | undefined): boolean => {
    if (!slotDelta) return false;
    if (intent.kind === "pickup") return slotDelta === "filled→empty";
    // place_all and place_one both expect the destination to fill.
    // Use "swapped" as success too — for place into a slot that
    // already held a different item, MC swaps and the dest patch
    // changes (different content).
    return slotDelta === "empty→filled" || slotDelta === "swapped";
  };

  // Confirmed when the target slot has the expected change. Additional
  // slot changes are common and benign:
  //   - place into the last empty craft cell auto-fills the result slot
  //   - placement near the cursor parking position can ripple through
  //   - the next-frame snapshot may catch a stack-count animation
  // We accept these as bonus information; the caller (runtime) writes
  // each observed change into slotMemory regardless.
  if (matchesIntent(targetChange)) {
    return { kind: "confirmed", targetSlot: intent.targetSlot, change: targetChange!, cursorChange };
  }
  // Drift: target unchanged but a different slot shows the matching pattern.
  if (!targetChange) {
    for (const [idx, ch] of diff.slotChanges) {
      if (matchesIntent(ch)) {
        return { kind: "drifted", intendedSlot: intent.targetSlot, actualSlot: idx, change: ch, cursorChange };
      }
    }
  }
  if (totalSlotChanges === 0) {
    return { kind: "no_op" };
  }
  return {
    kind: "anomaly",
    reason: `slotChanges=${totalSlotChanges} target=${targetChange ?? "(none)"} (intent=${intent.kind} slot ${intent.targetSlot})`,
  };
}
