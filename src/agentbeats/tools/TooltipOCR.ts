/**
 * Sub-agent that reads the Minecraft tooltip text from a frame captured
 * while the cursor was hovering over a specific slot.
 *
 * To avoid the LLM being fooled by always-on GUI text (window titles
 * like "Crafting", "Inventory"), the obs frame is CROPPED to a small
 * region around the cursor before being passed to the model. MC renders
 * tooltips to the right and slightly below the cursor; we crop a band
 * centered on the cursor position so the only readable text in the
 * cropped image is the actual tooltip (or nothing, if the slot is empty).
 *
 * Result is cached in SlotMemory keyed by absolute pixel position, so
 * the agent never has to re-hover the same slot.
 */
import type OpenAI from "openai";
import { getDebugRecorder } from "./DebugRecorder";

export type TooltipOCROpts = {
  client: OpenAI;
  model: string;
  obsBase64: string;
  /** Pixel pos of the slot the cursor was hovering. Used as the anchor
   *  for cropping the tooltip region out of the full obs frame. */
  slotPos: { x: number; y: number };
};

const SYSTEM_PROMPT = `You are an OCR-only sub-agent for Minecraft tooltips.

You are shown a SMALL CROPPED REGION around the player's cursor. The crop also contains CYAN NUMBERED BADGES drawn at the corner of each slot (e.g. "40", "41"). If a Minecraft tooltip box (a dark rectangle with white item name text floating near the cursor) is visible IN THIS CROP, the tooltip belongs to whichever slot the cursor is currently OVER -- read the slot's cyan badge number AND the item name from the tooltip.

STRICT RULES:
- If you can read both the slot's cyan badge AND a clear tooltip item name, return JSON: {"slot": <integer>, "item": "<snake_case_item>"} (e.g. {"slot": 42, "item": "cobblestone"}).
- If the crop shows only a slot icon with NO floating tooltip text box visible: {"slot": <integer or null>, "item": "empty"}.
- If you cannot identify the slot badge OR the tooltip text is unreadable: {"slot": null, "item": "unknown"}.
- NEVER guess the item from the slot icon alone. NEVER infer from window labels. Only return an item name if you can READ the tooltip text letter by letter.
- Item names: "Cobblestone" -> cobblestone, "Nether Quartz" -> nether_quartz, "Oak Planks" -> oak_planks, "Crafting Table" -> crafting_table.

Output exactly one JSON object. No commentary, no markdown fences.`;

const CROP_W = 140;
const CROP_H = 70;

export type TooltipOCRResult = { slot: number | null; item: string };

export async function readTooltip(opts: TooltipOCROpts): Promise<TooltipOCRResult> {
  // Crop the obs frame to a band centered on the cursor pos. MC tooltips
  // render to the right + below cursor, so anchor the crop's top-left at
  // (cursor.x - 20, cursor.y - 20) -- gives us 20px to the left of the
  // cursor (icon visibility) and ~120px to the right (tooltip body).
  let croppedB64 = opts.obsBase64;
  try {
    croppedB64 = await cropToCursor(opts.obsBase64, opts.slotPos.x, opts.slotPos.y);
  } catch (e) {
    console.warn(`[tooltip-ocr] crop failed (${e instanceof Error ? e.message : String(e)}); falling back to full frame`);
  }
  const cleaned = croppedB64.startsWith("data:image/")
    ? croppedB64
    : `data:image/png;base64,${croppedB64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  const userText = `Cropped region around the cursor at slot pixel (${Math.round(opts.slotPos.x)}, ${Math.round(opts.slotPos.y)}). Read any tooltip text or return empty.`;
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 12,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: cleaned, detail: "high" } },
        ],
      },
    ],
  };
  let raw = "";
  try {
    const resp = await opts.client.chat.completions.create(body as never);
    raw = (resp as unknown as { choices?: Array<{ message?: { content?: string } }> })
      .choices?.[0]?.message?.content ?? "";
  } catch (e) {
    console.warn(`[tooltip-ocr] LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
    return { slot: null, item: "unknown" };
  }
  // Parse the JSON {slot, item} response. Tolerate stray whitespace and
  // accidental markdown fences.
  const parsed: TooltipOCRResult = (() => {
    const cleanedRaw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      const obj = JSON.parse(cleanedRaw) as Record<string, unknown>;
      const slotRaw = obj.slot;
      const itemRaw = obj.item;
      const slot = typeof slotRaw === "number" && Number.isFinite(slotRaw) ? Math.round(slotRaw) : null;
      const item = typeof itemRaw === "string"
        ? itemRaw.trim().toLowerCase().replace(/[^a-z0-9_]/g, "") || "unknown"
        : "unknown";
      return { slot, item };
    } catch {
      // Tolerate the legacy "just an item word" output if the model slips.
      const fallback = cleanedRaw.toLowerCase().replace(/[^a-z0-9_]/g, "");
      return { slot: null, item: fallback || "unknown" };
    }
  })();
  // Debug: persist the crop + the raw response so we can audit OCR errors.
  const dbg = getDebugRecorder();
  if (dbg.isEnabled()) {
    dbg.record({
      type: "tooltip_ocr",
      data: { slotPos: opts.slotPos, raw, parsed },
    }, croppedB64, "png");
  }
  return parsed;
}

async function cropToCursor(obsBase64: string, cursorX: number, cursorY: number): Promise<string> {
  // Lazy require so the cost is only paid when OCR actually runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jpegLib = require("jpeg-js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PNG } = require("pngjs");
  const cleaned = obsBase64.startsWith("data:image/")
    ? obsBase64.replace(/^data:image\/[a-z]+;base64,/, "")
    : obsBase64;
  const inBuf = Buffer.from(cleaned, "base64");
  const decoded = jpegLib.decode(inBuf, { useTArray: true, formatAsRGBA: true });
  const w = decoded.width as number;
  const h = decoded.height as number;
  // Anchor crop so the cursor sits 20px from the left edge -- the rest
  // of the crop captures the tooltip body to the cursor's right/below.
  const x0 = Math.max(0, Math.min(w - CROP_W, Math.round(cursorX) - 20));
  const y0 = Math.max(0, Math.min(h - CROP_H, Math.round(cursorY) - 20));
  const out = new PNG({ width: CROP_W, height: CROP_H });
  for (let y = 0; y < CROP_H; y += 1) {
    for (let x = 0; x < CROP_W; x += 1) {
      const srcIdx = ((y0 + y) * w + (x0 + x)) * 4;
      const dstIdx = (y * CROP_W + x) * 4;
      // jpeg-js with formatAsRGBA produces BGR-encoded data on this sim
      // (same swap that DebugRecorder applies). Re-swap so the OCR
      // model sees true colors.
      out.data[dstIdx] = decoded.data[srcIdx + 2];
      out.data[dstIdx + 1] = decoded.data[srcIdx + 1];
      out.data[dstIdx + 2] = decoded.data[srcIdx];
      out.data[dstIdx + 3] = 255;
    }
  }
  const png = PNG.sync.write(out);
  return png.toString("base64");
}
