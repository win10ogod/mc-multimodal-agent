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
  /** Items the planner knows are in inventory (item names only — no
   *  slot indices). Action does the slot resolution. */
  knownItems: string[];
  /** What the cursor is currently carrying, if anything. */
  cursorHolding: string | null;
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

const SYS = `You plan a checklist of symbolic subtasks for a Minecraft GUI subagent (any GUI: crafting, smelting, brewing, chest, anvil, etc.) and update progress after each Action report.

Subtask kinds (no numbers, no slot indices):
- verify_items_visible { items }
- place_in_craft_grid { item }
- take_result { expectedItem }
- wait_for_output { expectedItem }
- click_button { buttonName }
- verify_state { condition }

On the FIRST call: emit the shortest plan. For crafting, that's typically (skip verify if known_items already shows ingredients) → one place_in_craft_grid per ingredient unit → one take_result.

On post_action calls: VERIFY the Action's last report against the actual frame + known_items before ticking done. Action sometimes falsely reports success (CV mismatch, click landed on wrong slot, etc.) — never trust its OK at face value. Confirm visually that the expected effect occurred. If the report says success but the frame disagrees, leave the item undone and decide whether to retry or replace it. Preserve item ids and order. Keep activeIdx for one more attempt only if observation shows partial progress; otherwise advance / replace / mark done. Never return same activeIdx with attempts >= 3 unchanged.

Output strict JSON:
  { "all_done": bool, "next_idx": int (-1 if all_done), "checklist": [...] }
Each item: { id, text, task, done, attempts }. PRESERVE attempts.`;

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
    known_items: input.knownItems,
    cursor_holding: input.cursorHolding,
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
