/**
 * Hotbar held-item-name banner OCR.
 *
 * When the player presses a hotbar slot key in Minecraft, MC renders
 * the held item's display name as a translucent dark banner with white
 * text just above the hotbar bar for ~40 ticks. The banner text is
 * unambiguous (e.g. "Crafting Table" vs "Cobblestone") and a much
 * more reliable signal than the 18×18 hotbar icon.
 *
 * This module owns the crop region and a target-aware binary OCR call:
 * given a frame and a target item, the model returns {match, observed}.
 * The HotbarVerifier loops over candidate slots calling this helper
 * until match=true or it has swept all 9 slots.
 *
 * R/B-swap + 3× zoom mirror SlotOcr.ts, since the MC sim outputs JPEGs
 * whose jpeg-js decode comes out BGR.
 */
import type OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";

export type HotbarBannerMatchOpts = {
  client: OpenAI;
  model: string;
  obsBase64: string;
  target: string;
  candidateLabel?: string;
};

export type HotbarBannerMatchResult = {
  match: boolean;
  observed: string;
};

const SYSTEM_PROMPT = `You are a Minecraft hotbar banner OCR sub-agent.

You are shown a CROPPED REGION just above the Minecraft hotbar. When the player switches hotbar slots, MC renders the held item's display name as a translucent dark banner with white text in this region for ~2 seconds. Your job: decide whether the banner currently shows a target item.

INPUT: a target item name in snake_case (e.g. "crafting_table").

OUTPUT JSON: {"match": true|false, "observed": "<text you read, or empty string>"}.

STRICT RULES:
- match=true ONLY if a banner is clearly visible AND its text snake_case-normalizes to the target. ("Crafting Table" -> crafting_table, "Oak Planks" -> oak_planks, "Nether Quartz" -> nether_quartz, "Bone Meal" -> bone_meal.)
- If a banner is visible but it shows a DIFFERENT item: match=false, observed=<that item's name in snake_case>.
- If NO banner is visible (it has faded out, or no slot switch occurred): match=false, observed="".
- If the banner is visible but unreadable: match=false, observed="unknown".
- NEVER guess from the hotbar icons. Only read the banner text.

Output ONLY the JSON object. No markdown fences. No commentary.`;

const ZOOM = 3;
const SRC_W = 280;
const SRC_H = 32;
// Banner appears centered horizontally at the screen middle, ~22 px above
// the hotbar centerline. For a 640×360 obs frame the hotbar centerline is
// at y≈336, so the banner sits around y≈304–326. We crop a wide horizontal
// band so the full item-name string fits regardless of length. May need
// tuning against real eval frames; see plan Task 8 step 4.
const BANNER_Y_CENTER = 314;

export async function hotbarBannerMatch(opts: HotbarBannerMatchOpts): Promise<HotbarBannerMatchResult> {
  let cropB64 = opts.obsBase64;
  try {
    cropB64 = cropBannerRegion(opts.obsBase64);
  } catch (e) {
    console.warn(`[hotbar-ocr] crop failed (${e instanceof Error ? e.message : String(e)}); falling back to full frame`);
  }
  const url = cropB64.startsWith("data:image/")
    ? cropB64
    : `data:image/png;base64,${cropB64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  const userText = `Target item: ${opts.target}. Candidate hotbar slot: ${opts.candidateLabel ?? "unknown"}. Read the banner above the hotbar and decide if it shows the target.`;
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
    console.warn(`[hotbar-ocr] LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
    return { match: false, observed: "unknown" };
  }
  const parsed: HotbarBannerMatchResult = (() => {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      const matchRaw = obj.match;
      const observedRaw = obj.observed;
      const match = matchRaw === true;
      const observed = typeof observedRaw === "string"
        ? observedRaw.trim().toLowerCase().replace(/[^a-z0-9_]/g, "")
        : "";
      return { match, observed };
    } catch {
      return { match: false, observed: "" };
    }
  })();
  const debugDir = process.env.AGENTBEATS_DEBUG_DIR;
  if (debugDir) {
    try {
      const seq = String(++DEBUG_SEQ).padStart(5, "0");
      const fname = `${seq}_hotbar_ocr.png`;
      fs.writeFileSync(path.join(debugDir, fname), Buffer.from(cropB64, "base64"));
      const line = JSON.stringify({
        seq: DEBUG_SEQ,
        ts: new Date().toISOString(),
        type: "hotbar_ocr",
        imageFile: fname,
        data: { target: opts.target, candidateLabel: opts.candidateLabel ?? null, raw, parsed },
      });
      fs.appendFileSync(path.join(debugDir, "events.jsonl"), line + "\n");
    } catch (e) {
      console.warn(`[hotbar-ocr] debug write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parsed;
}

let DEBUG_SEQ = 210000;

function cropBannerRegion(obsBase64: string): string {
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
  const sx0 = Math.max(0, Math.min(w - SRC_W, Math.round(w / 2 - SRC_W / 2)));
  const sy0 = Math.max(0, Math.min(h - SRC_H, BANNER_Y_CENTER - Math.floor(SRC_H / 2)));
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
