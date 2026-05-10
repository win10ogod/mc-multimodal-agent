/**
 * Inventory perception primitives.
 *
 * - probeHotbar: legacy one-shot probe to map candidate items to hotbar
 *   slots (used by the open-loop macro path).
 * - vlmVerifySlotState: ad-hoc per-slot VLM verify.
 * - CraftAction: shared action type used by the FastUI Action subagent.
 *
 * Note: the closed-loop CraftAction probe (probeNextCraftAction) was
 * removed once the FastUI Action subagent took over single-step
 * dispatch. The legacy probe's CraftAction schema lacked a "drop one
 * from cursor" primitive — the LLM had to use `put` (= dump whole
 * stack) mid-recipe and corrupted multi-cell ingredient placements.
 * The FastUI Action enum has both place_one and place_all, so it
 * expresses the correct intent.
 */
import type OpenAI from "openai";

// Hotbar slot pixel centers when the inventory GUI is open at 640x360 obs.
// Mirrors the SLOT.hotbarX0/Dx/Y constants in UiFastControl.
const HOTBAR_X0 = 215;
const HOTBAR_DX = 18;
const HOTBAR_Y = 218;

/** Module-scoped monotonic counter for probe-prompt debug dumps so the
 *  filename is unique across the whole episode (plan.iteration resets
 *  whenever the UI session resets). */
let PROBE_PROMPT_SEQ = 0;

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

/** Single-step intent the FastUI Action subagent emits. Each variant
 *  is one click (or a deterministic noop / done / batch-OCR). The
 *  legacy probe schema's `move` / `put` / `recipe_lookup` / `take`
 *  variants are gone — see InventoryProbe.ts header for the rationale.
 */
export type CraftAction =
  | { action: "pickup"; slot: number; reason?: string }
  | { action: "place_one"; slot: number; reason?: string }
  | { action: "place_all"; slot: number; reason?: string }
  | { action: "verify_slots"; slots: number[]; reason?: string }
  | { action: "wait"; holdSteps: number; reason?: string }
  | { action: "done"; reason?: string }
  | { action: "fallback_manual"; reason?: string };
