import type OpenAI from "openai";
import type { Subtask } from "./types";
import type { CraftAction } from "../../../tools/InventoryProbe";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type ActionDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown) => Promise<void> | void;
};

export type ActionInput = {
  /** ONE symbolic subtask the Planner just dispatched. Action
   *  resolves it to concrete slot indices using the live layout. */
  subtask: Subtask;
  /** OCR-confirmed slot contents at this moment (slot index + item name). */
  knownSlots: Array<{ index: number; name?: string; item: string }>;
  /** CV-detected occupied slot indices. Slots that visually contain
   *  SOMETHING (chroma+luminance fill test) regardless of whether the
   *  item is identified. Subtract knownSlots indices to get
   *  "occupied but unknown" — these are the slots verify_slots should
   *  target when looking for an unidentified ingredient. */
  occupiedSlotIndices: number[];
  /** GUI slot-index → role mapping for the open window. Action uses
   *  this to find craft cells by role, identify the result slot,
   *  pick free hotbar/main_inv slots, and reject non-task-relevant
   *  slots as destinations. */
  layoutSlots: Array<{ index: number; name?: string; role?: string }>;
  /** Active recipe (when in a crafting subtask). Provides target +
   *  ingredients + inShape so Action can pick the right craft cell. */
  recipeInfo: RecipeInfo | null;
  /** Item the cursor currently holds, if any. */
  cursorHolding: string | null;
  obsBase64: string;
};

const SCHEMA = {
  type: "object",
  required: ["action"],
  additionalProperties: true,
  properties: {
    action: { type: "string", enum: ["move", "put", "verify_slots", "wait", "done", "fallback_manual"] },
  },
} as const;

const SYS = `You execute ONE symbolic subtask in a Minecraft GUI. You receive the subtask, slot_state (slots CV detected as having content, named or "unknown item"), slots_by_role (which slot indices belong to each role: craft_2x2, craft_3x3, result, hotbar, main_inv, armor, offhand), recipe (if any), cursor_holding, and the frame with YELLOW NUMBERED BADGES on every slot. Slots NOT in slot_state are LIKELY empty but may also be unverified content the CV missed (low-contrast grey blocks like cobblestone often go undetected).

Subtask → action mapping:
- verify_items_visible { items }: prefer "unknown item" entries in slot_state. If a needed item isn't in slot_state at all, scan up to 3 unlisted hotbar/main_inv slots that VISUALLY look like the item — do NOT assume an inventory lacks the item just because slot_state doesn't name it. If you cannot pick a confident candidate even visually, emit fallback_manual.
- place_in_craft_grid { item }: (1) pick a craft cell (role starts "craft_2x2_" or "craft_3x3_") matching this item's recipe position. (2) Find the source slot in slot_state where the named item is recorded. If the item is only present as "unknown item" entries, emit verify_slots on up to 3 of those. If it's not in slot_state at all but the recipe says you should have it, emit verify_slots on up to 3 unlisted hotbar slots that visually match. Once slot_state names the item, emit move from=source to=craftCell count="one".
- take_result { expectedItem }: from = slot with role==="result"; to = free slot in known_slots; emit move count="all".
- wait_for_output { expectedItem }: emit wait with holdSteps proportional to expected sim ticks (cap 60).
- verify_state { condition }: if condition holds in frame+known, emit done; else fallback_manual.

Rules:
- Slot index = the YELLOW BADGE you read off the frame, validated against layout_slots.role for the expected role.
- Never overwrite a different item in dest.
- If anything is ambiguous, emit fallback_manual with reason.

Output strict JSON, one action only:
  { "action": "move", "from": A, "to": B, "count": "one"|"all" }
  { "action": "verify_slots", "slots": [N,...] }
  { "action": "wait", "holdSteps": N }
  { "action": "done" }
  { "action": "fallback_manual", "reason": "..." }`;

let ACTION_CALL_SEQ = 0;

export async function runAction(deps: ActionDeps, input: ActionInput): Promise<CraftAction> {
  // Compact context. Listing all 48 layout slots wastes tokens and
  // distracts the model — Action mainly needs role→indices to find
  // craft cells / result, and slot_state for occupancy.
  const knownByIdx = new Map(input.knownSlots.map((s) => [s.index, s.item]));
  const allOccupied = new Set<number>([
    ...input.knownSlots.map((s) => s.index),
    ...input.occupiedSlotIndices,
  ]);
  const slotState = [...allOccupied]
    .sort((a, b) => a - b)
    .map((i) => ({ index: i, item: knownByIdx.get(i) ?? "unknown item" }));
  const slotsByRole: Record<string, number[]> = {};
  for (const s of input.layoutSlots) {
    const role = s.role ?? "other";
    (slotsByRole[role] ??= []).push(s.index);
  }
  const userPayload = {
    subtask: input.subtask,
    slot_state: slotState,
    slots_by_role: slotsByRole,
    recipe: input.recipeInfo
      ? {
          target: input.recipeInfo.target,
          ingredients: input.recipeInfo.ingredients,
          inShape: input.recipeInfo.inShape,
        }
      : null,
    cursor_holding: input.cursorHolding,
  };

  const seq = String(++ACTION_CALL_SEQ).padStart(5, "0");
  const debugDir = process.env.AGENTBEATS_DEBUG_DIR;
  if (debugDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require("node:path") as typeof import("node:path");
      const promptText = `[fastui-action ${seq}]\nSYSTEM:\n${SYS}\n\nUSER (JSON):\n${JSON.stringify(userPayload, null, 2)}\n`;
      fs.writeFileSync(pathMod.join(debugDir, `fastui_action_${seq}_prompt.txt`), promptText);
      if (input.obsBase64) {
        const m = input.obsBase64.match(/^data:image\/([a-z]+);base64,(.+)$/);
        const ext = m ? m[1] : "jpg";
        const raw = m ? m[2] : input.obsBase64;
        fs.writeFileSync(pathMod.join(debugDir, `fastui_action_${seq}_input.${ext}`), Buffer.from(raw, "base64"));
      }
    } catch (e) {
      console.warn(`[fastui-action ${seq}] debug dump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const dataUrl = input.obsBase64.startsWith("data:image/")
    ? input.obsBase64
    : `data:image/jpeg;base64,${input.obsBase64}`;
  const body: Record<string, unknown> = {
    model: deps.model,
    temperature: 0,
    max_completion_tokens: 200,
    messages: [
      { role: "system", content: SYS },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify(userPayload) },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "fastui_action_out", schema: SCHEMA, strict: false },
    },
  };
  type Create = typeof deps.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const resp = await deps.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };
  const text = resp.choices[0]?.message?.content ?? "";
  let parsed: any;
  try { parsed = JSON.parse(text); } catch {
    console.warn(`[fastui-action] failed to parse JSON: ${text.slice(0, 200)}`);
    return { action: "fallback_manual", reason: "action LLM returned unparseable JSON" } as CraftAction;
  }
  console.log(`[fastui-action] subtask=${input.subtask.kind} -> ${parsed.action}${parsed.from!==undefined?` from=${parsed.from}`:""}${parsed.to!==undefined?` to=${parsed.to}`:""}`);
  try {
    await deps.recordDebug?.("fastui_action_call", {
      seq, subtask: input.subtask, output: parsed,
    });
  } catch { /* swallow */ }
  return parsed as CraftAction;
}
