import type { PlannerTool } from "./types";
import { detectGuiLayout } from "../../tools/SlotDetector";
import { vlmVerifySlotState } from "../../tools/InventoryProbe";

export const verifySlotsTool: PlannerTool = {
  name: "verify_slots",
  description:
    "For each (slot, expected) pair, confirm whether that slot is currently empty or filled. " +
    "READ-ONLY. Use to verify a sub-agent's claimed result before mark_checklist_item(done). " +
    "Returns one line per pair.",
  parameters: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slot: { type: "integer" },
            expect: { type: "string", enum: ["empty", "filled"] },
            target: { type: "string", description: "What item the sub-agent claims to have placed/removed (for VLM context)." },
          },
          required: ["slot", "expect", "target"],
          additionalProperties: false,
        },
        maxItems: 4,
      },
    },
    required: ["checks"],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const { checks } = args as { checks: Array<{ slot: number; expect: "empty" | "filled"; target: string }> };
    const layout = detectGuiLayout(ctx.obsBase64, undefined);
    if (!layout) return { ok: false, error: "no GUI open; cannot resolve slot pixel locations" };
    const out: string[] = [];
    for (const c of checks.slice(0, 4)) {
      const slotInfo = layout.slots.find(s => s.index === c.slot);
      if (!slotInfo) { out.push(`slot ${c.slot}: not found in current layout`); continue; }
      const result = await vlmVerifySlotState({
        client: ctx.client, model: ctx.model, obsBase64: ctx.obsBase64,
        slot: { cx: slotInfo.cx, cy: slotInfo.cy, name: slotInfo.name },
        expectAfter: c.expect === "empty" ? "should_empty" : "should_fill",
        taskTarget: c.target,
      });
      out.push(`slot ${c.slot}: ${result === true ? "matches" : result === false ? "mismatch" : "unknown"}`);
    }
    return { ok: true, text: out.join("\n") };
  },
};
