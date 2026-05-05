import type OpenAI from "openai";
import type { ChecklistItem, PlanResult } from "./types";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type PlannerDeps = {
  client: OpenAI;
  model: string;
};

export type PlannerInput = {
  taskText: string;
  /** Present when this is a crafting task with a known recipe; null
   *  for non-craft GUIs (smelting, chest, etc) where the planner
   *  decomposes from task text + frame alone. */
  recipeInfo: RecipeInfo | null;
  /** OCR-confirmed slot contents at this moment. */
  knownSlots: Array<{ index: number; name?: string; item: string }>;
  /** GUI slot-index → role mapping for the currently open window. The
   *  Planner uses this to set destSlotIndex correctly (e.g. slot 2 =
   *  craft_2x2_0, slot 0 = armor_helmet). Without this the Planner
   *  hallucinates dest indices. */
  layoutSlots: Array<{ index: number; name?: string; role?: string }>;
  /** Empty on first invocation; otherwise the in-flight list. */
  currentChecklist: ChecklistItem[];
  /** "first" / "post_action" — drives prompt phrasing. */
  trigger: "first" | "post_action";
  /** Recent closed-loop history lines for context. */
  recentHistory: string[];
  /** Frame for visual observation. */
  obsBase64: string;
};

const SCHEMA = {
  type: "object",
  required: ["all_done", "next_idx", "checklist"],
  additionalProperties: false,
  properties: {
    all_done: { type: "boolean" },
    next_idx: { type: "integer" },
    checklist: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text", "task", "done", "attempts"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          done: { type: "boolean" },
          attempts: { type: "integer" },
          task: { type: "object", additionalProperties: true },
        },
      },
    },
  },
} as const;

const SYS = `You are the Planner inside a Minecraft GUI control subagent. The subagent operates ANY GUI window — crafting (2x2 or 3x3), smelting, brewing, chest, anvil, enchanting, villager trade. You decompose the current task into an ordered checklist of generic Subtask primitives, then update which steps are done after each observation.

Subtask kinds (GUI-agnostic primitives):
- verify_slots: { slots: int[] } — OCR-confirm specific slot indices when Known is too sparse to identify ingredients.
- move_one: { sourceItem, destSlotIndex } — move ONE unit of sourceItem to a specific slot. Used to place ingredients/inputs.
- move_all: { sourceSlotIndex, destSlotIndex } — move FULL stack from source to dest. Used to take outputs/results, bulk transfers.
- wait_for_output: { expectedItem } — wait until an item appears (smelting/brewing async outputs).
- click_button: { buttonName } — click a labelled UI button (anvil, enchant, trade selection).
- verify_state: { condition } — confirm-only step (no action), tick done when condition is observed.

On the FIRST call (currentChecklist is empty):
- For crafting tasks (recipeInfo present): decompose into a SHORT list. Use layout_slots to find slot indices by role:
    * craft cells: role starts with "craft_2x2_" or "craft_3x3_" — these are valid placement destinations.
    * result slot: role === "result" — the source for taking outputs.
    * hotbar/main_inv: role starts with "hotbar_" or "main_inv_" — valid sources/destinations for stored items.
    * armor/offhand: role like "armor_helmet"/"armor_chestplate"/"armor_boots"/"offhand" — NEVER use these as destSlotIndex.
  Decomposition: skip verify_slots if Known already covers the ingredient items → one move_one per ingredient unit (destSlotIndex = a craft cell) → one move_all (sourceSlotIndex = result slot, destSlotIndex = a free hotbar/main_inv slot) → final verify_state ("target item visible in regular inventory").
- For other GUIs: decompose appropriately based on task text + frame + layout_slots.

DO NOT include verify_slots when knownSlots already contains the recipe's ingredient items in hotbar slots — that is wasteful perception. Only emit verify_slots when truly uncertain.

On SUBSEQUENT calls (post_action):
- KEEP the existing checklist items (preserve ids and ordering).
- Update the .done field of each item by observing the frame and Known:
  * move_one is done when Known shows the destSlotIndex contains the sourceItem.
  * move_all is done when Known shows the destSlotIndex has the expected output OR is empty + dest now has the item.
  * wait_for_output is done when expectedItem appears anywhere.
  * verify_state is done when the condition holds.
- all_done is true only when EVERY item is done AND the task's success state is visible (e.g. recipe target in regular inventory).

CRITICAL — Planner owns retry decisions:
The Action agent fires once per dispatch. After it runs, IBVS verifies the click outcome (matched / mismatched) and hands control back to you with the result reflected in recent_history (e.g. "place_one slot=2 OK", "pickup slot=46 FAILED post.stddev=..."). YOU then read the current frame + Known + recent_history and decide:
  (a) success → tick done=true on the item.
  (b) IBVS mismatched but observation suggests partial progress → keep same activeIdx for ONE retry. The runtime will re-dispatch Action.
  (c) clearly not making progress → replace the subtask with a different approach OR insert a prerequisite OR mark done=true and rely on downstream recovery.
HARD CAP: if checklist item's attempts >= 3, you MUST take path (a) or (c). Returning the same activeIdx with attempts >= 3 unchanged is forbidden — it would deadlock the loop.
Action NEVER decides whether to retry. Only YOU do.

Output strict JSON:
  { "all_done": bool, "next_idx": int (-1 if all_done; otherwise index of first still-undone item), "checklist": [...] }
Each checklist item: { id, text, task, done, attempts }. PRESERVE attempts as the runtime sets it; do not reset to 0 unless you are inserting a fresh subtask.`;

export async function runPlanner(deps: PlannerDeps, input: PlannerInput): Promise<PlanResult> {
  const userPayload = {
    task: input.taskText,
    recipe: input.recipeInfo
      ? {
          target: input.recipeInfo.target,
          ingredients: input.recipeInfo.ingredients,
          inShape: input.recipeInfo.inShape,
        }
      : null,
    known_slots: input.knownSlots,
    layout_slots: input.layoutSlots,
    current_checklist: input.currentChecklist,
    trigger: input.trigger,
    recent_history: input.recentHistory,
  };
  const dataUrl = input.obsBase64.startsWith("data:image/")
    ? input.obsBase64
    : `data:image/jpeg;base64,${input.obsBase64}`;

  const body: Record<string, unknown> = {
    model: deps.model,
    temperature: 0,
    max_completion_tokens: 800,
    messages: [
      { role: "system", content: SYS },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify(userPayload) },
          { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "fastui_planner_out", schema: SCHEMA, strict: false },
    },
  };
  type Create = typeof deps.client.chat.completions.create;
  type CreateParams = Parameters<Create>[0];
  const resp = await deps.client.chat.completions.create(body as unknown as CreateParams) as Awaited<ReturnType<Create>> & {
    choices: Array<{ message?: { content?: string | null } }>;
  };
  const text = resp.choices[0]?.message?.content ?? "";
  let parsed: { all_done: boolean; next_idx: number; checklist: ChecklistItem[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn(`[fastui-planner] failed to parse JSON: ${text.slice(0, 200)}`);
    return { kind: "continue", checklist: input.currentChecklist, nextIdx: input.currentChecklist.findIndex((c) => !c.done) };
  }
  console.log(`[fastui-planner] trigger=${input.trigger} all_done=${parsed.all_done} next_idx=${parsed.next_idx} checklist=[${parsed.checklist.map((c) => `${c.done ? "x" : " "}${c.id}`).join(",")}]`);
  if (parsed.all_done) return { kind: "all_done", checklist: parsed.checklist };
  return { kind: "continue", checklist: parsed.checklist, nextIdx: parsed.next_idx };
}
