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
import type { GuiLayout } from "./SlotDetector";

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
  // Group slots by role for compact listing.
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

export type CraftAction =
  | { action: "pickup"; slot: number; reason?: string }       // attack-click slot to grab whole stack
  | { action: "place_one"; slot: number; reason?: string }    // use-click slot to drop ONE item from cursor
  | { action: "place_all"; slot: number; reason?: string }    // attack-click slot to deposit whole held stack
  | { action: "take"; slot: number; reason?: string }         // attack-click result slot
  | { action: "done"; reason?: string };

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
  /** Last few actions executed (most recent first) so the VLM doesn't
   *  repeat itself. Each entry is a short label like "pickup slot 0". */
  recentActions?: string[];
}): Promise<CraftProbeResult> {
  // Set-of-Mark: render the obs frame with numbered badges drawn at every
  // slot's pixel center so the VLM grounds slot indices visually instead of
  // mentally projecting from a text description.
  let imgBase64: string;
  let imgMime: "image/png" | "image/jpeg";
  let detectedLayout: GuiLayout | null = null;
  try {
    const marked = markInventoryFrame(opts.obsBase64);
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

  const promptText = [
    `You are controlling a Minecraft inventory GUI (640x360 image) to craft ${opts.taskTarget} from ${opts.ingredient}.`,
    "",
    `The image has YELLOW NUMBERED BADGES drawn at the corner of each slot.`,
    `Use the visible numbers to choose a slot. Pick the index of the slot you mean.`,
    buildSlotDescription(detectedLayout),
    "",
    `Recent actions you've already executed (do NOT repeat the same one if state hasn't changed):`,
    historyText,
    "",
    "Look at the image and decide the SINGLE NEXT action that best advances the task.",
    "",
    "Respond with strict JSON only (no markdown fences, no commentary):",
    `  {"action": "pickup",    "slot": N, "reason": "..."}  -- left-click slot N to grab whole stack`,
    `  {"action": "place_one", "slot": N, "reason": "..."}  -- right-click slot N to drop ONE item from cursor`,
    `  {"action": "place_all", "slot": N, "reason": "..."}  -- left-click slot N to drop whole held stack`,
    `  {"action": "take",      "slot": N, "reason": "..."}  -- left-click slot N (use this for a RESULT slot)`,
    `  {"action": "done",                  "reason": "..."} -- task complete; ${opts.taskTarget} is in inventory`,
    "",
    `Standard crafting flow for ${opts.taskTarget}:`,
    `  1. If craft grid is empty: pickup the ${opts.ingredient} stack from whichever slot contains it (look at the marked image)`,
    `  2. If cursor is holding ${opts.ingredient}: place_one into a craft grid slot (role=craft_2x2 or craft_3x3)`,
    `  3. If a RESULT slot (role=result) contains ${opts.taskTarget}: take from that slot`,
    `  4. If ${opts.taskTarget} is in your inventory: done`,
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
  if (action === "done") return { action: { action: "done", reason }, layout: detectedLayout };
  if (!Number.isFinite(slot) || slot < 0 || slot > 40) {
    return { action: null, layout: detectedLayout };
  }
  if (action === "pickup" || action === "place_one" || action === "place_all" || action === "take") {
    return { action: { action, slot, reason }, layout: detectedLayout };
  }
  return { action: null, layout: detectedLayout };
}

