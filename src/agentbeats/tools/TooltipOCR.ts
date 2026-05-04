/**
 * Sub-agent that reads the Minecraft tooltip text from a frame captured
 * while the cursor was hovering over a specific slot. Uses the main VLM
 * (same model as the probe) with a tightly scoped prompt: input = one
 * tooltip-rendered frame, output = the item identifier string.
 *
 * Result is cached in SlotMemory keyed by absolute pixel position, so
 * the agent never has to re-hover the same slot.
 */
import type OpenAI from "openai";

export type TooltipOCROpts = {
  client: OpenAI;
  /** Main VLM model name (same as the probe). Accuracy matters more than cost. */
  model: string;
  obsBase64: string;
  /** Approximate pixel position of the slot the cursor was hovering, used
   *  only as context in the prompt to anchor the model's attention. */
  slotPos: { x: number; y: number };
};

const SYSTEM_PROMPT = `You are a Minecraft tooltip OCR sub-agent.

The image shows a Minecraft inventory window. The cursor was just hovered over ONE slot, so a tooltip box is rendered near the cursor showing the item name (and metadata).

Your only job: read the item NAME line of the tooltip and return it as a snake_case identifier (e.g. "cobblestone", "nether_quartz", "oak_planks", "iron_pickaxe").

Rules:
- Return ONLY the item identifier, nothing else. No quotes, no JSON, no commentary.
- If you see "Nether Quartz" return "nether_quartz". If "Oak Planks" return "oak_planks".
- If the slot is empty (no tooltip rendered), return exactly: empty
- If you cannot read the tooltip clearly, return exactly: unknown
`;

export async function readTooltip(opts: TooltipOCROpts): Promise<string> {
  const cleaned = opts.obsBase64.startsWith("data:image/")
    ? opts.obsBase64
    : `data:image/jpeg;base64,${opts.obsBase64.replace(/^data:image\/[a-z]+;base64,/, "")}`;
  const userText = `Cursor was hovering near pixel (${Math.round(opts.slotPos.x)}, ${Math.round(opts.slotPos.y)}). Read the tooltip and return the item identifier.`;
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
          { type: "image_url", image_url: { url: cleaned, detail: "low" } },
        ],
      },
    ],
  };
  try {
    const resp = await opts.client.chat.completions.create(body as never);
    const raw = (resp as unknown as { choices?: Array<{ message?: { content?: string } }> })
      .choices?.[0]?.message?.content ?? "";
    const cleaned2 = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!cleaned2) return "unknown";
    return cleaned2;
  } catch (e) {
    console.warn(`[tooltip-ocr] failed: ${e instanceof Error ? e.message : String(e)}`);
    return "unknown";
  }
}
