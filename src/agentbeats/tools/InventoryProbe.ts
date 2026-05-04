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
import { markInventoryFrame } from "../SlotMarker";
import type { GuiLayout } from "./SlotDetector";
import { getDebugRecorder } from "./DebugRecorder";

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
function buildSlotDescription(layout: GuiLayout): string {
  const lines: string[] = [
    `${layout.slots.length} slots are marked on the image with yellow numbered badges (raster order).`,
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
    lines.push(`  role=${role}: indices ${idxs.join(", ")}`);
  }
  if (anonymous.length > 0) {
    lines.push(`  unrecognized slots: indices ${anonymous.join(", ")}`);
  }
  return lines.join("\n");
}

/** Cheap VLM sub-verify: given an obs frame, a target slot pixel, and
 *  the expected post-click state ("should_empty" or "should_fill"),
 *  ask the VLM whether the slot matches. Used as a second-opinion gate
 *  when CV patch sampling reports a mismatch (CV is fooled by rendering
 *  noise around freshly-emptied slots, ambiguous icon variance, etc.).
 *  Returns true iff the VLM agrees the expected state holds. */
export async function vlmVerifySlotState(opts: {
  client: OpenAI;
  model: string;
  obsBase64: string;
  slot: { cx: number; cy: number; name?: string };
  expectAfter: "should_empty" | "should_fill";
  taskTarget: string;
}): Promise<boolean | null> {
  const desc = opts.expectAfter === "should_empty"
    ? `EMPTY (no item icon visible inside it)`
    : `FILLED (an item icon is visible inside it)`;
  const slotLabel = opts.slot.name ? `slot "${opts.slot.name}" near pixel (${opts.slot.cx}, ${opts.slot.cy})` : `the slot at pixel (${opts.slot.cx}, ${opts.slot.cy})`;
  const prompt = [
    `In this 640x360 Minecraft inventory frame, look at ${slotLabel}.`,
    `Is that slot ${desc}?`,
    `Answer with strict JSON only, no commentary: {"empty": true|false, "filled": true|false}`,
  ].join(" ");
  const dataUrl = opts.obsBase64.startsWith("data:image/")
    ? opts.obsBase64
    : `data:image/jpeg;base64,${opts.obsBase64}`;
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 60,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
      ],
    }],
  };
  type Create = typeof opts.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  try {
    const completion = await opts.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
      choices: Array<{ message?: { content?: string | null } }>;
    };
    const raw = completion.choices[0]?.message?.content ?? "";
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    let parsed: { empty?: boolean; filled?: boolean } = {};
    try { parsed = JSON.parse(cleaned); } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* give up */ } }
    }
    if (typeof parsed.empty !== "boolean" && typeof parsed.filled !== "boolean") return null;
    const isEmpty = parsed.empty === true || parsed.filled === false;
    const isFilled = parsed.filled === true || parsed.empty === false;
    if (opts.expectAfter === "should_empty") return isEmpty && !isFilled;
    return isFilled && !isEmpty;
  } catch (e) {
    console.warn(`[agentbeats] vlmVerifySlotState failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export type CraftAction =
  // High-level atomic operations the VLM should prefer:
  | { action: "move"; from: number; to: number; count?: "one" | "all"; reason?: string }
  | { action: "put"; slot: number; reason?: string }   // dump whole cursor stack into slot
  | { action: "hover"; slot: number; reason?: string } // move cursor over slot, no click; reveals MC tooltip
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
  /** Raw task text. Probe is task-agnostic and just reasons over the
   *  marked image + this string. No more crafting-specific
   *  taskTarget/ingredient hints -- the VLM extracts those itself. */
  taskText: string;
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
    `You are operating a Minecraft GUI (640x360 image) to advance the user's task.`,
    `Task: ${opts.taskText}`,
    "",
    `The image has YELLOW NUMBERED BADGES drawn at the corner of each slot.`,
    `Use the visible numbers to choose a slot. Pick the index of the slot you mean.`,
    buildSlotDescription(detectedLayout),
    "",
    `State:`,
    `  ${cursorState}`,
    `  ${sourceLine}`,
    "",
    `Recent actions you've already executed (do NOT repeat the same one if state hasn't changed):`,
    historyText,
    "",
    "Look at the image and decide the SINGLE NEXT action that best advances the task. The available GUIs include the player inventory's 2x2 craft grid, furnace, brewing stand, chest, anvil, enchanting table, villager trade window, etc. -- the same actions below work in any of them; you just pick the slot indices that match the GUI you see.",
    "",
    "Respond with strict JSON only (no markdown fences, no commentary):",
    `  {"action": "move", "from": A, "to": B, "count": "one"|"all", "reason": "...", "subTask": "..."} -- ATOMIC. Tool picks the stack from A, places into B (one item if count=one, whole stack if count=all), and automatically returns any remainder to A.`,
    `  {"action": "put",  "slot": N, "reason": "...", "subTask": "..."} -- dump whatever the cursor is currently holding into slot N as a whole stack. Use only when the cursor already holds something.`,
    `  {"action": "hover","slot": N, "reason": "...", "subTask": "..."} -- move the cursor over slot N WITHOUT clicking. MC will render the item tooltip on the next probe image so you can read what is in that slot. Use when uncertain about a slot's contents.`,
    `  {"action": "fallback_manual", "reason": "..."} -- SoM marks do NOT cover the slot you need; hand control back to the manual LLM controller.`,
    `  {"action": "done", "reason": "...", "subTask": "..."} -- ONLY when (a) any recipe result slot in view is empty AND (b) the requested target is visibly stored in a regular inventory slot. Tool may CV-verify before accepting.`,
    "",
    `subTask field (optional but recommended for long-horizon tasks): a SHORT label of the current sub-goal you are advancing (e.g. "place_logs_in_grid", "take_planks_to_inv", "open_furnace", "deposit_diamond_in_chest"). This is echoed back to you on the NEXT probe so you can keep track of where you are across many steps. Keep stable across consecutive iterations of the same sub-goal.`,
    "",
    `Rule: when the cursor is carrying an item, "to" must be either (a) a visually empty slot, OR (b) a slot containing the SAME item as what the cursor holds (will stack). Placing onto a slot with a DIFFERENT item triggers a swap. If you must deposit into a slot occupied by a different item: (1) "put" current held item into an empty side slot, (2) next probe: "move" the blocking item to another empty slot, (3) next probe: "move" the parked item to the now-empty target.`,
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
  // Debug: record the marked image + prompt the VLM is about to see.
  const dbg = getDebugRecorder();
  if (dbg.isEnabled()) {
    dbg.record({
      type: "probe_input",
      iteration: opts.iteration,
      data: {
        taskText: opts.taskText,
        cursorHolding: opts.cursorHolding,
        pickupSourceSlot: opts.pickupSourceSlot ?? null,
        recentActions: opts.recentActions ?? [],
        layoutId: detectedLayout.matchedLayoutId,
        slots: detectedLayout.slots.map((s) => ({ index: s.index, name: s.name, role: s.role, cx: s.cx, cy: s.cy })),
        prompt: promptText,
      },
    }, imgBase64, imgMime === "image/png" ? "png" : "jpg");
  }
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
  if (dbg.isEnabled()) {
    dbg.record({
      type: "probe_output",
      iteration: opts.iteration,
      data: { raw, parsed },
    });
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
  if (action === "hover") {
    if (!Number.isFinite(slot) || slot < 0 || slot > maxSlot) {
      console.warn(`[agentbeats] probe parse: hover slot=${slot} out of range 0..${maxSlot}`);
      return { action: null, layout: detectedLayout };
    }
    return { action: { action: "hover", slot, reason }, layout: detectedLayout };
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

