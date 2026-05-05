import type OpenAI from "openai";
import type { ChecklistItem, PlanResult } from "./types";
import type { RecipeInfo } from "../../../tools/UiFastControl";

export type PlannerDeps = {
  client: OpenAI;
  model: string;
  recordDebug?: (kind: string, payload: unknown) => Promise<void> | void;
};

export type PlannerInput = {
  taskText: string;
  /** Present when this is a crafting task with a known recipe; null
   *  for non-craft GUIs (smelting, chest, etc) where the planner
   *  decomposes from task text + frame alone. */
  recipeInfo: RecipeInfo | null;
  /** OCR-confirmed slot contents. Same shape Action sees — both share
   *  the perception so a slot index in either prompt unambiguously
   *  refers to the same SoM badge in the live frame. */
  knownSlots: Array<{ index: number; name?: string; item: string }>;
  /** CV-detected occupied slot indices (chroma+luminance fill test).
   *  Subtract knownSlots indices to get "occupied but unknown content"
   *  — those are candidates for verify_items_visible if a recipe
   *  ingredient hasn't been identified yet. */
  occupiedSlotIndices: number[];
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
          task: {
            type: "object",
            required: ["kind"],
            additionalProperties: true,
            properties: {
              kind: {
                type: "string",
                enum: [
                  "verify_items_visible",
                  "place_in_craft_grid",
                  "take_result",
                  "wait_for_output",
                  "verify_state",
                ],
              },
              items: { type: "array", items: { type: "string" } },
              item: { type: "string" },
              expectedItem: { type: "string" },
              condition: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

// Static role/contract for the Planner LLM. Per-call data (known_slots,
// cursor_holding, recipe, history, etc.) is rendered into the USER message
// — this prompt is identical across calls so it stays cache-friendly.
const SYS = `You plan a checklist of symbolic subtasks for a Minecraft GUI subagent (any GUI: crafting, smelting, brewing, chest, anvil, etc.) and update progress after each Action report.

Subtask kinds (no numbers, no slot indices):
- verify_items_visible { items }
- place_in_craft_grid { item }
- take_result { expectedItem }
- wait_for_output { expectedItem }
- verify_state { condition }

The "Slot state" block lists every slot that visibly has SOMETHING in it. Each line is either "id N -> <item>" (OCR-confirmed) or "id N -> unknown item" (CV-detected but unidentified). Any slot index NOT listed is empty.

On the FIRST call for a crafting task: emit one place_in_craft_grid per ingredient unit (one slot is one item) → take_result { expectedItem }. Use verify_items_visible first only if the recipe ingredients aren't already named in slot_state.

On post_action calls: VERIFY the Action's last report against the actual frame + tracked status before ticking done. Action sometimes falsely reports success — never trust its OK at face value. Confirm visually that the expected effect occurred. If the report says success but the frame disagrees, leave the item undone. Preserve item ids and order. Keep activeIdx for one more attempt only if observation shows partial progress; otherwise advance / replace / mark done. Never return same activeIdx with attempts >= 3 unchanged.

Output strict JSON:
  { "all_done": bool, "next_idx": int (-1 if all_done), "checklist": [...] }
Each item: { id, text, task, done, attempts }. PRESERVE attempts.`;

function buildUserText(input: PlannerInput, userPayload: Record<string, unknown>): string {
  // Unified slot-state listing: every slot with SOMETHING in it is
  // listed once, either by OCR-confirmed item name or as "unknown
  // item". Slots not listed are empty (CV-confirmed). This avoids
  // ambiguity over "did the agent forget about it" vs "it's empty".
  const knownByIdx = new Map(input.knownSlots.map((s) => [s.index, s.item]));
  const allOccupied = new Set<number>([
    ...input.knownSlots.map((s) => s.index),
    ...input.occupiedSlotIndices,
  ]);
  const lines = [...allOccupied]
    .sort((a, b) => a - b)
    .map((i) => `  ${i} -> ${knownByIdx.get(i) ?? "unknown item"}`);
  const slotBlock = lines.length > 0 ? lines.join("\n") : "  (all slots empty)";
  const cursorBlock = input.cursorHolding ?? "(empty)";
  return `Slot state (any id not listed is empty):
${slotBlock}
Cursor: ${cursorBlock}

${JSON.stringify(userPayload)}`;
}

let PLANNER_CALL_SEQ = 0;

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
    occupied_slot_indices: input.occupiedSlotIndices,
    cursor_holding: input.cursorHolding,
    current_checklist: input.currentChecklist,
    trigger: input.trigger,
    recent_history: input.recentHistory,
  };

  const userText = buildUserText(input, userPayload);
  const seq = String(++PLANNER_CALL_SEQ).padStart(5, "0");
  const debugDir = process.env.AGENTBEATS_DEBUG_DIR;
  if (debugDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require("node:path") as typeof import("node:path");
      const promptText = `[fastui-planner ${seq}]\nSYSTEM:\n${SYS}\n\nUSER:\n${userText}\n`;
      fs.writeFileSync(pathMod.join(debugDir, `fastui_planner_${seq}_prompt.txt`), promptText);
      if (input.obsBase64) {
        const m = input.obsBase64.match(/^data:image\/([a-z]+);base64,(.+)$/);
        const ext = m ? m[1] : "jpg";
        const raw = m ? m[2] : input.obsBase64;
        fs.writeFileSync(pathMod.join(debugDir, `fastui_planner_${seq}_input.${ext}`), Buffer.from(raw, "base64"));
      }
    } catch (e) {
      console.warn(`[fastui-planner ${seq}] debug dump failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
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
          { type: "text", text: userText },
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
  console.log(`[fastui-planner] trigger=${input.trigger} all_done=${parsed.all_done} next_idx=${parsed.next_idx} checklist=[${parsed.checklist.map((c) => `${c.done ? "x" : " "}${c.id} task.kind=${(c.task as any)?.kind ?? "MISSING"}`).join(", ")}]`);
  try {
    await deps.recordDebug?.("fastui_planner_call", {
      seq, trigger: input.trigger,
      input: userPayload,
      output: { all_done: parsed.all_done, next_idx: parsed.next_idx, checklist: parsed.checklist },
    });
  } catch { /* swallow */ }
  if (parsed.all_done) return { kind: "all_done", checklist: parsed.checklist };
  return { kind: "continue", checklist: parsed.checklist, nextIdx: parsed.next_idx };
}
