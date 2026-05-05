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
- For crafting tasks (recipeInfo present): decompose into verify_slots (if Known is sparse) → one move_one per ingredient unit (using the recipe's craft cells as destSlotIndex) → one move_all (taking the result to a free regular slot) → final verify_state ("target item visible in regular inventory").
- For other GUIs: decompose appropriately based on the task text + frame.

On SUBSEQUENT calls (post_action):
- KEEP the existing checklist items (preserve ids and ordering).
- Update the .done field of each item by observing the frame and Known:
  * move_one is done when Known shows the destSlotIndex contains the sourceItem.
  * move_all is done when Known shows the destSlotIndex has the expected output OR is empty + dest now has the item.
  * wait_for_output is done when expectedItem appears anywhere.
  * verify_state is done when the condition holds.
- all_done is true only when EVERY item is done AND the task's success state is visible (e.g. recipe target in regular inventory).

CRITICAL — anti-loop rule:
The Action agent fires AT MOST ONCE per subtask. Every checklist item carries an "attempts" counter that reflects how many times Action has been dispatched for it. After Action runs, IBVS verifies and hands back to you.
- If attempts >= 1 on the item AND your observation supports completion → mark done=true.
- If attempts >= 1 AND observation does NOT support completion → DO NOT keep the same activeIdx; either:
   (a) replace this subtask with a different approach (e.g. swap to verify_slots covering a different slot range), or
   (b) skip it (mark done=true with the assumption it failed silently and let downstream subtasks recover), or
   (c) insert a new prerequisite subtask BEFORE this one and point next_idx to that prerequisite.
- NEVER return the same activeIdx with the same subtask + same attempts >= 1. That would loop the Action agent.

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
