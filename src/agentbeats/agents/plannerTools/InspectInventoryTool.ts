import { probeHotbar } from "../../tools/InventoryProbe";
import type { PlannerTool } from "./types";

export const inspectInventoryTool: PlannerTool = {
  name: "inspect_inventory",
  description:
    "Read the player's hotbar (slots 0-8) for the listed candidate items. " +
    "READ-ONLY: does not click. Inventory GUI must be open. " +
    "Returns one line per candidate: 'item = slot' or 'item = none'.",
  parameters: {
    type: "object",
    properties: {
      candidates: { type: "array", items: { type: "string" }, description: "Item ids to look for, e.g. ['crafting_table', 'iron_ingot', 'stick']." },
    },
    required: ["candidates"],
    additionalProperties: false,
  },
  async run(ctx, args) {
    const { candidates } = args as { candidates: string[] };
    const result = await probeHotbar({ client: ctx.client, model: ctx.model, obsBase64: ctx.obsBase64, candidates });
    const lines = candidates.map(item => {
      const slot = [...result.entries()].find(([, name]) => name === item)?.[0];
      return slot != null ? `${item} = slot ${slot}` : `${item} = none`;
    });
    return { ok: true, text: lines.join("\n") };
  },
};
