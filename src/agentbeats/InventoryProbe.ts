/**
 * Set-of-Mark style inventory probes for closed-loop crafting control.
 *
 * - probeHotbar: legacy one-shot probe to map candidate items to hotbar
 *   slots (used by the open-loop macro path).
 * - probeNextCraftAction: closed-loop probe that asks the VLM to decide
 *   the SINGLE next inventory action (pickup / place / take / done) given
 *   the current frame and the recipe target. The agent re-probes after
 *   each action completes -- VLMs are weak at pixel coords but strong at
 *   "which slot has X", so we let it reason in slot indices and translate
 *   to deterministic cursor moves on our side.
 */
import type OpenAI from "openai";
import { markInventoryFrame } from "./SlotMarker";
import { samplePatchFingerprint, type GuiLayout } from "./SlotDetector";

// Hotbar slot pixel centers when the inventory GUI is open at 640x360 obs.
// Mirrors the SLOT.hotbarX0/Dx/Y constants in UiFastControl.
const HOTBAR_X0 = 215;
const HOTBAR_DX = 18;
const HOTBAR_Y = 218;

function buildHotbarOnlyDescription(): string {
  const lines = ["The bottom row inside the inventory window is the HOTBAR with 9 slots numbered 0-8 from LEFT to RIGHT."];
  lines.push("Approximate pixel centers of each hotbar slot in this 640x360 image:");
  for (let i = 0; i < 9; i += 1) {
    lines.push(`  slot ${i}: x=${HOTBAR_X0 + i * HOTBAR_DX}, y=${HOTBAR_Y}`);
  }
  return lines.join("\n");
}

export type HotbarProbeResult = Map<number, string>;

export async function probeHotbar(opts: {
  client: OpenAI;
  model: string;
  obsBase64: string;
  candidates: string[];
}): Promise<HotbarProbeResult> {
  if (opts.candidates.length === 0) return new Map();

  const promptText = [
    "You are looking at an open Minecraft inventory GUI (image is 640x360 px).",
    buildHotbarOnlyDescription(),
    "",
    `For EACH of these candidate items, tell me which hotbar slot index (0..8) currently contains it, or "none" if absent: ${opts.candidates.join(", ")}`,
    "",
    'Respond ONLY with strict JSON, no markdown fences, e.g.:',
    '{"oak_log": 0, "crafting_table": 1, "apple": "none"}',
  ].join("\n");

  const dataUrl = opts.obsBase64.startsWith("data:image/")
    ? opts.obsBase64
    : `data:image/jpeg;base64,${opts.obsBase64}`;

  // gpt-5.x rejects max_tokens; use max_completion_tokens. The SDK types
  // don't always expose it directly, so we build the body as a loose object
  // and cast at the call site.
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
  };
  type Create = typeof opts.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const completion = await opts.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };

  const raw = completion.choices[0]?.message?.content ?? "";
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract a JSON object with regex
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* give up */ }
    }
  }

  const out = new Map<number, string>();
  for (const [item, slotRaw] of Object.entries(parsed)) {
    const slot = typeof slotRaw === "number"
      ? slotRaw
      : typeof slotRaw === "string" && /^\d+$/.test(slotRaw)
        ? Number(slotRaw)
        : -1;
    if (slot >= 0 && slot <= 8) {
      out.set(slot, item);
    }
  }
  return out;
}

// --- Closed-loop GUI actions --------------------------------------------

/** Build a per-frame slot description from the detected GuiLayout, listing
 *  each visible slot's raster index and (when known) its semantic role.
 *  This replaces the previous hard-coded "0..8 = hotbar" mapping which
 *  only worked for one specific GUI numbering scheme. */
/** Build a textual slot listing annotated with CV-detected fill state
 *  (`*` = filled, `.` = empty). Lets the VLM pick a known-empty
 *  destination slot when storing crafted output instead of accidentally
 *  picking the source slot (which was just refilled by auto-return) and
 *  triggering an item swap. */
function buildSlotDescription(layout: GuiLayout, jpegBase64?: string): string {
  // Sample a 12x12 patch at every slot center to classify filled/empty.
  // Threshold matches the verify check in McuPolicy: stddev > 35 = filled.
  const fillByIndex = new Map<number, "filled" | "empty">();
  if (jpegBase64) {
    for (const s of layout.slots) {
      const patch = samplePatchFingerprint(jpegBase64, s.cx, s.cy, 12);
      if (!patch) continue;
      fillByIndex.set(s.index, patch.stddev > 35 ? "filled" : "empty");
    }
  }
  const tag = (i: number): string => {
    const f = fillByIndex.get(i);
    if (f === "filled") return `${i}*`;
    if (f === "empty") return `${i}.`;
    return `${i}`;
  };

  const lines: string[] = [
    `${layout.slots.length} slots are marked on the image with yellow numbered badges (raster order). Fill state: '*' = slot has an item, '.' = slot is empty.`,
  ];
  if (layout.matchedLayoutId) {
    lines.push(`Detected GUI: ${layout.matchedLayoutId}.`);
  } else {
    lines.push(`Detected GUI: unknown — slots numbered in raster order.`);
  }
  const byRole = new Map<string, number[]>();
  const anonymous: number[] = [];
  for (const s of layout.slots) {
    if (s.role) {
      const list = byRole.get(s.role) ?? [];
      list.push(s.index);
      byRole.set(s.role, list);
    } else {
      anonymous.push(s.index);
    }
  }
  for (const [role, idxs] of byRole) {
    lines.push(`  role=${role}: ${idxs.map(tag).join(", ")}`);
  }
  if (anonymous.length > 0) {
    lines.push(`  unrecognized slots: ${anonymous.map(tag).join(", ")}`);
  }
  return lines.join("\n");
}

export type CraftAction =
  // High-level atomic operations the VLM should prefer:
  | { action: "move"; from: number; to: number; count?: "one" | "all"; reason?: string }
  | { action: "put"; slot: number; reason?: string }   // dump whole cursor stack into slot
  | { action: "done"; reason?: string }
  | { action: "fallback_manual"; reason?: string }
  // Low-level operations kept for backwards compatibility / fine-grained
  // control if the VLM still emits them; new prompts steer toward
  // move / put / done.
  | { action: "pickup"; slot: number; reason?: string }
  | { action: "place_one"; slot: number; reason?: string }
  | { action: "place_all"; slot: number; reason?: string }
  | { action: "take"; slot: number; reason?: string };

export type CraftProbeResult = {
  action: CraftAction | null;
  /** The CV-detected slot layout from this probe's frame. McuPolicy passes
   *  it back to the cursor compiler so the click lands at the SAME pixel
   *  position the VLM saw labeled, not a stale hardcoded one. */
  layout: GuiLayout | null;
};

export async function probeNextCraftAction(opts: {
  client: OpenAI;
  model: string;
  obsBase64: string;
  taskTarget: string;        // e.g. "oak_planks"
  ingredient: string;        // e.g. "oak_log"
  iteration: number;         // for logging / nudging the model
  /** Session-locked layout so marks stay at fixed positions/indices. */
  sessionLayout?: GuiLayout | null;
  recentActions?: string[];
  /** CV-derived cursor state (true = cursor is carrying an item icon). */
  cursorHolding?: boolean | null;
  /** Slot the agent originally picked the ingredient up from, so the VLM
   *  can return leftover items to the same place after place_one. */
  pickupSourceSlot?: { index: number; name?: string } | null;
}): Promise<CraftProbeResult> {
  // Set-of-Mark: render the obs frame with numbered badges drawn at every
  // slot's pixel center so the VLM grounds slot indices visually instead of
  // mentally projecting from a text description.
  let imgBase64: string;
  let imgMime: "image/png" | "image/jpeg";
  let detectedLayout: GuiLayout | null = null;
  try {
    const marked = markInventoryFrame(opts.obsBase64, opts.sessionLayout ?? null);
    imgBase64 = marked.pngBase64;
    imgMime = "image/png";
    detectedLayout = marked.layout;
  } catch (e) {
    console.warn(`[agentbeats] SoM render failed (${e instanceof Error ? e.message : String(e)}); using raw frame`);
    imgBase64 = opts.obsBase64.replace(/^data:image\/[a-z]+;base64,/, "");
    imgMime = "image/jpeg";
  }
  // No inventory window detected -> the GUI isn't actually open. Don't burn
  // a VLM call on a world-view frame; signal "no UI" so the policy can defer
  // to the regular LLM path or re-issue an open-inventory action.
  if (detectedLayout === null) {
    return { action: null, layout: null };
  }

  const historyLines = (opts.recentActions ?? []).slice(0, 3);
  const historyText = historyLines.length === 0
    ? "(none yet)"
    : historyLines.map((a, i) => `  ${i === 0 ? "most recent" : `${i + 1} ago`}: ${a}`).join("\n");

  const cursorState = opts.cursorHolding === true
    ? "CURSOR IS CARRYING AN ITEM (CV-detected)."
    : opts.cursorHolding === false
      ? "CURSOR IS EMPTY (CV-detected)."
      : "CURSOR STATE UNKNOWN.";
  const sourceLine = opts.pickupSourceSlot
    ? `Original ingredient source slot: index ${opts.pickupSourceSlot.index}${opts.pickupSourceSlot.name ? ` (${opts.pickupSourceSlot.name})` : ""}. The tool already returns leftover ingredient back to this slot automatically -- do NOT use it as a destination for the crafted result; pick a DIFFERENT empty slot (look for a "." mark in the slot listing) for the result.`
    : "No pickup source recorded yet.";

  const promptText = [
    `You are controlling a Minecraft inventory GUI (640x360 image) to craft ${opts.taskTarget} from ${opts.ingredient}.`,
    "",
    `The image has YELLOW NUMBERED BADGES drawn at the corner of each slot.`,
    `Use the visible numbers to choose a slot. Pick the index of the slot you mean.`,
    buildSlotDescription(detectedLayout, opts.obsBase64),
    "",
    `State:`,
    `  ${cursorState}`,
    `  ${sourceLine}`,
    "",
    `Recent actions you've already executed (do NOT repeat the same one if state hasn't changed):`,
    historyText,
    "",
    "Look at the image and decide the SINGLE NEXT action that best advances the task.",
    "",
    "Respond with strict JSON only (no markdown fences, no commentary):",
    `  {"action": "move", "from": A, "to": B, "count": "one"|"all", "reason": "..."} -- ATOMIC. Tool picks the stack from A, places into B (one item if count=one, whole stack if count=all), and automatically returns any remainder to A. Use this for the main craft step (count=one to drop one log into a craft slot) and for moving the result into your inventory (count=all).`,
    `  {"action": "put",  "slot": N, "reason": "..."} -- dump whatever the cursor is currently holding into slot N as a whole stack. Use only when the cursor is already holding something and you want to put it down.`,
    `  {"action": "fallback_manual", "reason": "..."} -- SoM marks do NOT cover the slot you need (UI too complex for our detector); hand control back to the manual LLM controller`,
    "",
    "Do NOT return a 'done' action -- task completion is decided by a different controller, not by you. Always emit the next move or put step that advances the task; if everything is already placed and the result is sitting in role=result, your next step is to move it out into a role=hotbar or role=main_inv slot.",
    "",
    `Strategy:`,
    `  Prefer the high-level "move" and "put" actions. The tool handles cursor state, swaps, and remainder-return automatically -- you only describe the intent one step at a time and we execute it. After each step the tool re-shows you the marked image so you can plan the next step.`,
    "",
    `Required flow for ${opts.taskTarget}:`,
    `  1. "move" one ${opts.ingredient} from a hotbar/main_inv slot (role=hotbar or main_inv) into a craft grid slot (role=craft_2x2 or craft_3x3) with count="one".`,
    `  2. "move" the result (role=result, after recipe completes) into any EMPTY main_inv or hotbar slot with count="all".`,
    `  3. Return "done" when ${opts.taskTarget} is visible in inventory.`,
    "",
    `This is iteration ${opts.iteration}. Return ONLY the JSON action.`,
  ].join("\n");
  const dataUrl = `data:${imgMime};base64,${imgBase64}`;

  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 200,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
  };
  type Create = typeof opts.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const completion = await opts.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };

  const raw = completion.choices[0]?.message?.content ?? "";
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { /* give up */ }
    }
  }
  if (!parsed || typeof parsed.action !== "string") {
    return { action: null, layout: detectedLayout };
  }

  const action = String(parsed.action);
  const slot = typeof parsed.slot === "number" ? parsed.slot : Number(parsed.slot);
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  // Slot indices range 0..(layout.slots.length-1). Some inventories
  // have 41+ slots (player_inventory has 49). Old hardcoded "<=40"
  // bound was rejecting valid high-index picks.
  const maxSlot = (detectedLayout?.slots.length ?? 41) - 1;
  if (action === "done") return { action: { action: "done", reason }, layout: detectedLayout };
  if (action === "fallback_manual") return { action: { action: "fallback_manual", reason }, layout: detectedLayout };
  if (action === "move") {
    const fromRaw = parsed.from;
    const toRaw = parsed.to;
    const from = typeof fromRaw === "number" ? fromRaw : Number(fromRaw);
    const to = typeof toRaw === "number" ? toRaw : Number(toRaw);
    if (!Number.isFinite(from) || from < 0 || from > maxSlot) {
      console.warn(`[agentbeats] probe parse: move from=${from} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    if (!Number.isFinite(to) || to < 0 || to > maxSlot) {
      console.warn(`[agentbeats] probe parse: move to=${to} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    const count: "one" | "all" = parsed.count === "all" ? "all" : "one";
    return { action: { action: "move", from, to, count, reason }, layout: detectedLayout };
  }
  if (action === "put") {
    if (!Number.isFinite(slot) || slot < 0 || slot > maxSlot) {
      console.warn(`[agentbeats] probe parse: put slot=${slot} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    return { action: { action: "put", slot, reason }, layout: detectedLayout };
  }
  if (!Number.isFinite(slot) || slot < 0 || slot > maxSlot) {
    console.warn(`[agentbeats] probe parse: ${action} slot=${slot} out of range 0..${maxSlot}`);
    return { action: null, layout: detectedLayout };
  }
  if (action === "pickup" || action === "place_one" || action === "place_all" || action === "take") {
    return { action: { action, slot, reason }, layout: detectedLayout };
  }
  return { action: null, layout: detectedLayout };
}

