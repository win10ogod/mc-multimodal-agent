/**
 * Slot perception sub-agent.
 *
 * For each requested slot the runtime crops the slot's BBOX (with a
 * small outer margin so the slot frame is visible) from the current
 * obs frame, upscales it for legibility, and asks the VLM "what item
 * is in this slot?". No cursor movement, no tooltip dependency, no
 * timing race. All slots in a verify_slots batch run in parallel
 * from a single obs frame.
 */
import type OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";

export type SlotPerceptionOpts = {
  client: OpenAI;
  model: string;
  obsBase64: string;
  /** Pixel center of the slot to inspect. */
  slotPos: { x: number; y: number };
  /** Optional slot label for prompt context (e.g. "hotbar_3"). */
  slotName?: string;
};

export type SlotPerceptionResult = { item: string };

const SYSTEM_PROMPT = `You are a Minecraft slot perception sub-agent.

You are shown a small ZOOMED-IN crop of one inventory slot from a Minecraft GUI. The slot's full bounding box is visible with a small outer margin (you can see the slot frame). Identify the item icon in the slot.

STRICT RULES:
- Return JSON: {"item": "<snake_case_identifier>"}.
- Use snake_case names: "Cobblestone" -> cobblestone, "Nether Quartz" -> nether_quartz, "Oak Planks" -> oak_planks, "Crafting Table" -> crafting_table, "Iron Pickaxe" -> iron_pickaxe.
- If the slot is visually EMPTY (no item icon, just the dark slot background): {"item": "empty"}.
- If the icon is too small / blurry / ambiguous to identify: {"item": "unknown"}.
- Do NOT add markdown fences, do NOT add commentary. Output ONLY the JSON object.`;

const ZOOM = 6; // upscale so the LLM sees a clear ~150 px crop
const SRC_W = 26; // slot bbox (~18 px) + small outer margin
const SRC_H = 26;

export async function perceiveSlot(opts: SlotPerceptionOpts): Promise<SlotPerceptionResult> {
  let cropB64 = opts.obsBase64;
  try {
    cropB64 = cropAndZoomSlot(opts.obsBase64, opts.slotPos.x, opts.slotPos.y);
  } catch (e) {
    console.warn(`[slot-perception] crop failed (${e instanceof Error ? e.message : String(e)}); falling back to full frame`);
  }
  const url = cropB64.startsWith("data:image/")
    ? cropB64
    : `data:image/png;base64,${cropB64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  const userText = `Identify the item in this Minecraft inventory slot${opts.slotName ? ` (${opts.slotName})` : ""}.`;
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
    console.warn(`[slot-perception] LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
    return { item: "unknown" };
  }
  const parsed: SlotPerceptionResult = (() => {
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
      const fname = `${seq}_perception.png`;
      const pngBytes = Buffer.from(cropB64, "base64");
      fs.writeFileSync(path.join(debugDir, fname), pngBytes);
      const line = JSON.stringify({
        seq: DEBUG_SEQ,
        ts: new Date().toISOString(),
        type: "perception",
        imageFile: fname,
        data: { slotPos: opts.slotPos, slotName: opts.slotName, raw, parsed },
      });
      fs.appendFileSync(path.join(debugDir, "events.jsonl"), line + "\n");
    } catch (e) {
      console.warn(`[slot-perception] debug write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parsed;
}

let DEBUG_SEQ = 100000;

function cropAndZoomSlot(obsBase64: string, slotX: number, slotY: number): string {
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
  const sx0 = Math.max(0, Math.min(w - SRC_W, Math.round(slotX) - Math.floor(SRC_W / 2)));
  const sy0 = Math.max(0, Math.min(h - SRC_H, Math.round(slotY) - Math.floor(SRC_H / 2)));
  const outW = SRC_W * ZOOM;
  const outH = SRC_H * ZOOM;
  const out = new PNG({ width: outW, height: outH });
  // Nearest-neighbor upscale + R/B swap (MC sim outputs BGR-encoded
  // JPEG; jpeg-js with formatAsRGBA returns the bytes in BGR order,
  // so we swap channels here once so the LLM sees true colors).
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
