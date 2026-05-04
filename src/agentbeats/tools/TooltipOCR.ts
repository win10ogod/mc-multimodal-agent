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

You are shown a SMALL CROPPED REGION around the player's cursor. If a Minecraft tooltip box (a dark rectangle with white item name text floating near the cursor) is visible IN THIS CROP, read the item name line.

STRICT RULES:
- If you see a clear floating tooltip box with readable text, return the item identifier in snake_case (e.g. "Cobblestone" -> cobblestone, "Nether Quartz" -> nether_quartz, "Oak Planks" -> oak_planks).
- If the crop shows only a slot icon with NO floating tooltip text box visible -> return exactly: empty
- If the crop is too blurry / text is unreadable -> return exactly: unknown
- NEVER guess from the slot icon alone. NEVER infer from window labels. NEVER make up an item name. Only return a name if you can READ the tooltip text letter by letter.

Output exactly one token. No quotes. No commentary.`;

const CROP_W = 140;
const CROP_H = 70;

export async function readTooltip(opts: TooltipOCROpts): Promise<string> {
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
    return "unknown";
  }
  const out = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  // Debug: persist the crop + the raw response so we can audit OCR errors.
  const dbg = getDebugRecorder();
  if (dbg.isEnabled()) {
    dbg.record({
      type: "tooltip_ocr",
      data: { slotPos: opts.slotPos, raw, parsed: out || "unknown" },
    }, croppedB64, "png");
  }
  return out || "unknown";
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
