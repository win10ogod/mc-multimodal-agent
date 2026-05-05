import type OpenAI from "openai";
import type { Subtask } from "./types";
import type { CraftAction } from "../../../tools/InventoryProbe";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type ActionDeps = {
  client: OpenAI;
  model: string;
};

export type ActionInput = {
  /** ONE symbolic subtask the Planner just dispatched. Action
   *  resolves it to concrete slot indices using the live layout. */
  subtask: Subtask;
  /** OCR-confirmed slot contents at this moment (slot index + item name). */
  knownSlots: Array<{ index: number; name?: string; item: string }>;
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

const SYS = `You execute ONE symbolic subtask in a Minecraft GUI. You receive the subtask plus layout_slots (slot index + role), known_slots (OCR'd contents), recipe (if any), cursor_holding, and the frame with YELLOW NUMBERED BADGES on every slot.

Subtask → action mapping:
- verify_items_visible { items }: emit verify_slots ONLY for slots you are visually CONFIDENT contain one of the listed items. Do not include uncertain or off-target slots — empty/random slots fire wasted OCR. If you cannot identify any candidate confidently, emit fallback_manual.
- place_in_craft_grid { item }: pick a craft cell (role starts "craft_2x2_" or "craft_3x3_") that matches this item's recipe position; resolve item's source slot from known_slots; emit move from=source to=craftCell count="one".
- take_result { expectedItem }: from = slot with role==="result"; to = free slot in known_slots; emit move count="all".
- wait_for_output { expectedItem }: emit wait with holdSteps proportional to expected sim ticks (cap 60).
- click_button: emit fallback_manual (not supported).
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

export async function runAction(deps: ActionDeps, input: ActionInput): Promise<CraftAction> {
  const userPayload = {
    subtask: input.subtask,
    known_slots: input.knownSlots,
    layout_slots: input.layoutSlots,
    recipe: input.recipeInfo
      ? {
          target: input.recipeInfo.target,
          ingredients: input.recipeInfo.ingredients,
          inShape: input.recipeInfo.inShape,
        }
      : null,
    cursor_holding: input.cursorHolding,
  };
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
  return parsed as CraftAction;
}
