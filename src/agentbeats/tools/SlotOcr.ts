/**
 * Slot tooltip OCR sub-agent.
 *
 * Reads the floating Minecraft tooltip text from a frame captured
 * while the cursor is hovering over a single slot. Tooltips contain
 * unambiguous item names (e.g. "Cobblestone" vs "Bone Meal" vs
 * "Nether Quartz") that disambiguate items whose icons look similar
 * at native 18x18 resolution.
 *
 * The crop is wide enough to include the cursor + the floating
 * tooltip box that MC renders to the right and slightly below the
 * cursor. The R/B swap is applied here so the LLM sees true colors
 * (the MC sim outputs JPEGs whose jpeg-js decode comes out BGR).
 *
 * Caller (McuPolicy) is responsible for ensuring the cursor is
 * actually parked on the slot before invoking; we just OCR whatever
 * frame is given.
 */
import type OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";

export type SlotOcrOpts = {
  client: OpenAI;
  model: string;
  obsBase64: string;
  /** Pixel center of the slot the cursor was hovered over. */
  slotPos: { x: number; y: number };
  /** Optional slot label for prompt context (e.g. "hotbar_3"). */
  slotName?: string;
};

export type SlotOcrResult = { item: string };

const SYSTEM_PROMPT = `You are a Minecraft tooltip OCR sub-agent.

You are shown a CROPPED REGION of a Minecraft inventory frame. The cursor is currently hovered over ONE slot; MC has rendered a floating tooltip box (a dark rectangle with white item name text) near the cursor. Your only job: read the item NAME line of the tooltip.

STRICT RULES:
- If a clear floating tooltip text is visible: return JSON {"item": "<snake_case_identifier>"}.
- Use snake_case names: "Cobblestone" -> cobblestone, "Nether Quartz" -> nether_quartz, "Oak Planks" -> oak_planks, "Crafting Table" -> crafting_table, "Bone Meal" -> bone_meal.
- If NO tooltip text is visible (slot is empty or tooltip not rendered): {"item": "empty"}.
- If the tooltip text is unreadable: {"item": "unknown"}.
- NEVER guess from the slot icon. Only return a name if you can READ THE TOOLTIP TEXT letter by letter.

Output ONLY the JSON object. No markdown fences. No commentary.`;

const ZOOM = 3;
const SRC_W = 160;
const SRC_H = 80;

export async function readTooltip(opts: SlotOcrOpts): Promise<SlotOcrResult> {
  let cropB64 = opts.obsBase64;
  try {
    cropB64 = cropTooltipRegion(opts.obsBase64, opts.slotPos.x, opts.slotPos.y);
  } catch (e) {
    console.warn(`[slot-ocr] crop failed (${e instanceof Error ? e.message : String(e)}); falling back to full frame`);
  }
  const url = cropB64.startsWith("data:image/")
    ? cropB64
    : `data:image/png;base64,${cropB64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  const userText = `Read the tooltip text in this Minecraft inventory frame. Cursor is hovering over slot ${opts.slotName ?? `at pixel (${Math.round(opts.slotPos.x)},${Math.round(opts.slotPos.y)})`}.`;
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: 0,
    max_completion_tokens: 64,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url, detail: "high" } },
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
    console.warn(`[slot-ocr] LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
    return { item: "unknown" };
  }
  const parsed: SlotOcrResult = (() => {
    const cleanedRaw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      const obj = JSON.parse(cleanedRaw) as Record<string, unknown>;
      const itemRaw = obj.item;
      const item = typeof itemRaw === "string"
        ? itemRaw.trim().toLowerCase().replace(/[^a-z0-9_]/g, "") || "unknown"
        : "unknown";
      return { item };
    } catch {
      const m = cleanedRaw.toLowerCase().match(/[a-z][a-z0-9_]+/);
      return { item: m ? m[0] : "unknown" };
    }
  })();
  const debugDir = process.env.AGENTBEATS_DEBUG_DIR;
  if (debugDir) {
    try {
      const seq = String(++DEBUG_SEQ).padStart(5, "0");
      const fname = `${seq}_slot_ocr.png`;
      fs.writeFileSync(path.join(debugDir, fname), Buffer.from(cropB64, "base64"));
      const line = JSON.stringify({
        seq: DEBUG_SEQ,
        ts: new Date().toISOString(),
        type: "slot_ocr",
        imageFile: fname,
        data: { slotPos: opts.slotPos, slotName: opts.slotName, raw, parsed },
      });
      fs.appendFileSync(path.join(debugDir, "events.jsonl"), line + "\n");
    } catch (e) {
      console.warn(`[slot-ocr] debug write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parsed;
}

let DEBUG_SEQ = 200000;

function cropTooltipRegion(obsBase64: string, slotX: number, slotY: number): string {
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
  // Anchor the crop so the slot sits 20 px from the left edge -- MC
  // renders the tooltip to the right and below the cursor, so the
  // remaining ~140 px captures the tooltip body. Crop height covers
  // typical tooltip vertical extent.
  const sx0 = Math.max(0, Math.min(w - SRC_W, Math.round(slotX) - 20));
  const sy0 = Math.max(0, Math.min(h - SRC_H, Math.round(slotY) - 20));
  const outW = SRC_W * ZOOM;
  const outH = SRC_H * ZOOM;
  const out = new PNG({ width: outW, height: outH });
  for (let oy = 0; oy < outH; oy += 1) {
    const sy = sy0 + Math.floor(oy / ZOOM);
    for (let ox = 0; ox < outW; ox += 1) {
      const sx = sx0 + Math.floor(ox / ZOOM);
      const srcIdx = (sy * w + sx) * 4;
      const dstIdx = (oy * outW + ox) * 4;
      out.data[dstIdx] = decoded.data[srcIdx + 2];
      out.data[dstIdx + 1] = decoded.data[srcIdx + 1];
      out.data[dstIdx + 2] = decoded.data[srcIdx];
      out.data[dstIdx + 3] = 255;
    }
  }
  return PNG.sync.write(out).toString("base64");
}
